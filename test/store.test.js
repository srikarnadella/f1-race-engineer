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
const one = (db, sql, ...a) => Object.values(db.prepare(sql).get(...a))[0];

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
  assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.strictEqual(one(db, 'PRAGMA integrity_check'), 'ok');
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

test('store: deleting a session removes it and everything under it', () => {
  const { store, db } = syntheticStore();
  const [{ session_uid: uid }] = db.prepare('SELECT session_uid FROM session').all();
  assert.strictEqual(store.deleteSession(uid), true);
  for (const t of ['session', 'car', 'lap', 'stint', 'event', 'engineer_call', 'radio_message', 'trace_point', 'weather_sample']) {
    assert.strictEqual(one(db, `SELECT count(*) FROM ${t}`), 0, t);
  }
  assert.strictEqual(store.deleteSession(uid), false);
});

test('store: what the car did at each corner (locks, wheelspin, understeer) and the bias and diff you ran (coaching, step 2)', () => {
  const { db } = syntheticStore();
  // The synthetic race: the front-left locks into corner 2 every lap, the rears spin out of corner 1
  // from lap 16, the car understeers out of corner 3 from lap 17; bias 56%, on-throttle diff 60%.
  const rows = db.prepare('SELECT lap_num, distance_m, kind, wheel, brake_bias, diff_on_throttle FROM corner_issue ORDER BY lap_num, distance_m').all();
  const kinds = (k) => rows.filter((r) => r.kind === k);
  assert.ok(kinds('front_lock').length >= 3, JSON.stringify(rows.slice(0, 5)));
  assert.ok(kinds('front_lock').every((r) => r.wheel === 'FL' && r.brake_bias === 56));
  assert.ok(kinds('wheelspin').length >= 1 && kinds('wheelspin').every((r) => r.lap_num >= 16 && r.diff_on_throttle === 60));
  assert.ok(kinds('understeer').every((r) => r.lap_num >= 17));
  const setting = db.prepare('SELECT * FROM car_setting').all();
  assert.ok(setting.length >= 1);
  assert.deepStrictEqual([setting[0].brake_bias, setting[0].diff_on_throttle], [56, 60]);
});

test('store: every telemetry point also keeps the battery charge and the deploy mode (coaching, step 3)', () => {
  const { db } = syntheticStore();
  const pts = db.prepare('SELECT ers_pct, ers_mode FROM trace_point JOIN car USING (session_id, car_idx) WHERE is_player = 1').all();
  assert.ok(pts.length > 100);
  assert.ok(pts.every((p) => p.ers_pct >= 0 && p.ers_pct <= 100), 'a percentage of the 4 MJ store');
  assert.ok(new Set(pts.map((p) => Math.round(p.ers_pct))).size > 3, 'it moves round the lap');
  assert.ok(pts.every((p) => Number.isInteger(p.ers_mode)));
});

test('store: an existing race.db gains the battery columns when it is opened', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-old-'));
  const file = path.join(dir, 'race.db');
  try {
    // A trace_point table as it was before the battery columns.
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE trace_point (session_id INTEGER NOT NULL, car_idx INTEGER NOT NULL, lap_num INTEGER NOT NULL, distance_m REAL NOT NULL, lap_time_ms INTEGER NOT NULL, speed_kmh INTEGER NOT NULL, throttle REAL NOT NULL, brake REAL NOT NULL, steer REAL NOT NULL, gear INTEGER NOT NULL, PRIMARY KEY (session_id, car_idx, lap_num, distance_m)) WITHOUT ROWID');
    old.close();
    const store = openStore(file);
    const cols = store.db.prepare('PRAGMA table_info(trace_point)').all().map((c) => c.name);
    store.close();
    assert.ok(cols.includes('ers_pct') && cols.includes('ers_mode'), cols.join(','));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: a race is written when the final classification arrives, not only when the next session starts or the app closes', () => {
  const { createSessionRecorder } = require('../src/data/sessionRecorder');
  const lapHistory = [1, 2, 3].map((n) => ({ lapNum: n, lapMs: 90000, pit: false, neutralised: false, compound: 17, tyreAge: n }));
  const field = fakeField({ lap: 4, t: 400 }, lapHistory);
  let classification = null;
  field.getClassification = () => classification;
  const written = [];
  const rec = createSessionRecorder(field, { write: (s) => written.push(s) });
  rec.sync({});
  rec.sync({});
  assert.strictEqual(written.length, 0, 'mid-race nothing is written');
  classification = { cars: [{ position: 1, gridPosition: 2, numLaps: 3, resultStatus: 3, numPitStops: 0, points: 25, bestLapTimeInMS: 90000, totalRaceTimeS: 270, penaltiesTimeS: 0 }] };
  rec.sync({});
  assert.strictEqual(written.length, 1, 'written the tick the result arrives');
  assert.strictEqual(written[0].official, true);
  rec.sync({});
  rec.sync({});
  assert.strictEqual(written.length, 1, 'once, while the results screen keeps ticking');
});
