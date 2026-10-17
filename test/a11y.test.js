const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { open, raceSnapshots } = require('./helpers/dashboard');

// Accessibility: glanced at from a cockpit, read by a screen reader, driven
// by keyboard. WCAG AA: text contrast of at least 4.5:1.

function luminance(hex) {
  const [r, g, b] = hex.match(/[0-9a-f]{2}/gi).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const tokens = (css) => Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2]]));

for (const [file, text, backgrounds] of [
  ['public/style.css', ['text', 'muted', 'label', 'good', 'watch', 'act', 'info', 'pb'], ['bg', 'panel', 'panel-2']],
  ['site/index.html', ['text', 'muted', 'dim', 'go', 'info', 'watch', 'act'], ['bg', 'panel']],
]) {
  test(`contrast (${file}): every text colour on every background is at least 4.5:1`, () => {
    const t = tokens(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
    const low = [];
    for (const fg of text) for (const bg of backgrounds) {
      assert.ok(t[fg] && t[bg], `--${fg} / --${bg} defined`);
      const c = contrast(t[fg], t[bg]);
      if (c < 4.5) low.push(`--${fg} on --${bg}: ${c.toFixed(2)}:1`);
    }
    assert.deepStrictEqual(low, []);
  });
}

// What a screen reader would call an element.
function accessibleName(el) {
  const doc = el.ownerDocument;
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
  if (el.getAttribute('aria-labelledby')) return el.getAttribute('aria-labelledby').split(/\s+/).map((id) => (doc.getElementById(id) || {}).textContent || '').join(' ').trim();
  if (el.id && doc.querySelector(`label[for="${el.id}"]`)) return doc.querySelector(`label[for="${el.id}"]`).textContent.trim();
  if (el.closest('label')) return el.closest('label').textContent.trim();
  return (el.textContent || el.getAttribute('title') || '').trim();
}

test('every control on every screen has a name a screen reader can say', (t) => {
  const app = open(t);
  app.connect();
  const snap = raceSnapshots()[300];
  const unnamed = new Set();
  for (const key of ['1', '2', '3', '4', '5', '6']) {
    app.press(key);
    app.send(snap);
    for (const el of app.window.document.querySelectorAll('button, select, input, textarea, [role="button"], [role="tab"]')) {
      if (!accessibleName(el)) unnamed.add(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${el.className}`);
    }
  }
  assert.deepStrictEqual([...unnamed], []);
});

test('the screen tabs say which one is selected', (t) => {
  const app = open(t);
  app.connect();
  app.send(raceSnapshots()[300]);
  app.press('3');
  const tabs = [...app.window.document.querySelectorAll('[role="tab"]')];
  const selected = tabs.filter((b) => b.getAttribute('aria-selected') === 'true');
  assert.strictEqual(selected.length, 1);
  assert.match(selected[0].textContent, /Strategy/);
});

test('a new call (PUSH -> BOX) is announced, not only drawn', (t) => {
  const app = open(t);
  app.connect();
  const calls = raceSnapshots().filter((s) => s.strategy && s.strategy.call);
  const box = calls.find((s) => s.strategy.call.action === 'BOX');
  assert.ok(box, 'the race has a BOX call');
  app.send(calls[0]);
  app.send(box);
  const live = [...app.window.document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')].filter((el) => !el.hidden);
  assert.ok(live.some((el) => el.textContent.includes('BOX')), `live regions: ${live.map((el) => `${el.id || el.className}: "${el.textContent.trim().slice(0, 40)}"`).join(' | ')}`);
});
