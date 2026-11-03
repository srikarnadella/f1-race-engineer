const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');

// The desktop app's Home (public/desktop.js): a landing page that fills the
// window, with one way into each part of the app. window.undercut is the
// app's bridge (desktop/preload.js); here a fake that answers like an idle PC.
function fakeApi() {
  const status = { version: '0.1.0', mode: 'live', replay: null, recording: null, settings: { httpPort: 8080, udpPort: 20777, share: false, phoneVoice: false }, pairUrl: null, addresses: [], clients: 1, dataDir: 'C:/data', analyzing: [] };
  const ok = async () => status;
  return { status: ok, setSettings: ok, record: ok, stopRecording: ok, replay: ok, live: ok, captures: async () => [], analyze: ok, deleteCapture: ok, deleteSession: ok, showCapture: ok, openReport: ok, openDataFolder: ok, openInBrowser: ok, speech: { start: ok, stop: ok }, on: () => () => {} };
}
const settle = () => new Promise((r) => setTimeout(r, 10));
// Intervals the page starts, so a test can fire one by hand instead of waiting for it.
function recordIntervals(w, intervals) {
  const set = w.setInterval.bind(w);
  const clear = w.clearInterval.bind(w);
  w.setInterval = (fn, ms, ...a) => { const id = set(fn, ms, ...a); intervals.push({ id, fn, ms, cleared: false }); return id; };
  w.clearInterval = (id) => { const i = intervals.find((x) => x.id === id); if (i) i.cleared = true; clear(id); };
}
async function openApp(t) {
  const intervals = [];
  const app = open(t, { before: (w) => { w.undercut = fakeApi(); recordIntervals(w, intervals); } });
  await settle();
  const doc = app.window.document;
  const rail = doc.querySelector('.rail');
  const dests = () => [...doc.querySelectorAll('.home__dest')];
  const dest = (name) => dests().find((b) => b.querySelector('.home__name').textContent === name);
  return { ...app, doc, rail, dests, dest, intervals };
}

test('home: the app opens on Home, filling the window with no rail, one way into each part', async (t) => {
  const app = await openApp(t);
  assert.strictEqual(app.rail.hidden, true, 'no dashboard rail around Home');
  assert.deepStrictEqual(app.dests().map((b) => b.querySelector('.home__name').textContent),
    ['Live dashboard', 'Race analysis', 'Ask the race', 'Storage', 'Connect and record']);
  assert.deepStrictEqual(app.errors, []);
});

test('home: each destination opens its screen, the rail comes back, and Home is one tap away', async (t) => {
  const app = await openApp(t);
  for (const [name, tab] of [['Live dashboard', 'Drive'], ['Race analysis', 'Debrief'], ['Storage', 'Storage'], ['Connect and record', 'Connect']]) {
    app.dest(name).click();
    assert.strictEqual(app.activeTab(), tab, name);
    assert.strictEqual(app.rail.hidden, false, `the rail is back on ${tab}`);
    [...app.doc.querySelectorAll('.tab')].find((b) => b.textContent === 'Home').click();
    assert.strictEqual(app.activeTab(), 'Home');
    assert.strictEqual(app.rail.hidden, true);
  }
  assert.deepStrictEqual(app.errors, []);
});

test('home: Settings opens from Home; Ask the race waits until it is built', async (t) => {
  const app = await openApp(t);
  [...app.doc.querySelectorAll('.home button')].find((b) => b.textContent === 'Settings').click();
  assert.strictEqual(app.$('settings-sheet').hidden, false);
  assert.strictEqual(app.dest('Ask the race').disabled, true);
});

test('home: one short line of state per destination; the live race shows position, lap and the call', async (t) => {
  const app = await openApp(t);
  app.connect();
  const snap = raceSnapshots().find((s) => s.connected && s.player && s.player.position && s.strategy && s.strategy.call);
  app.send(snap);
  const live = app.dest('Live dashboard').querySelector('.home__state').textContent;
  assert.match(live, new RegExp(`P${snap.player.position}`));
  assert.match(live, new RegExp(`lap ${snap.player.currentLapNum}`));
  assert.match(live, new RegExp(snap.strategy.call.action));
  for (const b of app.dests()) {
    const state = b.querySelector('.home__state').textContent;
    assert.ok(state.length > 0 && state.length <= 48, `${b.querySelector('.home__name').textContent}: "${state}" is one short line`);
  }
  assert.deepStrictEqual(app.errors, []);
});

test('home: a phone or browser on the Wi-Fi gets the dashboard, no Home', (t) => {
  const app = open(t);
  assert.strictEqual(app.window.document.querySelector('.home'), null);
  assert.strictEqual(app.window.document.querySelector('.rail').hidden, false);
});

test('home: the rail carries the race screens; Connect and Storage live on Home and join the rail only while open', async (t) => {
  const app = await openApp(t);
  const tabs = () => [...app.doc.querySelectorAll('.tab')].map((b) => b.textContent.replace(/^\d/, ''));
  app.dest('Live dashboard').click();
  assert.deepStrictEqual(tabs(), ['Home', 'Drive', 'Battle', 'Strategy', 'Weather', 'Custom', 'Debrief']);
  [...app.doc.querySelectorAll('.tab')].find((b) => b.textContent === 'Home').click();
  app.dest('Storage').click();
  assert.deepStrictEqual(tabs(), ['Home', 'Drive', 'Battle', 'Strategy', 'Weather', 'Custom', 'Debrief', 'Storage']);
  app.press('7'); // the number keys still reach both
  assert.strictEqual(app.activeTab(), 'Connect');
});

test('home: the background is a slideshow of real races, each credited while it shows, and it stops when you leave', async (t) => {
  const app = await openApp(t);
  const slides = [...app.doc.querySelectorAll('.home__photo')];
  assert.strictEqual(slides.length, 3);
  for (const img of slides) assert.ok(img.getAttribute('alt').length > 20, 'each photograph says what it shows');
  const shown = () => slides.findIndex((img) => img.classList.contains('is-on'));
  const credit = () => app.doc.querySelector('.home__credit').textContent;
  assert.strictEqual(shown(), 0);
  const first = credit();
  assert.match(first, /CC BY/);

  const timer = app.intervals.find((i) => i.ms === 8000);
  assert.ok(timer, 'a new photograph every 8 s');
  timer.fn();
  assert.strictEqual(shown(), 1);
  assert.notStrictEqual(credit(), first, 'the credit follows the photograph on screen');
  timer.fn();
  timer.fn();
  assert.strictEqual(shown(), 0, 'and wraps around');

  // Minimized or behind the game: nothing changes.
  Object.defineProperty(app.doc, 'hidden', { configurable: true, get: () => true });
  timer.fn();
  assert.strictEqual(shown(), 0);
  Object.defineProperty(app.doc, 'hidden', { configurable: true, get: () => false });

  // Leaving Home stops the slideshow for good.
  app.dest('Live dashboard').click();
  timer.fn();
  assert.strictEqual(timer.cleared, true);
  assert.deepStrictEqual(app.errors, []);
});
