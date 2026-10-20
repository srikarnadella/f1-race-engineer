const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');

// The dashboard shell (public/app.js) in jsdom, connected to a fake bridge:
// the page as a driver uses it - the link, the screens, the keys, auto-switch.

test('app: connects to the bridge it was served from, and says what the link is doing', (t) => {
  const app = open(t);
  assert.strictEqual(app.bridge().url, 'ws://192.168.1.5:8080');
  assert.strictEqual(app.$('link-text').textContent, 'Bridge offline');
  app.connect();
  assert.strictEqual(app.$('link-text').textContent, 'No telemetry');
  app.send(raceSnapshots()[200]);
  assert.strictEqual(app.$('link-text').textContent, 'Live');
  app.send({ ...raceSnapshots()[201], source: 'demo' });
  assert.strictEqual(app.$('link-text').textContent, 'Demo replay', 'a replay never passes as live');
  assert.deepStrictEqual(app.errors, []);
});

test('app: a dropped connection is retried', async (t) => {
  const app = open(t);
  app.connect();
  app.bridge().close();
  assert.strictEqual(app.$('link-text').textContent, 'Bridge offline');
  await new Promise((r) => setTimeout(r, 600)); // first retry after 500 ms
  assert.strictEqual(app.sockets.length, 2);
});

test('app: keys 1-6 switch screens, and the choice is remembered', (t) => {
  const app = open(t);
  app.connect();
  app.send(raceSnapshots()[200]);
  assert.strictEqual(app.activeTab(), 'Drive');
  const seen = [];
  for (const key of ['2', '3', '4', '5', '6']) {
    app.press(key);
    seen.push(app.activeTab());
  }
  assert.deepStrictEqual(seen, ['Battle', 'Strategy', 'Weather', 'Custom', 'Debrief']);
  assert.strictEqual(JSON.parse(app.window.localStorage.getItem('raceEngineer.screen')), 'debrief');
  // Every card on every screen rendered without an error.
  assert.deepStrictEqual(app.errors, []);
});

test('app: the recorded demo opens on Drive, whatever screen an earlier visit left on', async (t) => {
  const app = open(t, { url: 'http://192.168.1.5:8080/?recorded', storage: { 'raceEngineer.screen': 'debrief' } });
  assert.strictEqual(app.activeTab(), 'Drive');
  await new Promise((r) => setTimeout(r, 20)); // let its demo-data fetch settle before the page closes
  // The live app still reopens where the driver left it.
  const live = open(t, { storage: { 'raceEngineer.screen': 'debrief' } });
  assert.strictEqual(live.activeTab(), 'Debrief');
});

test('app: a saved screen from an older version still opens somewhere sensible', (t) => {
  const app = open(t, { storage: { 'raceEngineer.screen': 'pit' } });
  assert.strictEqual(app.activeTab(), 'Strategy');
  const gone = open(t, { storage: { 'raceEngineer.screen': 'no-such-screen' } });
  assert.strictEqual(gone.activeTab(), 'Drive');
});

test('app: auto-switch follows the race, then a manual pick wins for a while', (t) => {
  const app = open(t, { storage: { 'raceEngineer.auto': true } });
  app.connect();
  const snap = raceSnapshots()[200];
  app.send({ ...snap, focus: { screen: 'battle', reason: 'SAINZ 0.6s behind' } });
  assert.strictEqual(app.activeTab(), 'Battle');
  app.send({ ...snap, focus: { screen: 'drive', reason: null } });
  assert.strictEqual(app.activeTab(), 'Drive', 'back home once it settles');
  app.press('3'); // the driver picks Strategy
  app.send({ ...snap, focus: { screen: 'battle', reason: 'SAINZ 0.6s behind' } });
  assert.strictEqual(app.activeTab(), 'Strategy', 'a manual pick is not overridden at once');
  assert.match(app.$('auto-chip-text').textContent, /^Paused \d+s/);
});

test('app: the whole synthetic race plays through every screen without an error', (t) => {
  const app = open(t);
  app.connect();
  const all = raceSnapshots();
  for (const key of ['1', '2', '3', '4', '5', '6']) {
    app.press(key);
    for (let i = 0; i < all.length; i += 7) app.send(all[i]);
  }
  assert.deepStrictEqual(app.errors, []);
});

test('app: a lossy feed is flagged on the link; a healthy one says nothing extra', (t) => {
  const app = open(t);
  app.connect();
  const snap = raceSnapshots()[200];
  app.send({ ...snap, feed: { rateHz: 52, lossPct: 0.5 } });
  assert.strictEqual(app.$('link-text').textContent, 'Live');
  assert.ok(!app.$('link').classList.contains('is-lossy'));
  app.send({ ...snap, feed: { rateHz: 18.4, lossPct: 8 } });
  assert.strictEqual(app.$('link-text').textContent, 'Live · 8% lost');
  assert.ok(app.$('link').classList.contains('is-lossy'));
  assert.match(app.$('link').title, /8% of telemetry packets lost/);
  app.send({ ...snap, feed: { rateHz: null, lossPct: null } });
  assert.strictEqual(app.$('link-text').textContent, 'Live', 'no reading is not a warning');
});

test('app: the Models tab shows the overtake model the app runs - LightGBM, its held-out score and what it leans on', async (t) => {
  const { overtakeInfo } = require('../src/ml/modelInfo');
  const info = overtakeInfo();
  const app = open(t);
  app.window.fetch = async (url) => ({ ok: true, json: async () => (String(url).endsWith('/api/models') ? { overtake: info, tyre: null } : {}) });
  app.press('6');
  assert.strictEqual(app.activeTab(), 'Debrief');
  app.window.document.querySelector('[data-view="models"]').click();
  await new Promise((r) => setTimeout(r, 20));
  const text = app.window.document.querySelector('.w-mdl__card').textContent;
  assert.ok(text.includes(`Gradient-boosted trees (LightGBM, ${info.trees} trees)`), text);
  assert.match(text, new RegExp(info.evaluation.model.auc.toFixed(3)));
  assert.match(text, /Beats the gap-only baseline/);
  // The biggest driver first, as a share of what the model learned.
  assert.ok(text.includes(`Gap to the car ahead (log)${Math.round(info.importance[0].share * 100)}%`), text);
  assert.deepStrictEqual(app.errors, []);
});

test('app: Ask answers from the latest snapshot, and switching the voice on reads no backlog', async (t) => {
  const { ask } = require('../public/ask');
  const said = [];
  const before = (w) => {
    w.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    w.speechSynthesis = { speaking: false, paused: false, speak(u) { said.push(u.text); setTimeout(() => u.onend && u.onend(), 0); }, cancel() {}, pause() {}, resume() {}, getVoices: () => [] };
  };
  const app = open(t, { before });
  app.connect();
  const snaps = raceSnapshots().filter((s) => s.player && (s.insights || []).length);
  const first = snaps[0];
  app.send(first);
  // Ask: the gap behind, as ask.js reads it from what the dashboard last received.
  app.$('ask').click();
  [...app.$('ask-qs').children].find((b) => b.textContent === 'Gap behind?').click();
  assert.strictEqual(app.$('ask-reply').textContent, ask('behind', first).reply);
  app.$('ask-close').click();
  await new Promise((r) => setTimeout(r, 20));
  said.length = 0;
  // Voice on (key calls): the radio check, not the cards already on screen.
  app.$('voice').click();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(said, ['Radio check. Key calls only.']);
  // A new advisory call after that is said.
  app.send({ ...first, insights: [...first.insights, { id: 'test-new', severity: 'advisory', category: 'strategy', message: 'Rain within 2 laps', createdAtMs: 1, textAtMs: 1 }] });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(said.length, 2, JSON.stringify(said));
  assert.match(said[1], /Rain within 2 laps/);
  assert.deepStrictEqual(app.errors, []);
});
