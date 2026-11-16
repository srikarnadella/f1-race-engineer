const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');

// Units: kilometres and Celsius by default, miles and Fahrenheit when chosen in Settings; remembered.
const base = () => raceSnapshots().find((s) => s.player && s.analysis);
const withTopSpeeds = (s) => ({ ...s, field: s.field.map((c) => ({ ...c, topSpeedKmh: c.isPlayer ? 320 : 300 })), nearby: s.nearby.map((c) => ({ ...c, topSpeedKmh: 300 })) });
const bodyText = (app) => app.window.document.body.textContent;

test('units: metric by default, and the choice is on in Settings and remembered', (t) => {
  const app = open(t);
  app.settingsOpen = app.$('settings').click();
  assert.strictEqual(app.$('set-imperial').checked, false);
  app.$('set-imperial').checked = true;
  app.$('set-imperial').dispatchEvent(new app.window.Event('change'));
  assert.strictEqual(JSON.parse(app.window.localStorage.getItem('raceEngineer.imperial')), true);
  const again = open(t, { storage: { 'raceEngineer.imperial': true } });
  again.$('settings').click();
  assert.strictEqual(again.$('set-imperial').checked, true);
});

test('units: converting is exact enough to read (320 km/h is 199 mph, 30 C is 86 F)', (t) => {
  const app = open(t);
  const { speed, temp } = app.window.RaceWidgets.units;
  assert.strictEqual(speed(320), '320 km/h');
  assert.strictEqual(temp(30), '30°C');
  app.window.RaceWidgets.units.imperial = true;
  assert.strictEqual(speed(320), '199 mph');
  assert.strictEqual(temp(30), '86°F');
  assert.strictEqual(temp(null), '–');
});

test('units: the Battle card\'s top speeds follow the setting', (t) => {
  const app = open(t, { storage: { 'raceEngineer.imperial': true } });
  app.connect();
  app.send(withTopSpeeds({ ...base(), connected: true }));
  [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === 'Battle').click();
  assert.match(bodyText(app), /Top speed \d+ mph · you \d+(?! km)/);
  assert.doesNotMatch(bodyText(app), /Top speed [^·]*km\/h/);
  assert.deepStrictEqual(app.errors, []);
});
