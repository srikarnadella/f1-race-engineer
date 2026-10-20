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
