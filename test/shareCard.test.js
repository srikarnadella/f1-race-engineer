const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const vm = require('vm');
const { widgetScripts } = require('./helpers/widgetScripts');

// Roadmap: the share-this-race image. One PNG for posting: the result, the best lap, the stints, the graded calls.
// share.js builds what the card says (shareModel), draws it on a canvas context (drawShareCard) and saves it
// (savePng). Here the context is a recorder, since jsdom has no canvas.
function load() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const ctx = dom.getInternalVMContext();
  for (const s of widgetScripts()) s.runInContext(ctx);
  const file = path.join(__dirname, '..', 'public', 'share.js');
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInContext(ctx);
  return { window: dom.window, share: dom.window.RaceShare };
}

const session = {
  id: 'abc', track: 'Spa-Francorchamps', sessionName: 'Race', isRace: true, startedAt: Date.UTC(2026, 9, 20, 18, 1),
  finish: 5, grid: 8, positionsGained: 3, points: 10, bestLap: { ms: 106452, lap: 9 }, medianPaceMs: 107800, cleanLaps: 11, consistencyMs: 420,
  pitStops: 1, fieldBestMs: 105900, theoreticalBestMs: 106100,
  stints: [{ compound: 17, fromLap: 1, toLap: 7, laps: 7 }, { compound: 18, fromLap: 8, toLap: 15, laps: 8 }],
  penalties: [], laps: new Array(15).fill({}),
};
const audit = { calls: [{ verdict: 'right' }, { verdict: 'right' }, { verdict: 'unclear' }, { verdict: 'rule' }, { verdict: 'wrong' }] };

const px = (font) => parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)[1]);
// A recording stand-in for CanvasRenderingContext2D; 8 px a character at 16 px, so a long line really overflows.
function recorder() {
  const ops = [];
  const ctx = {
    font: '16px Archivo', fillStyle: '#000', textAlign: 'left', textBaseline: 'alphabetic',
    fillRect: (x, y, w, h) => ops.push({ op: 'rect', x, y, w, h, color: ctx.fillStyle }),
    fillText: (text, x, y) => ops.push({ op: 'text', text, x, y, font: ctx.font, align: ctx.textAlign, color: ctx.fillStyle }),
    measureText: (text) => ({ width: String(text).length * (px(ctx.font) * 0.5) }),
    save() {}, restore() {}, beginPath() {}, roundRect() {}, fill() {},
  };
  return { ctx, ops };
}
const PALETTE = { bg: '#0a0a0a', panel: '#121212', text: '#f4f4f4', muted: '#c8c8c8', good: '#3ef08a', soft: '#ff3b3b', medium: '#ffd32b', hard: '#f2f2f2' };

test('share: the model says the result, the best lap, the stints and the calls in plain words', () => {
  const { share } = load();
  const m = share.shareModel(session, audit);
  assert.strictEqual(m.title, 'Spa-Francorchamps · Race');
  assert.match(m.date, /2026/);
  assert.strictEqual(m.result.big, 'P5');
  assert.strictEqual(m.result.sub, 'from P8 · +3 · 10 pts');
  const stat = (label) => (m.stats.find((s) => s.label === label) || {}).value;
  assert.strictEqual(stat('Best lap'), '1:46.452');
  assert.strictEqual(stat('Race pace'), '1:47.800');
  assert.strictEqual(stat('Stops'), '1');
  assert.deepStrictEqual(m.stints.map((s) => [s.name, s.laps]), [['Medium', 7], ['Hard', 8]]);
  assert.strictEqual(m.calls, '5 calls: 2 right, 1 wrong, 2 not judged');
  assert.ok(!/undefined|NaN|null/.test(JSON.stringify(m)));
});

test('share: a session without a result, a lap time, stints or graded calls still makes a card with no blanks', () => {
  const { share } = load();
  const m = share.shareModel({ id: 'x', track: 'Monza', sessionName: 'Practice', isRace: false, startedAt: 0, finish: null, bestLap: null, stints: [], penalties: [], laps: [] }, null);
  assert.strictEqual(m.title, 'Monza · Practice');
  assert.strictEqual(m.result.big, '–');
  assert.strictEqual(m.calls, null);
  assert.deepStrictEqual(m.stints, []);
  assert.ok(!/undefined|NaN|null/.test(JSON.stringify({ ...m, calls: undefined })));
});

test('share: the card draws the title, result, stats and stint strip, with the stints in proportion', () => {
  const { share } = load();
  const { ctx, ops } = recorder();
  share.drawShareCard(ctx, share.shareModel(session, audit), PALETTE);
  const texts = ops.filter((o) => o.op === 'text').map((o) => o.text);
  for (const want of ['Spa-Francorchamps · Race', 'P5', 'from P8 · +3 · 10 pts', '1:46.452', 'Medium', 'Hard']) assert.ok(texts.includes(want), `${want} in ${JSON.stringify(texts)}`);
  assert.ok(texts.some((t) => /5 calls: 2 right, 1 wrong, 2 not judged/.test(t)));
  assert.ok(texts.some((t) => /Undercut/.test(t)), 'signed with the app\'s name');
  const strips = ops.filter((o) => o.op === 'rect' && [PALETTE.medium, PALETTE.hard].includes(o.color) && o.h <= 40);
  assert.strictEqual(strips.length, 2);
  assert.ok(Math.abs(strips[0].w / strips[1].w - 7 / 8) < 0.05, 'widths follow laps (7 and 8)');
  assert.deepStrictEqual(strips.map((s) => s.color), [PALETTE.medium, PALETTE.hard], 'in race order, in the tyre colors');
});

test('share: no line runs off the card, however long a name is, and nothing personal or local is drawn', () => {
  const { share } = load();
  const { ctx, ops } = recorder();
  const long = { ...session, track: 'A very long circuit name that goes on and on and on and on across the card', penalties: [{ what: 'a very long penalty text that also goes on' }] };
  share.drawShareCard(ctx, share.shareModel(long, audit), PALETTE);
  const W = share.CARD.width;
  for (const o of ops.filter((x) => x.op === 'text')) {
    const width = o.text.length * (px(o.font) * 0.5);
    const left = o.align === 'right' ? o.x - width : o.align === 'center' ? o.x - width / 2 : o.x;
    assert.ok(left >= 0 && left + width <= W, `"${o.text}" spans ${left}..${left + width} of ${W}`);
  }
  const all = ops.filter((o) => o.op === 'text').map((o) => o.text).join(' ');
  assert.doesNotMatch(all, /\d+\.\d+\.\d+\.\d+|[A-Za-z]:\|@/);
});

test('share: the card is a 1200 x 630 social image, and saving gives a clean file name', () => {
  const { window, share } = load();
  assert.deepStrictEqual([share.CARD.width, share.CARD.height], [1200, 630]);
  assert.strictEqual(share.fileName(session), 'undercut-spa-francorchamps-race-2026-10-20.png');
  assert.strictEqual(share.fileName({ track: null, sessionName: null, startedAt: Date.UTC(2026, 0, 2, 12) }), 'undercut-race-2026-01-02.png');
  const saved = [];
  const canvas = { toBlob: (cb) => cb({ size: 3, type: 'image/png' }) };
  window.URL.createObjectURL = () => 'blob:x';
  window.URL.revokeObjectURL = () => {};
  const click = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () { saved.push(this.download); };
  return share.savePng(canvas, 'a.png').then(() => {
    window.HTMLAnchorElement.prototype.click = click;
    assert.deepStrictEqual(saved, ['a.png']);
  });
});
