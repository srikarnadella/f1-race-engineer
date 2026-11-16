const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/data/store');
const { setupValues } = require('../src/analysis/setupCompare');
const { bestSetup, diffAgainst } = require('../src/analysis/setupHistory');
const { syntheticPackets, replay } = require('./helpers/synthetic');

// Setup history: what you ran at a track and how fast it was, so the Setup screen can show "this worked for you here".
const lap = (n, ms, over = {}) => ({ lapNum: n, lapMs: ms, valid: true, pit: false, neutralised: false, compound: 17, ...over });
const su = (fw, over = {}) => ({ frontWing: fw, rearWing: 15, ...over });
const session = (over) => ({ sessionType: 5, name: 'One-shot qualifying', startedAt: 1, runs: [{ fromLap: 1, setup: su(40) }], laps: [lap(1, 90000)], ...over });

test('setupValues: the fourteen values the Setup screen compares, by key', () => {
  const v = setupValues({ frontWing: 40, rearWing: 12, onThrottle: 100, offThrottle: 50, frontSuspension: 41, rearSuspension: 30, frontAntiRollBar: 5, rearAntiRollBar: 1, frontSuspensionHeight: 23, rearSuspensionHeight: 45, brakePressure: 98, brakeBias: 57, tyrePressures: { fl: 29.5, fr: 29.5, rl: 20.5, rr: 20.5 } });
  assert.strictEqual(Object.keys(v).length, 14);
  assert.strictEqual(v.frontWing, 40);
  assert.strictEqual(v.tyreFront, 29.5);
  assert.strictEqual(v.tyreRear, 20.5);
});

test('bestSetup: the setup that gave the fastest clean lap of the same kind (qualifying with qualifying)', () => {
  const sessions = [
    session({ runs: [{ fromLap: 1, setup: su(40) }], laps: [lap(1, 91000), lap(2, 90500)] }),
    session({ runs: [{ fromLap: 1, setup: su(44) }], laps: [lap(1, 89900)] }),
    session({ sessionType: 15, name: 'Race', runs: [{ fromLap: 1, setup: su(30) }], laps: [lap(1, 80000)] }),
  ];
  const best = bestSetup(sessions, 'q');
  assert.strictEqual(best.lapMs, 89900);
  assert.strictEqual(best.setup.frontWing, 44);
  assert.strictEqual(bestSetup(sessions, 'r').setup.frontWing, 30, 'a race lap is not compared with a qualifying lap');
});

test('bestSetup: only clean laps count (valid, not a pit lap, not under a safety car)', () => {
  const sessions = [session({ laps: [lap(1, 70000, { valid: false }), lap(2, 70000, { pit: true }), lap(3, 70000, { neutralised: true }), lap(4, 91000)] })];
  assert.strictEqual(bestSetup(sessions, 'q').lapMs, 91000);
  assert.strictEqual(bestSetup([session({ laps: [lap(1, 70000, { valid: false })] })], 'q'), null, 'no clean lap, no answer');
});

test('bestSetup: a setup changed mid-session is credited only with the laps run on it', () => {
  const s = session({ runs: [{ fromLap: 1, setup: su(40) }, { fromLap: 3, setup: su(46) }], laps: [lap(1, 92000), lap(2, 91000), lap(3, 90000), lap(4, 90400)] });
  const b = bestSetup([s], 'q');
  assert.strictEqual(b.setup.frontWing, 46);
  assert.strictEqual(b.lapMs, 90000);
  const early = bestSetup([{ ...s, laps: [lap(1, 92000), lap(2, 91000)] }], 'q');
  assert.strictEqual(early.setup.frontWing, 40);
});

test('bestSetup: nothing to say with no sessions, no setup recorded or an unknown lap time', () => {
  assert.strictEqual(bestSetup([], 'q'), null);
  assert.strictEqual(bestSetup([session({ runs: [] })], 'q'), null);
  assert.strictEqual(bestSetup([session({ laps: [lap(1, 0)] })], 'q'), null);
});

test('diffAgainst: which of your best setup\'s values the car has now and which differ, with which way to go', () => {
  const rows = diffAgainst({ frontWing: 44, rearWing: 15, brakeBias: 56 }, { frontWing: 40, rearWing: 15, brakeBias: null });
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.deepStrictEqual([by.frontWing.ok, by.frontWing.change], [false, 4]);
  assert.strictEqual(by.rearWing.ok, true);
  assert.strictEqual(by.brakeBias.ok, null, 'a value the car did not report is unknown, not wrong');
});

test('store: a replayed session keeps the setup it ran, and the store hands back sessions with their runs and clean laps', () => {
  const store = openStore(':memory:');
  const pipeline = replay(syntheticPackets(), { pipelineOptions: { store } });
  pipeline.flush();
  const rows = store.db.prepare('SELECT * FROM setup_run').all();
  assert.ok(rows.length >= 1);
  assert.ok('frontWing' in JSON.parse(rows[0].setup));
  const trackId = store.db.prepare('SELECT track_id FROM session').get().track_id;
  const [s] = store.setupSessions(trackId);
  assert.ok(s.runs.length >= 1 && s.laps.length > 0);
  assert.ok(typeof s.laps[0].lapMs === 'number' && 'valid' in s.laps[0]);
  assert.deepStrictEqual(store.setupSessions(trackId + 1), [], 'another track');
});

test('pipeline: the next session at the track carries your best setup from the last, and it is gone with no store', () => {
  const store = openStore(':memory:');
  replay(syntheticPackets(), { pipelineOptions: { store } }).flush();
  let seen = null;
  const second = replay(syntheticPackets(), { pipelineOptions: { store }, onTick: ({ snap }) => { if (snap && snap.setup && snap.setup.history) seen = snap.setup.history; } });
  second.flush();
  assert.ok(seen, 'a history on the snapshot');
  assert.ok(seen.lapMs > 0 && seen.rows.length === 14);
  let without = null;
  replay(syntheticPackets(), { onTick: ({ snap }) => { if (snap && snap.setup) without = snap.setup.history; } }).flush();
  assert.strictEqual(without, null);
});
