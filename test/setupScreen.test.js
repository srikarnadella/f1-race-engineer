const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');

// The Setup screen: your car's setup on top, the sheet's for the track below, green where it is right and red where it
// needs changing. It comes up by itself in the garage or the pit lane in practice and qualifying.
const base = () => raceSnapshots().find((s) => s.player && s.analysis);
const row = (key, label, current, target, ok, change = 0) => ({ key, label, current, target, ok, change });
const rows = (over = {}) => [
  row('frontWing', 'Front wing', 45, '42', false, -3), row('rearWing', 'Rear wing', 15, '15', true), row('diffOn', 'Diff on throttle', 100, '100', true),
  row('diffOff', 'Diff off throttle', 60, '60', true), row('frontSuspension', 'Front suspension', 41, '41', true), row('rearSuspension', 'Rear suspension', 38, '38', true),
  row('frontAntiRollBar', 'Front anti-roll bar', 1, '1', true), row('rearAntiRollBar', 'Rear anti-roll bar', 5, '5', true), row('frontHeight', 'Front ride height', 21, '21', true),
  row('rearHeight', 'Rear ride height', 47, '47', true), row('brakePressure', 'Brake pressure', 100, '98', false, -2), row('brakeBias', 'Brake bias', 56, '56-57', true),
  row('tyreFront', 'Front tyre pressure', 29.5, '29.5', true), row('tyreRear', 'Rear tyre pressure', 20.5, '20.5', true),
].map((r) => ({ ...r, ...(over[r.key] || {}) }));
const setup = (over = {}) => ({ available: true, track: 'Melbourne', circuit: 'Australia', kind: 'r', editable: true, inGarage: false, rows: rows(), off: 2, notes: 'lico hell', source: 'F1 26', ...over });
const snap = (su, extra = {}) => ({ ...base(), connected: true, setup: su, ...extra });
const text = (app, sel) => (app.window.document.querySelector(sel) || {}).textContent || '';
const go = (app, label) => [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === label).click();
// The Setup tab is only listed in the garage: get there, open it, then send the snapshot under test.
const showSetup = (app, su) => { app.send(snap(setup({ inGarage: true }))); go(app, 'Setup'); app.send(snap({ ...su, inGarage: true })); };
const cells = (app, which) => [...app.window.document.querySelectorAll(`[data-ref="${which}"] .w-su__cell`)];

test('setup screen: your values on top, the sheet\'s below, green where right and red where off, with which way to go', (t) => {
  const app = open(t, { storage: { 'raceEngineer.setupAuto': false } }); // no auto-show: the tab is opened by hand
  app.connect();
  showSetup(app, setup());
  assert.strictEqual(text(app, '.w-su__head b'), 'Australia · Race setup');
  assert.strictEqual(text(app, '.w-su__head span'), '2 to change');
  assert.ok(app.window.document.querySelector('.w-su__head span').classList.contains('is-act'));
  const now = cells(app, 'now');
  const want = cells(app, 'want');
  assert.strictEqual(now.length, 14);
  assert.strictEqual(want.length, 14);
  assert.strictEqual(now[0].querySelector('b').textContent, '45');
  assert.ok(now[0].classList.contains('is-off'));
  assert.ok(now[1].classList.contains('is-ok'));
  assert.strictEqual(want[0].querySelector('b').textContent, '42 (−3)', 'the value to set and which way');
  assert.strictEqual(want[10].querySelector('b').textContent, '98 (−2)');
  assert.strictEqual(want[1].querySelector('b').textContent, '15', 'a right value is just the value');
  assert.strictEqual(now.filter((c) => c.classList.contains('is-off')).length, 2);
  assert.strictEqual(now[12].querySelector('b').textContent, '29.5');
  assert.match(text(app, '.w-su__note'), /Sheet note: lico hell/);
  assert.deepStrictEqual(app.errors, []);
});

test('setup screen: a car that matches the sheet says so; a race says the car cannot be changed', (t) => {
  const app = open(t, { storage: { 'raceEngineer.setupAuto': false } }); // no auto-show: the tab is opened by hand
  app.connect();
  showSetup(app, setup({ rows: rows({ frontWing: { current: 42, ok: true, change: 0 }, brakePressure: { current: 98, ok: true, change: 0 } }), off: 0, kind: 'q', editable: false }));
  assert.strictEqual(text(app, '.w-su__head span'), 'Matches the sheet');
  assert.ok(app.window.document.querySelector('.w-su__head span').classList.contains('is-good'));
  assert.strictEqual(text(app, '.w-su__head b'), 'Australia · Qualifying setup');
  assert.match(text(app, '.w-su__note'), /can't be changed in a race/);
});

test('setup screen: with no sheet imported it says how to import one, and for a track the sheet lacks it says that', (t) => {
  const app = open(t, { storage: { 'raceEngineer.setupAuto': false } }); // no auto-show: the tab is opened by hand
  app.connect();
  showSetup(app, { available: false, track: 'Barcelona', circuit: null, kind: 'r', editable: true, inGarage: false, rows: [], off: 0, notes: null, source: null });
  assert.match(text(app, '.w-su__msg'), /Import setups/);
  assert.ok(app.window.document.querySelector('[data-ref="blockNow"]').hidden);
  app.send(snap({ available: false, track: 'Barcelona', circuit: null, kind: 'r', editable: true, inGarage: false, rows: [], off: 0, notes: null, source: 'F1 26' }));
  assert.match(text(app, '.w-su__msg'), /no setup for Barcelona/);
  assert.deepStrictEqual(app.errors, []);
});

test('setup screen: it comes up by itself in the garage, and the screen you were on comes back when you leave', (t) => {
  const app = open(t);
  app.connect();
  app.send(snap(setup({ inGarage: false })));
  go(app, 'Strategy');
  assert.strictEqual(app.activeTab(), 'Strategy');
  app.send(snap(setup({ inGarage: true })));
  assert.strictEqual(app.activeTab(), 'Setup');
  app.send(snap(setup({ inGarage: true })));
  assert.strictEqual(app.activeTab(), 'Setup', 'it stays while you are there');
  app.send(snap(setup({ inGarage: false })));
  assert.strictEqual(app.activeTab(), 'Strategy', 'back where you were');
  assert.deepStrictEqual(app.errors, []);
});

test('setup screen: a screen you pick yourself in the garage is left alone, and it only comes up again on the next visit', (t) => {
  const app = open(t);
  app.connect();
  app.send(snap(setup()));
  app.send(snap(setup({ inGarage: true })));
  assert.strictEqual(app.activeTab(), 'Setup');
  go(app, 'Battle');
  app.send(snap(setup({ inGarage: true })));
  assert.strictEqual(app.activeTab(), 'Battle');
  app.send(snap(setup({ inGarage: false })));
  assert.strictEqual(app.activeTab(), 'Battle', 'you were not on Setup when you left');
  app.send(snap(setup({ inGarage: true })));
  assert.strictEqual(app.activeTab(), 'Setup', 'the next visit');
});

test('setup screen: never in a race, never without a sheet for the track, and not when switched off in Settings', (t) => {
  const app = open(t);
  app.connect();
  app.send(snap(setup({ editable: false, inGarage: true })));
  assert.notStrictEqual(app.activeTab(), 'Setup', 'a race');
  app.send(snap(setup({ available: false, rows: [], off: 0, source: null, inGarage: true })));
  assert.notStrictEqual(app.activeTab(), 'Setup', 'no sheet');

  const off = open(t, { storage: { 'raceEngineer.setupAuto': false } });
  off.connect();
  off.send(snap(setup()));
  off.send(snap(setup({ inGarage: true })));
  assert.notStrictEqual(off.activeTab(), 'Setup', 'switched off');
  go(off, 'Setup');
  assert.strictEqual(off.activeTab(), 'Setup', 'but the tab is still there to open');
});

test('setup screen: the Settings switch is on by default and remembered', (t) => {
  const app = open(t);
  app.$('settings').click();
  assert.strictEqual(app.$('set-setup-auto').checked, true);
  app.$('set-setup-auto').checked = false;
  app.$('set-setup-auto').dispatchEvent(new app.window.Event('change'));
  assert.strictEqual(JSON.parse(app.window.localStorage.getItem('raceEngineer.setupAuto')), false);
});

test('setup screen: it does not pull you out of editing a Custom screen or out of Home', (t) => {
  const app = open(t);
  app.connect();
  app.send(snap(setup()));
  go(app, 'Battle');
  app.$('customize').click(); // editing
  app.send(snap(setup({ inGarage: true })));
  assert.strictEqual(app.activeTab(), 'Custom', 'still editing');
  assert.deepStrictEqual(app.errors, []);
});

const history = (over = {}) => ({ lapMs: 83456, session: 'One-shot qualifying', compound: 16, off: 1, rows: rows().map((r) => ({ key: r.key, label: r.label, value: r.current, current: r.current, ok: true, change: 0 })).map((r, i) => (i === 0 ? { ...r, value: 48, ok: false, change: 3 } : r)), ...over });

test('setup screen: your fastest setup here sits below, red where the car differs (with the change back to it) and green where it is the same', (t) => {
  const app = open(t, { storage: { 'raceEngineer.setupAuto': false } }); // no auto-show: the tab is opened by hand
  app.connect();
  showSetup(app, setup({ history: history() }));
  const best = cells(app, 'best');
  assert.strictEqual(best.length, 14);
  assert.match(text(app, '[data-ref="bestLabel"]'), /Your fastest here · 1:23\.456 · Soft · One-shot qualifying/);
  assert.strictEqual(best[0].querySelector('b').textContent, '48 (+3)');
  assert.ok(best[0].classList.contains('is-off'));
  assert.ok(best[1].classList.contains('is-ok'));
  assert.strictEqual(best[1].querySelector('b').textContent, '15');
  assert.deepStrictEqual(app.errors, []);
});

test('setup screen: no history, no block; history without a sheet still shows, and brings the screen up in the garage', (t) => {
  const app = open(t, { storage: { 'raceEngineer.setupAuto': false } }); // no auto-show: the tab is opened by hand
  app.connect();
  showSetup(app, setup());
  assert.ok(app.window.document.querySelector('[data-ref="blockBest"]').hidden);
  const noSheet = { available: false, track: 'Spa', circuit: null, kind: 'q', editable: true, inGarage: false, rows: [], off: 0, notes: null, source: null, history: history() };
  app.send(snap(noSheet));
  assert.ok(!app.window.document.querySelector('[data-ref="blockBest"]').hidden);
  assert.ok(app.window.document.querySelector('[data-ref="msg"]').hidden, 'no nagging to import a sheet when there is history to show');
  // With the switch on, a garage visit with only a history to show (no sheet) still brings the screen up.
  const auto = open(t);
  auto.connect();
  auto.send(snap(noSheet));
  auto.send(snap({ ...noSheet, inGarage: true }));
  assert.strictEqual(auto.activeTab(), 'Setup');
});

// ---- naming the setup on the car, from the garage (the desktop app only: it needs the app to save) ----
const mine = (over = {}) => ({ key: 'abcdefabcdef', trackId: 10, values: { frontWing: 45 }, name: '', favorite: false, ...over });
const withApp = (t, calls, extra = {}) => {
  const status = { version: '0.1.0', mode: 'live', replay: null, recording: null, settings: { httpPort: 8080, udpPort: 20777, share: false, phoneVoice: false }, pairUrl: null, addresses: [], clients: 1, dataDir: 'C:/data', analyzing: [], setups: null, backfill: null };
  const ok = async () => status;
  const saveSetupNote = async (i) => { calls.push(JSON.parse(JSON.stringify(i))); if (extra.fail) throw new Error('setup note: a name is at most 60 characters'); return true; };
  const app = open(t, { storage: { 'raceEngineer.setupAuto': false }, before: (w) => {
    w.undercut = { status: ok, setSettings: ok, record: ok, stopRecording: ok, replay: ok, live: ok, captures: async () => [], analyze: ok, deleteCapture: ok, deleteSession: ok, showCapture: ok, openReport: ok, openDataFolder: ok, openInBrowser: ok, speech: { start: ok, stop: ok }, on: () => () => {}, saveSetupNote };
  } });
  return app;
};
const settle = () => new Promise((r) => setTimeout(r, 20));

test('setup screen: in the app, the setup on the car can be starred and named from the garage', async (t) => {
  const calls = [];
  const app = withApp(t, calls);
  app.connect();
  app.send(snap(setup()));
  [...app.window.document.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Live dashboard')).click();
  showSetup(app, setup({ current: mine() }));
  const star = app.window.document.querySelector('.w-su__star');
  assert.ok(star, 'a star for the setup on the car');
  assert.strictEqual(star.getAttribute('aria-pressed'), 'false');
  star.click();
  await settle();
  assert.deepStrictEqual(calls.at(-1), { trackId: 10, key: 'abcdefabcdef', values: { frontWing: 45 }, favorite: true });
  app.window.document.querySelector('.w-su__mine-name').click();
  const input = app.window.document.querySelector('.w-su__rename');
  assert.ok(input);
  input.value = '  Quali low wing ';
  input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  assert.deepStrictEqual(calls.at(-1), { trackId: 10, key: 'abcdefabcdef', values: { frontWing: 45 }, name: 'Quali low wing' });
});

test('setup screen: the naming strip sits right under the title, not at the foot of the page', async (t) => {
  const calls = [];
  const app = withApp(t, calls);
  app.connect();
  app.send(snap(setup()));
  [...app.window.document.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Live dashboard')).click();
  showSetup(app, setup({ current: mine() }));
  const head = app.window.document.querySelector('.w-su__head');
  assert.strictEqual(head.nextElementSibling.className.split(' ')[0], 'w-su__mine');
});

test('setup screen: it is built from the same cards as the other screens: separate panels with a gap, not one sheet', (t) => {
  const app = open(t, { storage: { 'raceEngineer.setupAuto': false } });
  app.connect();
  showSetup(app, setup({ history: { lapMs: 90000, session: 'Quali', compound: 16, off: 0, rows: [] }, notes: 'lico hell' }));
  const doc = app.window.document;
  const slot = doc.querySelector('.card--setup');
  assert.ok(slot.classList.contains('card--bare'), 'the screen\'s own card has no panel of its own to nest the others in');
  assert.strictEqual(slot.querySelector('.card__title'), null);
  const cards = [...slot.querySelectorAll('.w-su__card')].filter((c) => !c.hidden);
  assert.ok(cards.length >= 4, `${cards.length} cards: title, now, suggested, your fastest, note`);
  assert.ok(cards.every((c) => c.parentElement.classList.contains('w-su')));
});

test('setup screen: the saved name and star show, and a rename in progress is not wiped by the next snapshot', async (t) => {
  const calls = [];
  const app = withApp(t, calls);
  app.connect();
  app.send(snap(setup()));
  [...app.window.document.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Live dashboard')).click();
  showSetup(app, setup({ current: mine({ name: 'Wet-weather', favorite: true }) }));
  assert.strictEqual(text(app, '.w-su__mine-name'), 'Wet-weather');
  assert.strictEqual(app.window.document.querySelector('.w-su__star').getAttribute('aria-pressed'), 'true');
  app.window.document.querySelector('.w-su__mine-name').click();
  const input = app.window.document.querySelector('.w-su__rename');
  input.value = 'half typed';
  app.send(snap({ ...setup({ current: mine({ name: 'Wet-weather', favorite: true }) }), inGarage: true }));
  assert.strictEqual(app.window.document.querySelector('.w-su__rename').value, 'half typed');
  const kd = new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
  app.window.document.querySelector('.w-su__rename').dispatchEvent(kd);
  assert.ok(!app.window.document.querySelector('.w-su__rename'));
  assert.strictEqual(calls.length, 0, 'Escape saves nothing');
});

test('setup screen: a failed save says why, and a browser or phone (no app) shows no naming at all', async (t) => {
  const calls = [];
  const app = withApp(t, calls, { fail: true });
  app.connect();
  app.send(snap(setup()));
  [...app.window.document.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Live dashboard')).click();
  showSetup(app, setup({ current: mine() }));
  app.window.document.querySelector('.w-su__star').click();
  await settle();
  assert.match(text(app, '.w-su__mine'), /at most 60 characters/);
  const phone = open(t, { storage: { 'raceEngineer.setupAuto': false } });
  phone.connect();
  showSetup(phone, setup({ current: mine() }));
  assert.ok(phone.window.document.querySelector('.w-su__mine').hidden);
});
