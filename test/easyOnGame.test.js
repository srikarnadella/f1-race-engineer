const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');
const { DEFAULTS, applySettings } = require('../desktop/settings');
const { setPriorities } = require('../desktop/priority');

// "Easy on the game" (roadmap W8). Undercut runs beside F1 26 on the same PC, so it asks Windows to run all
// its processes below normal priority (the game's threads win any contest for a core), and the window beside
// the game redraws 4 times a second instead of 10: the numbers look the same, the drawing costs 60% less.
// The voice, the calls and the auto-switch still see every snapshot.

test('easy on the game: a setting, on unless you turn it off, and only a true or false is taken', () => {
  assert.strictEqual(DEFAULTS.easyOnGame, true);
  assert.strictEqual(applySettings(DEFAULTS, { easyOnGame: false }).easyOnGame, false);
  for (const bad of [{ easyOnGame: 'no' }, { easyOnGame: 0 }, { easyOnGame: null }]) assert.strictEqual(applySettings(DEFAULTS, bad).easyOnGame, true, JSON.stringify(bad));
});

test('priority: every process is put below normal when easy, back to normal when not, and one that has gone is not an error', () => {
  const set = [];
  const gone = (pid) => { if (pid === 3) throw new Error('No such process'); };
  const run = (easy) => {
    set.length = 0;
    const n = setPriorities([1, 2, 3, 4], easy, (pid, level) => { gone(pid); set.push([pid, level]); });
    return n;
  };
  assert.strictEqual(run(true), 3);
  assert.deepStrictEqual(set, [[1, 10], [2, 10], [4, 10]]);
  assert.strictEqual(run(false), 3);
  assert.deepStrictEqual(set, [[1, 0], [2, 0], [4, 0]]);
});

// --- The window draws at most every drawMinMs, and the voice and the calls don't wait for it ---
function snapshotWith(i, patch) {
  const s = JSON.parse(JSON.stringify(raceSnapshots()[i]));
  return { ...s, session: { ...(s.session || {}), ...patch }, debrief: undefined };
}

test('redraw cap: with a cap the screen is redrawn no more often than it, and the latest snapshot is what it shows', (t) => {
  const app = open(t);
  app.connect();
  let now = 1_000_000;
  app.window.Date.now = () => now;
  app.window.RaceTuning = { drawMinMs: 250 };
  app.send(snapshotWith(40, { safetyCarStatus: 0 }));
  assert.strictEqual(app.$('flag').hidden, true);
  now += 100;
  app.send(snapshotWith(41, { safetyCarStatus: 1 }));
  assert.strictEqual(app.$('flag').hidden, true, '100 ms later: not drawn yet');
  now += 100;
  app.send(snapshotWith(42, { safetyCarStatus: 1 }));
  assert.strictEqual(app.$('flag').hidden, true, '200 ms later: still not');
  now += 100;
  app.send(snapshotWith(43, { safetyCarStatus: 1 }));
  assert.strictEqual(app.$('flag').hidden, false, '300 ms later: drawn, from the latest snapshot');
  assert.strictEqual(app.$('flag').textContent, 'SAFETY CAR');
  assert.deepStrictEqual(app.errors, []);
});

test('redraw cap: no cap (a phone, a browser) draws every snapshot, as before', (t) => {
  const app = open(t);
  app.connect();
  let now = 2_000_000;
  app.window.Date.now = () => now;
  app.send(snapshotWith(40, { safetyCarStatus: 0 }));
  now += 100;
  app.send(snapshotWith(41, { safetyCarStatus: 1 }));
  assert.strictEqual(app.$('flag').hidden, false);
});

test('redraw cap: a new call is announced the moment it arrives, drawn or not', (t) => {
  const app = open(t);
  app.connect();
  let now = 3_000_000;
  app.window.Date.now = () => now;
  app.window.RaceTuning = { drawMinMs: 250 };
  const call = (action, reason) => ({ ...snapshotWith(40, {}), strategy: { ...(raceSnapshots()[40].strategy || {}), call: { action, kind: 'ok', reason } } });
  app.send(call('PUSH', 'Tyres and fuel OK'));
  assert.strictEqual(app.$('call-announcer').textContent, 'PUSH: Tyres and fuel OK');
  now += 50; // inside the 250 ms: nothing is drawn, but the call must not wait for the screen
  app.send(call('BOX', 'Box this lap'));
  assert.strictEqual(app.$('call-announcer').textContent, 'BOX: Box this lap');
  assert.deepStrictEqual(app.errors, []);
});

// --- The switch in Settings ---
function fakeApp(easyOnGame) {
  let settings = { httpPort: 8080, udpPort: 20777, share: false, phoneVoice: false, easyOnGame };
  const calls = [];
  const status = () => ({ version: '0.1.0', mode: 'live', replay: null, recording: null, settings, pairUrl: null, addresses: [], clients: 1, dataDir: 'C:/data', analyzing: [] });
  const ok = async () => status();
  const api = {
    status: async () => status(), setSettings: async (patch) => { calls.push(patch); settings = { ...settings, ...patch }; return status(); },
    record: ok, stopRecording: ok, replay: ok, live: ok, captures: async () => [], analyze: ok, deleteCapture: ok, deleteSession: ok, showCapture: ok, openReport: ok,
    openDataFolder: ok, openInBrowser: ok, speech: { start: ok, stop: ok }, llm: {}, on: () => () => {},
  };
  return { api, calls };
}

test('settings: an "Easy on the game" switch, on by default, that sets the redraw cap and takes effect at once', async (t) => {
  const fake = fakeApp(true);
  const app = open(t, { before: (w) => { w.undercut = fake.api; } });
  await new Promise((r) => setTimeout(r, 20));
  const box = app.window.document.getElementById('set-easy');
  assert.ok(box, 'the switch is in Settings');
  assert.strictEqual(box.checked, true);
  assert.strictEqual(app.window.RaceTuning.drawMinMs, 250);
  box.checked = false;
  box.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(JSON.stringify(fake.calls), JSON.stringify([{ easyOnGame: false }])); // the page's objects are another window's
  assert.strictEqual(app.window.RaceTuning.drawMinMs, 0, 'every snapshot is drawn again');
  assert.match(app.window.document.querySelector('.pc-easy').textContent, /F1 26 comes first/);
});

test('settings: a browser or phone (no app) has no switch and draws everything', (t) => {
  const app = open(t);
  assert.strictEqual(app.window.document.getElementById('set-easy'), null);
  assert.strictEqual(app.window.RaceTuning, undefined);
});
