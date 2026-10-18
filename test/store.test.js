const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/data/store');
const { createLapRecorder } = require('../src/data/laps');
const { syntheticPackets, replay } = require('./helpers/synthetic');

// The synthetic race into a fresh in-memory store, as the live bridge would
// fill data/race.db; lapRows are the lap dataset's rows for the same replay.
function syntheticStore() {
  const store = openStore(':memory:');
  let laps = null;
  const pipeline = replay(syntheticPackets(), {
    pipelineOptions: { store },
    onTick: ({ pipeline: p }) => {
      if (!laps) laps = createLapRecorder(p.fieldModel, { raceId: 'x' });
      laps.sync();
    },
  });
  laps.sync();
  pipeline.flush();
  return { store, db: store.db, lapRows: laps.rows(), pipeline };
}
const one = (db, sql, ...a) => db.prepare(sql).pluck().get(...a);

test('store: a replayed race is one session, its cars and every completed lap', () => {
  const { db, lapRows } = syntheticStore();
  const s = db.prepare('SELECT * FROM session').all();
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].is_race, 1);
  assert.ok(s[0].track && s[0].total_laps > 0, JSON.stringify(s[0]));

  assert.strictEqual(one(db, 'SELECT count(*) FROM car WHERE is_player = 1'), 1);
  assert.ok(one(db, "SELECT count(*) FROM car WHERE driver IS NULL OR driver = ''") === 0, 'every car is named');

  // The same laps as the lap dataset (datasets/laps.csv), lap for lap.
  const stored = db.prepare('SELECT car_idx, lap_num, lap_ms, pit, neutralised, compound, tyre_age, position FROM lap ORDER BY car_idx, lap_num').all();
  assert.strictEqual(stored.length, lapRows.length);
  assert.deepStrictEqual(
    stored.map((r) => [r.car_idx, r.lap_num, r.lap_ms, !!r.pit, !!r.neutralised, r.compound, r.tyre_age, r.position]),
    lapRows.map((r) => [r.carIndex, r.lapNum, r.lapMs, r.pit, r.neutralised, r.compound, r.tyreAge, r.position]),
  );
});

test('store: the session holds what happened, not only the laps', () => {
  const { db } = syntheticStore();
  // The race's VSC (deployed and ended) and the overtakes, each on a lap.
  assert.strictEqual(one(db, "SELECT count(*) FROM event WHERE code = 'SCAR'"), 2);
  assert.strictEqual(one(db, 'SELECT count(*) FROM event WHERE lap_num IS NULL'), 0);
  // What the engineer called and said, on the player's lap at the time.
  assert.ok(one(db, 'SELECT count(*) FROM engineer_call') > 0);
  assert.ok(one(db, "SELECT count(*) FROM engineer_call WHERE action NOT IN ('PUSH','HOLD','BOX','PIT','PREP')") === 0);
  assert.ok(one(db, 'SELECT count(*) FROM radio_message') > 0);
  // Stints: one per set the player ran, laps adding up to the laps driven.
  const playerLaps = one(db, 'SELECT count(*) FROM lap JOIN car USING (session_id, car_idx) WHERE is_player = 1');
  assert.strictEqual(one(db, 'SELECT sum(end_lap - start_lap + 1) FROM stint JOIN car USING (session_id, car_idx) WHERE is_player = 1'), playerLaps);
  // The player's inputs round each traced lap, in order along the lap.
  const traced = db.prepare('SELECT lap_num, count(*) n, min(distance_m) lo, max(distance_m) hi FROM trace_point GROUP BY car_idx, lap_num').all();
  assert.ok(traced.length > 0);
  for (const t of traced) assert.ok(t.n > 50 && t.lo < 60 && t.hi > 1000, JSON.stringify(t));
  assert.strictEqual(one(db, 'SELECT count(*) FROM weather_sample') > 0, true);
});

test('store: keys hold, and writing the same session again replaces it', () => {
  const { store, db, pipeline } = syntheticStore();
  assert.deepStrictEqual(db.pragma('foreign_key_check'), []);
  assert.strictEqual(db.pragma('integrity_check', { simple: true }), 'ok');
  const count = () => ['session', 'car', 'lap', 'stint', 'event', 'engineer_call', 'radio_message', 'trace_point'].map((t) => one(db, `SELECT count(*) FROM ${t}`));
  const before = count();
  // A second write of the same session (shutdown after the results screen) replaces it, quietly.
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    pipeline.flush();
  } finally {
    console.warn = warn;
  }
  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(count(), before);
  store.close();
});

// A minimal field: the player (car 0) alone, on `state.lap` at game time `state.t`.
function fakeField(state, lapHistory, events = []) {
  const car = () => ({ carIndex: 0, lapHistory: lapHistory.filter((l) => l.lapNum < state.lap), participant: { name: 'ME' }, lapData: { carPosition: 1, currentLapNum: state.lap, resultStatus: 2, numPitStops: 0, deltaToRaceLeaderInMS: 0 } });
  const field = {
    getGeneration: () => 1, playerIndex: () => 0, getSessionTime: () => state.t,
    getSession: () => ({ sessionType: 15, trackId: 13, totalLaps: 10, trackLength: 5800 }),
    getRecentEvents: () => events, orderedByPosition: () => [car()], getCar: () => car(),
    getClassification: () => null, getSessionUID: () => 42n,
  };
  return field;
}

test('store: a flashback takes back the laps, events and calls it undid', () => {
  const { createSessionRecorder } = require('../src/data/sessionRecorder');
  // On lap 5 at 300 s, then back to lap 4 at 250 s.
  const state = { lap: 5, t: 300 };
  const events = [];
  const lapHistory = [1, 2, 3, 4].map((n) => ({ lapNum: n, lapMs: 90000, pit: false, neutralised: false, compound: 17, tyreAge: n }));
  const field = fakeField(state, lapHistory, events);
  const written = [];
  const rec = createSessionRecorder(field, { write: (s) => written.push(s), debrief: null });
  events.push({ code: 'OVTK', name: 'Overtake', overtakerIdx: 0, overtakenIdx: 1, seq: 1, sessionTime: 280 });
  rec.sync({ strategy: { call: { action: 'BOX', kind: 'tyres', reason: 'Box' } }, insights: [] });
  Object.assign(state, { lap: 4, t: 250 }); // the flashback
  rec.sync({ strategy: { call: { action: 'PUSH', kind: 'ok', reason: 'Push' } }, insights: [] });
  rec.flush();
  const [s] = written;
  assert.deepStrictEqual(s.laps.map((l) => l.lapNum), [1, 2, 3]);
  assert.deepStrictEqual(s.events, []);
  assert.deepStrictEqual(s.calls.map((c) => c.action), ['PUSH']);
});

test('store: a stop for the same compound starts a new stint', () => {
  const { createSessionRecorder } = require('../src/data/sessionRecorder');
  const ages = [1, 2, 3, 0, 1, 2]; // mediums, then fresh mediums from lap 4
  const lapHistory = ages.map((tyreAge, k) => ({ lapNum: k + 1, lapMs: 90000, pit: k === 3, neutralised: false, compound: 17, tyreAge }));
  const written = [];
  const rec = createSessionRecorder(fakeField({ lap: 7, t: 600 }, lapHistory), { write: (s) => written.push(s) });
  rec.sync({});
  rec.flush();
  assert.deepStrictEqual(written[0].stints.map((t) => [t.stintNum, t.compound, t.startLap, t.endLap]), [[1, 17, 1, 3], [2, 17, 4, 6]]);
});
