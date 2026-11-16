const test = require('node:test');
const assert = require('node:assert');
const { setupView } = require('../src/analysis/setupView');

// What the dashboard gets about the setup: the comparison for the circuit the session is at, whether you can change the
// car now (not in a race), and whether you are in the garage or the pit lane.
const setups = { game: 'F1 26', circuits: [{ circuit: 'Belgium', track: 'Spa', aero: { q: { front: 22, rear: 0 }, r: { front: 22, rear: 0 } }, diff: null, suspension: null, brakes: null, tyres: null, notes: 'Casa di Cancro' }] };
const car = (over = {}) => ({ setup: { frontWing: 20, rearWing: 0, onThrottle: 100, offThrottle: 50, tyrePressures: null }, lapData: { pitStatus: 0, driverStatus: 4 }, ...over });
const spaQuali = { trackId: 10, sessionType: 5 };

test('setup view: the circuit the session is at, qualifying values in qualifying, and what is wrong', () => {
  const v = setupView({ session: spaQuali, car: car(), setups });
  assert.deepStrictEqual([v.available, v.track, v.circuit, v.kind, v.editable, v.notes], [true, 'Spa', 'Belgium', 'q', true, 'Casa di Cancro']);
  assert.strictEqual(v.rows.length, 14);
  assert.strictEqual(v.rows.find((r) => r.key === 'frontWing').ok, false);
  assert.strictEqual(v.off, 1);
});

test('setup view: a race is read with the race values and cannot be edited; practice and time trial can', () => {
  assert.deepStrictEqual([setupView({ session: { trackId: 10, sessionType: 15 }, car: car(), setups }).kind, setupView({ session: { trackId: 10, sessionType: 15 }, car: car(), setups }).editable], ['r', false]);
  assert.strictEqual(setupView({ session: { trackId: 10, sessionType: 16 }, car: car(), setups }).editable, false, 'a sprint too');
  assert.strictEqual(setupView({ session: { trackId: 10, sessionType: 1 }, car: car(), setups }).editable, true);
  assert.strictEqual(setupView({ session: { trackId: 10, sessionType: 18 }, car: car(), setups }).editable, true);
});

test('setup view: in the garage or the pit lane is flagged, on track is not', () => {
  assert.strictEqual(setupView({ session: spaQuali, car: car(), setups }).inGarage, false);
  assert.strictEqual(setupView({ session: spaQuali, car: car({ lapData: { pitStatus: 1, driverStatus: 0 } }), setups }).inGarage, true, 'the pit lane');
  assert.strictEqual(setupView({ session: spaQuali, car: car({ lapData: { pitStatus: 0, driverStatus: 0 } }), setups }).inGarage, true, 'the garage');
});

test('setup view: no sheet, a track the sheet lacks, or no setup packet yet says so without failing', () => {
  assert.strictEqual(setupView({ session: spaQuali, car: car(), setups: null }).available, false);
  assert.strictEqual(setupView({ session: { trackId: 4, sessionType: 5 }, car: car(), setups }).available, false, 'Barcelona is not in this sheet');
  assert.strictEqual(setupView({ session: spaQuali, car: { lapData: {} }, setups }), null, 'no setup packet yet');
  assert.strictEqual(setupView({ session: null, car: car(), setups }), null);
  const none = setupView({ session: { trackId: 4, sessionType: 5 }, car: car(), setups });
  assert.deepStrictEqual([none.rows, none.off, none.circuit], [[], 0, null]);
});

// The car's setup as the library knows it, so the garage screen can name and star it.
const { identity } = require('../src/analysis/setupLibrary');
const { setupValues, setupExtras } = require('../src/analysis/setupCompare');
const full = () => car({ setup: { frontWing: 20, rearWing: 0, onThrottle: 100, offThrottle: 50, frontCamber: -3.5, rearCamber: -2, frontToe: 0.05, rearToe: 0.2, engineBraking: 50, ballast: 6, tyrePressures: { fl: 29.5, fr: 29.5, rl: 20.5, rr: 20.5 } } });

test('setup view: the current setup carries the key the library knows it by, with no note yet', () => {
  const v = setupView({ session: spaQuali, car: full(), setups, notes: [] });
  const values = { ...setupValues(full().setup), ...setupExtras(full().setup) };
  assert.deepStrictEqual([v.current.key, v.current.trackId, v.current.name, v.current.favorite], [identity(values), 10, '', false]);
  assert.deepStrictEqual(v.current.values, values);
});

test('setup view: the name and star you gave this setup come with it', () => {
  const values = { ...setupValues(full().setup), ...setupExtras(full().setup) };
  const notes = [{ trackId: 10, key: identity(values), name: 'Low-wing quali', favorite: true, note: 'x', values, updatedAt: 1 }, { trackId: 7, key: identity(values), name: 'Other track', favorite: false, note: '', values, updatedAt: 1 }];
  const v = setupView({ session: spaQuali, car: full(), setups, notes });
  assert.deepStrictEqual([v.current.name, v.current.favorite], ['Low-wing quali', true]);
});

test('setup view: the current setup is there without a sheet too', () => {
  const v = setupView({ session: spaQuali, car: full(), setups: null, notes: [] });
  assert.strictEqual(v.available, false);
  assert.ok(v.current && v.current.key);
});
