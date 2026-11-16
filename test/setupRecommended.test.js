const test = require('node:test');
const assert = require('node:assert');
const { buildLibrary } = require('../src/analysis/setupLibrary');

// The sheet's setups as the recommended defaults: every track in the sheet is in the library from the start, with the sheet's
// qualifying and race setup as entries to start from, whether or not you have driven there.
const circuit = (track, over = {}) => ({
  circuit: `${track} GP`, track, notes: 'a note',
  aero: { q: { front: 30, rear: 0 }, r: { front: 42, rear: 15 } }, diff: { q: { on: 100, off: 45 }, r: { on: 100, off: 60 } },
  suspension: { frontSuspension: 41, rearSuspension: 38, frontAntiRollBar: 1, rearAntiRollBar: 5, frontHeight: 21, rearHeight: 47 },
  brakes: { pressure: { q: 98, r: 98 }, bias: { lo: 56, hi: 57 } }, tyres: { q: { front: 29.5, rear: 20.5 }, r: { front: 29.5, rear: 20.4 } }, ...over,
});
const sheet = { game: 'F1 26', circuits: [circuit('Spa'), circuit('Melbourne'), circuit('Madrid')] };
const V = (over = {}) => ({ frontWing: 40, rearWing: 15, diffOn: 100, diffOff: 60, frontSuspension: 41, rearSuspension: 30, frontAntiRollBar: 5, rearAntiRollBar: 1, frontHeight: 23, rearHeight: 45, brakePressure: 98, brakeBias: 57, tyreFront: 29.5, tyreRear: 20.5, ...over });
const drove = () => ({
  uid: 'u1', sessionId: 1, trackId: 10, track: 'Spa', sessionType: 5, name: 'Short qualifying', startedAt: 1, isRace: false, totalLaps: 0, grid: null, finish: null,
  weather: [], runs: [{ fromLap: 1, setup: V() }], laps: [{ lapNum: 1, lapMs: 90000, valid: true, pit: false, neutralised: false, compound: 16, fuelKg: 40 }],
});

test('recommended: every track the game knows in the sheet is in the library, driven or not; a circuit with no game track id is left out', () => {
  const lib = buildLibrary({ sessions: [], notes: [], sheet });
  assert.deepStrictEqual(lib.map((t) => t.track).sort(), ['Melbourne', 'Spa']);
  assert.ok(lib.every((t) => t.setups.length >= 1 && t.setups.every((s) => s.recommended)));
});

test('recommended: the qualifying and the race setup from the sheet, with the sheet\'s values', () => {
  const spa = buildLibrary({ sessions: [], notes: [], sheet }).find((t) => t.track === 'Spa');
  const [q, r] = spa.setups;
  assert.deepStrictEqual([q.name, r.name], ['Recommended · Qualifying', 'Recommended · Race']);
  assert.deepStrictEqual([q.values.frontWing, q.values.rearWing, q.values.diffOff, q.values.tyreRear], [30, 0, 45, 20.5]);
  assert.deepStrictEqual([r.values.frontWing, r.values.rearWing, r.values.diffOff, r.values.tyreRear], [42, 15, 60, 20.4]);
  assert.strictEqual(q.values.frontSuspension, 41);
  assert.strictEqual(q.values.brakePressure, 98);
  assert.strictEqual(q.valueText.brakeBias, '56-57', 'a range stays a range');
  assert.strictEqual(q.values.brakeBias, 56);
});

test('recommended: when qualifying and race are the same setup there is one entry, just "Recommended"', () => {
  const same = circuit('Spa', { aero: { q: { front: 30, rear: 0 }, r: { front: 30, rear: 0 } }, diff: { q: { on: 100, off: 45 }, r: { on: 100, off: 45 } }, tyres: { q: { front: 29.5, rear: 20.5 }, r: { front: 29.5, rear: 20.5 } } });
  const spa = buildLibrary({ sessions: [], notes: [], sheet: { game: 'F1 26', circuits: [same] } })[0];
  assert.deepStrictEqual(spa.setups.map((s) => s.name), ['Recommended']);
});

test('recommended: they are not driven and say so: no sessions, no stats, nothing to rename or save', () => {
  const s = buildLibrary({ sessions: [], notes: [], sheet })[0].setups[0];
  assert.deepStrictEqual([s.sessions.length, s.stats.bestQ, s.stats.racePaceMs, s.orphan], [0, null, null, false]);
  assert.strictEqual(s.recommended, true);
  assert.ok(!/^[0-9a-f]{12}$/.test(s.key), 'its key is not a savable setup key');
});

test('recommended: they come first on a driven track, ahead of your own setups, and driven tracks come before undriven ones', () => {
  const lib = buildLibrary({ sessions: [drove()], notes: [], sheet });
  assert.deepStrictEqual(lib.map((t) => t.track), ['Spa', 'Melbourne']);
  const spa = lib[0].setups;
  assert.deepStrictEqual(spa.map((s) => !!s.recommended), [true, true, false]);
  assert.strictEqual(lib[0].setups.find((s) => !s.recommended).stats.bestQ, 90000);
});

test('recommended: without a sheet there are none, and your own setups are unchanged', () => {
  const lib = buildLibrary({ sessions: [drove()], notes: [], sheet: null });
  assert.deepStrictEqual(lib.map((t) => t.setups.length), [1]);
  assert.ok(!lib[0].setups[0].recommended);
});

test('recommended: a favorite of yours does not push them out of first place', () => {
  const own = drove();
  const first = buildLibrary({ sessions: [own], notes: [], sheet })[0].setups.find((s) => !s.recommended);
  const lib = buildLibrary({ sessions: [own], notes: [{ trackId: 10, key: first.key, values: first.values, name: 'Mine', favorite: true, note: '', updatedAt: 1 }], sheet });
  assert.deepStrictEqual(lib[0].setups.map((s) => !!s.recommended), [true, true, false]);
  assert.strictEqual(lib[0].favorites, 1);
});
