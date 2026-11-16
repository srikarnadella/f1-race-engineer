const test = require('node:test');
const assert = require('node:assert');
const { identity, buildLibrary, IDENTITY_KEYS } = require('../src/analysis/setupLibrary');
const { compareValues, compareSetup, setupValues } = require('../src/analysis/setupCompare');

// The setup library: every setup you ran at a track, what it did, and the names and stars you gave it.
const V = (over = {}) => ({
  frontWing: 40, rearWing: 15, diffOn: 100, diffOff: 60, frontSuspension: 41, rearSuspension: 30, frontAntiRollBar: 5, rearAntiRollBar: 1,
  frontHeight: 23, rearHeight: 45, brakePressure: 98, brakeBias: 57, tyreFront: 29.5, tyreRear: 20.5,
  frontCamber: -3.5, rearCamber: -2, frontToe: 0.05, rearToe: 0.2, engineBraking: 50, ballast: 6, ...over,
});
const lap = (n, ms, over = {}) => ({ lapNum: n, lapMs: ms, valid: true, pit: false, neutralised: false, compound: 16, fuelKg: 40, ...over });
const sess = (over = {}) => ({
  uid: 'u1', sessionId: 1, trackId: 10, track: 'Spa', sessionType: 5, name: 'Short qualifying', startedAt: Date.UTC(2026, 9, 20), isRace: false,
  totalLaps: 0, grid: null, finish: null, weather: [{ weather: 0, trackTemp: 30, airTemp: 22, rainPct: 0 }], runs: [{ fromLap: 1, setup: V() }], laps: [lap(1, 90000)], ...over,
});

test('identity: the same values are the same setup, a changed value is another, and brake bias is not part of it', () => {
  assert.strictEqual(identity(V()), identity(V()));
  assert.notStrictEqual(identity(V()), identity(V({ frontWing: 41 })));
  assert.strictEqual(identity(V()), identity(V({ brakeBias: 52 })), 'the bias moves from the wheel lap by lap');
  assert.ok(!IDENTITY_KEYS.includes('brakeBias'));
  assert.notStrictEqual(identity(V()), identity(V({ rearToe: 0.25 })), 'camber, toe and engine braking count');
  assert.notStrictEqual(identity(V()), identity(V({ engineBraking: 60 })));
});

test('identity: pressure and float noise below the game\'s step does not make a new setup', () => {
  assert.strictEqual(identity(V({ tyreFront: 29.5 })), identity(V({ tyreFront: 29.52 })));
  assert.notStrictEqual(identity(V({ tyreFront: 29.5 })), identity(V({ tyreFront: 29.6 })));
  assert.strictEqual(identity(V({ frontToe: 0.05 })), identity(V({ frontToe: 0.0500001 })));
});

test('identity: a setup recorded before camber and toe were kept still has an identity, different from one that has them', () => {
  const old = V();
  for (const k of ['frontCamber', 'rearCamber', 'frontToe', 'rearToe', 'engineBraking', 'ballast']) delete old[k];
  assert.ok(typeof identity(old) === 'string' && identity(old).length > 6);
  assert.notStrictEqual(identity(old), identity(V()));
});

test('library: sessions with the same values are one setup; a changed setup is another; tracks are kept apart', () => {
  const lib = buildLibrary({
    sessions: [
      sess({ uid: 'a', sessionId: 1, startedAt: 1 }),
      sess({ uid: 'b', sessionId: 2, startedAt: 2 }),
      sess({ uid: 'c', sessionId: 3, startedAt: 3, runs: [{ fromLap: 1, setup: V({ frontWing: 44 }) }] }),
      sess({ uid: 'd', sessionId: 4, startedAt: 4, trackId: 7, track: 'Silverstone' }),
    ],
    notes: [],
  });
  assert.deepStrictEqual(lib.map((t) => [t.track, t.setups.length]).sort(), [['Silverstone', 1], ['Spa', 2]]);
  const spa = lib.find((t) => t.track === 'Spa');
  assert.deepStrictEqual(spa.setups.map((s) => s.sessions.length).sort(), [1, 2]);
});

test('library: fastest and median clean lap per kind, qualifying kept apart from race, only clean laps counted', () => {
  const lib = buildLibrary({
    sessions: [
      sess({ laps: [lap(1, 90000), lap(2, 89000), lap(3, 88000, { valid: false }), lap(4, 70000, { pit: true }), lap(5, 70000, { neutralised: true }), lap(6, 91000)] }),
      sess({ uid: 'r', sessionId: 2, sessionType: 15, name: 'Race', isRace: true, totalLaps: 20, startedAt: 2, laps: [lap(1, 99000), lap(2, 95000), lap(3, 96000)] }),
    ],
    notes: [],
  });
  const s = lib[0].setups[0].stats;
  assert.strictEqual(s.bestQ, 89000);
  assert.strictEqual(s.medianQ, 90000);
  assert.strictEqual(s.cleanLapsQ, 3);
  assert.strictEqual(s.bestR, 95000, 'the first lap of a race is a standing start and does not count');
  assert.strictEqual(s.cleanLapsR, 2);
});

test('library: race pace needs five clean race laps, and says how many it has when it has fewer', () => {
  const few = buildLibrary({ sessions: [sess({ sessionType: 15, isRace: true, totalLaps: 20, laps: [lap(1, 99000), lap(2, 95000), lap(3, 96000), lap(4, 95500)] })], notes: [] });
  assert.strictEqual(few[0].setups[0].stats.racePaceMs, null);
  assert.strictEqual(few[0].setups[0].stats.raceLaps, 3);
  const laps = [lap(1, 99000), ...[95000, 95200, 95400, 95600, 95800].map((ms, i) => lap(i + 2, ms))];
  const enough = buildLibrary({ sessions: [sess({ sessionType: 15, isRace: true, totalLaps: 20, laps })], notes: [] });
  assert.strictEqual(enough[0].setups[0].stats.racePaceMs, 95400);
  assert.strictEqual(enough[0].setups[0].stats.raceLaps, 5);
});

test('library: a setup changed mid-session is credited only with the laps run on it', () => {
  const lib = buildLibrary({ sessions: [sess({ runs: [{ fromLap: 1, setup: V() }, { fromLap: 3, setup: V({ frontWing: 46 }) }], laps: [lap(1, 92000), lap(2, 91000), lap(3, 90000), lap(4, 90400)] })], notes: [] });
  const [a, b] = lib[0].setups.sort((x, y) => x.values.frontWing - y.values.frontWing);
  assert.strictEqual(a.stats.bestQ, 91000);
  assert.strictEqual(b.stats.bestQ, 90000);
});

test('library: conditions travel with the numbers: compounds, track temperature range, weather and average race fuel', () => {
  const lib = buildLibrary({
    sessions: [sess({ weather: [{ weather: 0, trackTemp: 28, airTemp: 20, rainPct: 0 }, { weather: 3, trackTemp: 22, airTemp: 18, rainPct: 60 }], laps: [lap(1, 90000, { compound: 16 }), lap(2, 91000, { compound: 17 })] })],
    notes: [],
  });
  const s = lib[0].setups[0].stats;
  assert.deepStrictEqual(s.compounds, [16, 17]);
  assert.deepStrictEqual([s.trackTempMin, s.trackTempMax], [22, 28]);
  assert.deepStrictEqual(s.weathers, [0, 3]);
});

test('library: each session of a setup carries what is needed to link to the race: uid, date, result, laps and best', () => {
  const lib = buildLibrary({ sessions: [sess({ sessionType: 15, isRace: true, name: 'Race', grid: 6, finish: 3, laps: [lap(1, 99000), lap(2, 95000)] })], notes: [] });
  const r = lib[0].setups[0].sessions[0];
  assert.deepStrictEqual([r.uid, r.name, r.grid, r.finish, r.isRace, r.cleanLaps, r.bestMs], ['u1', 'Race', 6, 3, true, 1, 95000]);
  assert.ok(r.startedAt > 0);
});

test('library: a name, a star and a note attach to the setup, and favorites sort first', () => {
  const sessions = [sess({ uid: 'a', startedAt: 1 }), sess({ uid: 'b', sessionId: 2, startedAt: 2, runs: [{ fromLap: 1, setup: V({ frontWing: 44 }) }] })];
  const plain = buildLibrary({ sessions, notes: [] })[0].setups;
  assert.strictEqual(plain[0].values.frontWing, 44, 'the most recent first');
  assert.ok(/Spa · \d+ \w+ · Qualifying/.test(plain[0].name), plain[0].name);
  assert.strictEqual(plain[0].named, false);
  const old = plain.find((s) => s.values.frontWing === 40);
  const lib = buildLibrary({ sessions, notes: [{ trackId: 10, key: old.key, values: old.values, name: 'Wing-light quali', favorite: true, note: 'loose at Eau Rouge', updatedAt: 5 }] })[0];
  assert.strictEqual(lib.setups[0].name, 'Wing-light quali');
  assert.strictEqual(lib.setups[0].named, true);
  assert.strictEqual(lib.setups[0].favorite, true);
  assert.strictEqual(lib.setups[0].note, 'loose at Eau Rouge');
  assert.strictEqual(lib.favorites, 1);
});

test('library: a setup you named stays when its sessions are gone, and says so; an unnamed one with no sessions does not exist', () => {
  const lib = buildLibrary({ sessions: [], notes: [{ trackId: 10, key: identity(V()), values: V(), name: 'Old faithful', favorite: true, note: '', updatedAt: 1 }, { trackId: 10, key: 'zzz', values: V({ frontWing: 1 }), name: '', favorite: false, note: '', updatedAt: 1 }] });
  assert.strictEqual(lib.length, 1);
  assert.strictEqual(lib[0].track, 'Spa');
  assert.strictEqual(lib[0].setups.length, 1);
  assert.strictEqual(lib[0].setups[0].orphan, true);
  assert.strictEqual(lib[0].setups[0].sessions.length, 0);
  assert.strictEqual(lib[0].setups[0].stats.bestQ, null);
});

test('library: two unnamed setups from the same day do not get the same name', () => {
  const lib = buildLibrary({ sessions: [sess({ uid: 'a', startedAt: 1 }), sess({ uid: 'b', sessionId: 2, startedAt: 2, runs: [{ fromLap: 1, setup: V({ frontWing: 44 }) }] })], notes: [] });
  const names = lib[0].setups.map((s) => s.name);
  assert.strictEqual(new Set(names).size, 2, names.join(' | '));
});

test('library: against the sheet: how many values differ, for qualifying and for the race', () => {
  const sheet = { game: 'F1 26', circuits: [{ track: 'Spa', circuit: 'Belgium', notes: null, aero: { q: { front: 40, rear: 15 }, r: { front: 38, rear: 15 } }, diff: null, suspension: null, brakes: null, tyres: null }] };
  const lib = buildLibrary({ sessions: [sess()], notes: [], sheet });
  assert.deepStrictEqual(lib[0].setups.find((x) => !x.recommended).sheetOff, { q: 0, r: 1 });
  assert.strictEqual(lib[0].circuit, 'Belgium');
  assert.strictEqual(buildLibrary({ sessions: [sess()], notes: [], sheet: null })[0].setups[0].sheetOff, null);
});

test('compareValues: the same answer as compareSetup does for the car\'s own fields', () => {
  const car = { frontWing: 40, rearWing: 15, onThrottle: 100, offThrottle: 60, frontSuspension: 41, rearSuspension: 30, frontAntiRollBar: 5, rearAntiRollBar: 1, frontSuspensionHeight: 23, rearSuspensionHeight: 45, brakePressure: 98, brakeBias: 57, tyrePressures: { fl: 29.5, fr: 29.5, rl: 20.5, rr: 20.5 } };
  const circuit = { track: 'Spa', circuit: 'Belgium', notes: null, aero: { q: { front: 42, rear: 15 }, r: { front: 42, rear: 15 } }, diff: null, suspension: null, brakes: null, tyres: { q: { front: 29.5, rear: 20.5 }, r: { front: 29.5, rear: 20.5 } } };
  assert.deepStrictEqual(compareValues(setupValues(car), circuit, 'q'), compareSetup(car, circuit, 'q'));
});

test('library: each setup carries its rows against the sheet (right, wrong, which way) and the track carries the sheet\'s own values', () => {
  const sheet = { game: 'F1 26', circuits: [{ track: 'Spa', circuit: 'Belgium', notes: 'lico hell', aero: { q: { front: 44, rear: 15 }, r: { front: 38, rear: 15 } }, diff: null, suspension: null, brakes: null, tyres: null }] };
  const lib = buildLibrary({ sessions: [sess()], notes: [], sheet });
  const fw = lib[0].setups.find((x) => !x.recommended).vsSheet.q.find((r) => r.key === 'frontWing');
  assert.deepStrictEqual([fw.ok, fw.change, fw.target], [false, 4, '44']);
  assert.strictEqual(lib[0].reference.q.find((r) => r.key === 'frontWing').target, '44');
  assert.strictEqual(lib[0].reference.r.find((r) => r.key === 'frontWing').target, '38');
  assert.strictEqual(lib[0].reference.notes, 'lico hell');
  assert.strictEqual(buildLibrary({ sessions: [sess()], notes: [], sheet: null })[0].reference, null);
});
