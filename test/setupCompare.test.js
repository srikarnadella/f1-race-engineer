const test = require('node:test');
const assert = require('node:assert');
const { compareSetup, ROWS } = require('../src/analysis/setupCompare');

// The setup on the car against the sheet's setup for the track: fourteen values, each right or not. Qualifying uses the
// sheet's q values where it gives them, everything else the race values.
const circuit = {
  circuit: 'Australia', track: 'Melbourne',
  aero: { q: { front: 30, rear: 0 }, r: { front: 42, rear: 15 } },
  diff: { q: { on: 100, off: 45 }, r: { on: 100, off: 60 } },
  suspension: { frontSuspension: 41, rearSuspension: 38, frontAntiRollBar: 1, rearAntiRollBar: 5, frontHeight: 21, rearHeight: 47 },
  brakes: { pressure: { q: 98, r: 98 }, bias: { lo: 56, hi: 57 } },
  tyres: { q: { front: 29.5, rear: 20.5 }, r: { front: 29.5, rear: 20.5 } },
  notes: 'lico hell',
};
const car = (over = {}) => ({
  frontWing: 42, rearWing: 15, onThrottle: 100, offThrottle: 60, frontSuspension: 41, rearSuspension: 38, frontAntiRollBar: 1, rearAntiRollBar: 5,
  frontSuspensionHeight: 21, rearSuspensionHeight: 47, brakePressure: 98, brakeBias: 56, tyrePressures: { rl: 20.5, rr: 20.5, fl: 29.5, fr: 29.5 }, ...over,
});
const row = (r, key) => r.rows.find((x) => x.key === key);

test('setup compare: a car set up exactly to the sheet has every value right', () => {
  const r = compareSetup(car(), circuit, 'r');
  assert.strictEqual(r.rows.length, 14);
  assert.strictEqual(r.off, 0);
  assert.ok(r.rows.every((x) => x.ok === true), JSON.stringify(r.rows.filter((x) => !x.ok)));
  assert.deepStrictEqual(r.rows.map((x) => x.key), ROWS.map((x) => x.key));
});

test('setup compare: each wrong value is marked, with what is on the car, what the sheet says and which way to go', () => {
  const r = compareSetup(car({ frontWing: 45, offThrottle: 50, brakePressure: 100 }), circuit, 'r');
  assert.strictEqual(r.off, 3);
  assert.deepStrictEqual([row(r, 'frontWing').ok, row(r, 'frontWing').current, row(r, 'frontWing').target, row(r, 'frontWing').change], [false, 45, '42', -3]);
  assert.strictEqual(row(r, 'diffOff').change, 10);
  assert.strictEqual(row(r, 'brakePressure').change, -2);
  assert.strictEqual(row(r, 'rearWing').ok, true);
});

test('setup compare: qualifying reads the q values, the race the r values', () => {
  const q = compareSetup(car(), circuit, 'q');
  assert.deepStrictEqual(q.rows.filter((x) => !x.ok).map((x) => x.key), ['frontWing', 'rearWing', 'diffOff']);
  assert.strictEqual(row(q, 'frontWing').target, '30');
  assert.strictEqual(compareSetup(car({ frontWing: 30, rearWing: 0, offThrottle: 45 }), circuit, 'q').off, 0);
});

test('setup compare: the brake bias is right anywhere in the sheet\'s range', () => {
  assert.strictEqual(row(compareSetup(car({ brakeBias: 56 }), circuit, 'r'), 'brakeBias').ok, true);
  assert.strictEqual(row(compareSetup(car({ brakeBias: 57 }), circuit, 'r'), 'brakeBias').ok, true);
  const out = row(compareSetup(car({ brakeBias: 59 }), circuit, 'r'), 'brakeBias');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.target, '56-57');
  assert.strictEqual(out.change, -2, 'the nearest end of the range');
  assert.strictEqual(row(compareSetup(car({ brakeBias: 54 }), circuit, 'r'), 'brakeBias').change, 2);
});

test('setup compare: tyre pressure is the axle\'s average, right within a twentieth of a bar', () => {
  assert.strictEqual(row(compareSetup(car({ tyrePressures: { rl: 20.5, rr: 20.5, fl: 29.4, fr: 29.6 } }), circuit, 'r'), 'tyreFront').ok, true);
  const f = row(compareSetup(car({ tyrePressures: { rl: 20.5, rr: 20.5, fl: 27.5, fr: 27.5 } }), circuit, 'r'), 'tyreFront');
  assert.deepStrictEqual([f.ok, f.current, f.target, f.change], [false, 27.5, '29.5', 2]);
  const rr = row(compareSetup(car({ tyrePressures: { rl: 22, rr: 22, fl: 29.5, fr: 29.5 } }), circuit, 'r'), 'tyreRear');
  assert.strictEqual(rr.change, -1.5);
});

test('setup compare: a circuit with parts the sheet could not give leaves those rows unmarked, never wrong', () => {
  const partial = { ...circuit, aero: null, suspension: null };
  const r = compareSetup(car({ frontWing: 1 }), partial, 'r');
  assert.strictEqual(row(r, 'frontWing').ok, null);
  assert.strictEqual(row(r, 'frontWing').target, null);
  assert.strictEqual(row(r, 'frontSuspension').ok, null);
  assert.strictEqual(r.off, 0, 'unknown is not off');
});

test('setup compare: no setup on the car yet, or no circuit, gives nothing to compare', () => {
  assert.strictEqual(compareSetup(null, circuit, 'r'), null);
  assert.strictEqual(compareSetup(car(), null, 'r'), null);
  const noTyres = compareSetup(car({ tyrePressures: null }), circuit, 'r');
  assert.strictEqual(row(noTyres, 'tyreFront').ok, null);
});
