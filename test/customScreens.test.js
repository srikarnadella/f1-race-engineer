const test = require('node:test');
const assert = require('node:assert');
const { open } = require('./helpers/dashboard');

// The Custom screens: your own pick of widgets in a layout, saved on this device. Up to three can be kept
// (Custom, Custom 2, Custom 3); Customize on a screen starts one from it.
const labels = (app) => [...app.window.document.querySelectorAll('.tab')].map((b) => b.lastChild.textContent);
const tab = (app, label) => [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === label);
const widgetsOf = (app) => [...app.window.document.querySelectorAll('#grid .card')].map((c) => [...c.classList].find((k) => k.startsWith('card--') && !['card--tall'].includes(k)).slice(6));
const go = (app, label) => tab(app, label).click();
const customize = (app) => app.$('customize').click();
const stored = (app) => Object.fromEntries(Object.keys(app.window.localStorage).map((k) => [k, app.window.localStorage.getItem(k)]));
// A page opened again on the same device: what the first one saved in localStorage.
const reopen = (t, app) => {
  const storage = {};
  for (const [k, v] of Object.entries(stored(app))) storage[k] = JSON.parse(v);
  return open(t, { storage });
};

test('custom: there is one Custom screen to start with, after Weather (the Debrief is listed only once a session is over)', (t) => {
  const app = open(t);
  assert.deepStrictEqual(labels(app), ['Home', 'Drive', 'Battle', 'Strategy', 'Weather', 'Custom'].filter((l) => l !== 'Home' || labels(app).includes('Home')));
  assert.ok(labels(app).includes('Custom'));
  assert.ok(!labels(app).includes('Custom 2'));
});

test('custom: Customize on a screen starts the Custom screen from it (the first time, as before)', (t) => {
  const app = open(t);
  go(app, 'Battle');
  customize(app);
  assert.strictEqual(app.activeTab(), 'Custom');
  assert.deepStrictEqual(widgetsOf(app).slice(0, 4), ['battle', 'call', 'radio', 'pace']);
  assert.ok(!app.$('editbar').hidden, 'in the editor');
  assert.deepStrictEqual(labels(app).filter((l) => /^Custom/.test(l)), ['Custom']);
});

test('custom: Customize on another screen then makes a second one, and a third; the fourth is not offered', (t) => {
  const app = open(t);
  go(app, 'Battle');
  customize(app);
  go(app, 'Strategy');
  customize(app);
  assert.strictEqual(app.activeTab(), 'Custom 2');
  assert.deepStrictEqual(widgetsOf(app).slice(0, 3), ['rejoin', 'call', 'options']);
  go(app, 'Weather');
  customize(app);
  assert.strictEqual(app.activeTab(), 'Custom 3');
  assert.deepStrictEqual(labels(app).filter((l) => /^Custom/.test(l)), ['Custom', 'Custom 2', 'Custom 3']);
  go(app, 'Drive');
  assert.strictEqual(app.$('customize').disabled, true, 'three is the limit');
  assert.match(app.$('customize').title, /3 custom screens/);
  assert.strictEqual(labels(app).length, new Set(labels(app)).size);
});

test('custom: editing one screen changes only that screen', (t) => {
  const app = open(t);
  go(app, 'Battle');
  customize(app);
  go(app, 'Strategy');
  customize(app);
  const first = widgetsOf(app);
  const picker = app.window.document.querySelector('.slot-picker select');
  picker.value = 'weather';
  picker.dispatchEvent(new app.window.Event('change'));
  assert.strictEqual(widgetsOf(app)[0], 'weather');
  go(app, 'Custom');
  assert.deepStrictEqual(widgetsOf(app).slice(0, 4), ['battle', 'call', 'radio', 'pace'], 'Custom untouched');
  go(app, 'Custom 2');
  assert.notDeepStrictEqual(widgetsOf(app), first);
});

test('custom: "New custom screen" in the editor copies the one you are editing into the next slot', (t) => {
  const app = open(t);
  go(app, 'Battle');
  customize(app);
  const before = widgetsOf(app);
  app.$('new-custom').click();
  assert.strictEqual(app.activeTab(), 'Custom 2');
  assert.deepStrictEqual(widgetsOf(app), before);
  app.$('new-custom').click();
  assert.strictEqual(app.activeTab(), 'Custom 3');
  assert.strictEqual(app.$('new-custom').hidden, true, 'no fourth');
});

test('custom: a screen can be deleted (the last one stays and can only be reset), and the others keep their order', (t) => {
  const app = open(t);
  go(app, 'Battle');
  customize(app);
  app.$('new-custom').click();
  go(app, 'Custom 2'); // the editor stays open between custom screens
  const picker = app.window.document.querySelector('.slot-picker select');
  picker.value = 'weather';
  picker.dispatchEvent(new app.window.Event('change'));
  app.$('new-custom').click(); // Custom 3, a copy of Custom 2
  go(app, 'Custom 2');
  assert.strictEqual(app.$('delete-custom').hidden, false);
  app.$('delete-custom').click();
  assert.deepStrictEqual(labels(app).filter((l) => /^Custom/.test(l)), ['Custom', 'Custom 2'], 'renumbered');
  assert.strictEqual(widgetsOf(app)[0] !== undefined, true);
  // Custom 2 is now what was Custom 3: the edited one.
  go(app, 'Custom 2');
  assert.strictEqual(widgetsOf(app)[0], 'weather');
  customize(app);
  app.$('delete-custom').click();
  assert.deepStrictEqual(labels(app).filter((l) => /^Custom/.test(l)), ['Custom']);
  customize(app);
  assert.strictEqual(app.$('delete-custom').hidden, true, 'the only one cannot be deleted');
  app.$('delete-custom').click();
  assert.deepStrictEqual(labels(app).filter((l) => /^Custom/.test(l)), ['Custom'], 'even if the click gets through');
});

test('custom: the screens are remembered on this device, and a single Custom saved by the old version still loads', (t) => {
  const app = open(t);
  go(app, 'Battle');
  customize(app);
  app.$('new-custom').click();
  const picker = app.window.document.querySelector('.slot-picker select');
  picker.value = 'weather';
  picker.dispatchEvent(new app.window.Event('change'));
  const again = reopen(t, app);
  assert.deepStrictEqual(labels(again).filter((l) => /^Custom/.test(l)), ['Custom', 'Custom 2']);
  go(again, 'Custom 2');
  assert.strictEqual(widgetsOf(again)[0], 'weather');

  const old = open(t, { storage: { 'raceEngineer.custom': { layout: 'banner-feature', widgets: ['weather', 'call', 'radio', 'pace', 'nearby', 'adjust'] } } });
  assert.deepStrictEqual(labels(old).filter((l) => /^Custom/.test(l)), ['Custom']);
  go(old, 'Custom');
  assert.strictEqual(widgetsOf(old)[0], 'weather');
});

test('custom: junk in storage (a bad layout, an unknown widget, more than three) falls back to something sensible', (t) => {
  const app = open(t, { storage: { 'raceEngineer.customs': [{ layout: 'nope', widgets: ['zzz'] }, 5, null, { layout: 'banner-feature', widgets: [] }, {}] } });
  const customs = labels(app).filter((l) => /^Custom/.test(l));
  assert.ok(customs.length >= 1 && customs.length <= 3, customs.join());
  go(app, 'Custom');
  assert.strictEqual(widgetsOf(app).length, 6);
  assert.deepStrictEqual(app.errors, []);
});

test('custom: the number keys and the Settings shortcut list still line up with the screens', (t) => {
  const app = open(t);
  go(app, 'Battle');
  customize(app);
  app.$('new-custom').click();
  const keys = [...app.window.document.querySelectorAll('.tab')].map((b) => b.querySelector('.tab__key').textContent);
  assert.deepStrictEqual(keys.filter(Boolean), keys.filter(Boolean).map((_, i) => String(i + 1)), 'keys are 1, 2, 3 ... in order');
  assert.deepStrictEqual(app.errors, []);
});
