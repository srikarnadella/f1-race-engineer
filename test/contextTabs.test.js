const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');

// The rail only lists Setup and Briefing while you are in the garage, and Debrief once the session is over, so the sidebar
// is not full of screens with nothing to show.
const base = () => raceSnapshots().find((s) => s.player && s.analysis);
const setup = (inGarage) => ({ available: true, track: 'Spa', circuit: 'Belgium', kind: 'q', editable: true, inGarage, rows: [], off: 0, notes: null, source: 'F1 26', history: null });
const snap = (over = {}) => ({ ...base(), connected: true, focus: { screen: 'drive', reason: null }, setup: setup(false), ...over });
const tabs = (app) => [...app.window.document.querySelectorAll('.tab')].map((b) => b.lastChild.textContent);
const go = (app, label) => [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === label).click();

test('rail: on track there is no Setup, Briefing or Debrief tab', (t) => {
  const app = open(t);
  app.connect();
  app.send(snap());
  assert.deepStrictEqual(tabs(app), ['Drive', 'Battle', 'Strategy', 'Weather', 'Custom']);
});

test('rail: Setup and Briefing appear in the garage and go when you leave it', (t) => {
  const app = open(t, { storage: { 'raceEngineer.setupAuto': false } });
  app.connect();
  app.send(snap({ setup: setup(true) }));
  assert.deepStrictEqual(tabs(app), ['Drive', 'Battle', 'Strategy', 'Weather', 'Custom', 'Setup', 'Briefing', 'Setups']); // the library too, on a phone
  app.send(snap());
  assert.deepStrictEqual(tabs(app), ['Drive', 'Battle', 'Strategy', 'Weather', 'Custom']);
});

test('rail: in the garage before a race (the car cannot be changed) only the Briefing is listed', (t) => {
  const app = open(t);
  app.connect();
  app.send(snap({ setup: { ...setup(true), editable: false } }));
  assert.deepStrictEqual(tabs(app), ['Drive', 'Battle', 'Strategy', 'Weather', 'Custom', 'Briefing', 'Setups']);
});

test('rail: Debrief appears when the session is over, and only then', (t) => {
  const app = open(t, { storage: { 'raceEngineer.auto': false } });
  app.connect();
  app.send(snap({ focus: { screen: 'debrief', reason: 'Session over' } }));
  assert.deepStrictEqual(tabs(app), ['Drive', 'Battle', 'Strategy', 'Weather', 'Custom', 'Debrief']);
  app.send(snap());
  assert.deepStrictEqual(tabs(app), ['Drive', 'Battle', 'Strategy', 'Weather', 'Custom']);
});

test('rail: the screen you are looking at keeps its tab, so it never vanishes under you', (t) => {
  const app = open(t, { storage: { 'raceEngineer.setupAuto': false, 'raceEngineer.auto': false } });
  app.connect();
  app.send(snap({ setup: setup(true) }));
  go(app, 'Setup');
  app.send(snap());
  assert.strictEqual(app.activeTab(), 'Setup');
  assert.ok(tabs(app).includes('Setup'));
  go(app, 'Drive');
  assert.ok(!tabs(app).includes('Setup'), 'gone once you move on');
});

test('rail: number keys follow what is listed, with no gap where a hidden tab would be', (t) => {
  const app = open(t);
  app.connect();
  app.send(snap());
  app.press('6');
  assert.strictEqual(app.activeTab(), 'Drive', 'six tabs are not listed, so 6 does nothing');
  app.send(snap({ focus: { screen: 'debrief', reason: 'Session over' } }));
  app.press('6');
  assert.strictEqual(app.activeTab(), 'Debrief');
});

test('rail: auto-switch to the Debrief at the flag still works, and a garage visit still brings Setup up', (t) => {
  const app = open(t, { storage: { 'raceEngineer.auto': true } });
  app.connect();
  app.send(snap());
  app.send(snap({ focus: { screen: 'debrief', reason: 'Session over' } }));
  assert.strictEqual(app.activeTab(), 'Debrief');
  const g = open(t);
  g.connect();
  g.send(snap());
  g.send(snap({ setup: setup(true) }));
  assert.strictEqual(g.activeTab(), 'Setup');
});
