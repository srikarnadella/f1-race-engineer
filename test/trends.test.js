const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/data/store');
const { trends } = require('../src/data/trends');

// Race analysis, All races (roadmap R5): your pace per track over time, tyre wear per track, and how
// often the calls were right, across every race in race.db.
let uid = 0;
function race(db, { track, day, laps, finish = 5, grid = 8, wear = 2, calls = [] }) {
  uid++;
  const cap = db.prepare("INSERT INTO capture (name) VALUES ('live') ON CONFLICT (name) DO UPDATE SET name = name RETURNING capture_id").get().capture_id;
  const startedAt = Date.UTC(2026, 9, day, 18);
  const sid = db.prepare(`INSERT INTO session (session_uid, capture_id, track_id, track, session_type, session_name, is_race, total_laps, track_length_m, player_car_idx, started_at_ms, ended_at_ms, official)
    VALUES (?, ?, 0, ?, 15, 'Race', 1, ?, 5000, 0, ?, ?, 1)`).run(String(uid), cap, track, laps.length, startedAt, startedAt + 3600e3).lastInsertRowid;
  db.prepare('INSERT INTO car (session_id, car_idx, driver, is_player, grid_position, finish_position, laps_completed, best_lap_ms, num_pit_stops) VALUES (?, 0, ?, 1, ?, ?, ?, ?, 0)').run(sid, 'YOU', grid, finish, laps.length, Math.min(...laps));
  laps.forEach((ms, i) => db.prepare('INSERT INTO lap (session_id, car_idx, lap_num, lap_ms, valid, pit, neutralised, compound, tyre_age, position, num_pit_stops, wear_max_pct) VALUES (?, 0, ?, ?, 1, 0, 0, 17, ?, ?, 0, ?)')
    .run(sid, i + 1, ms, i, finish, i * wear));
  calls.forEach((c, k) => db.prepare('INSERT INTO engineer_call VALUES (?, ?, ?, ?, ?, ?, ?)').run(sid, k + 1, k * 60, c.lap, c.action, c.kind, null));
  return sid;
}

test('trends: per track, each race\'s best and typical lap in date order, and how much faster you got', () => {
  const store = openStore(':memory:');
  race(store.db, { track: 'Spa', day: 10, laps: [110000, 106000, 106400, 106200] });
  race(store.db, { track: 'Spa', day: 20, laps: [109000, 105500, 105700, 105600] });
  race(store.db, { track: 'Monza', day: 15, laps: [86000, 82000, 82300] });
  const t = trends(store.db);
  const spa = t.tracks.find((x) => x.track === 'Spa');
  assert.deepStrictEqual(spa.races.map((r) => r.bestMs), [106000, 105500]);
  assert.strictEqual(spa.races[0].typicalMs, 106200, 'the median clean lap (lap 1 is the start)');
  assert.strictEqual(spa.improvedMs, 500);
  assert.strictEqual(t.tracks.find((x) => x.track === 'Monza').improvedMs, null, 'one race: nothing to compare');
  assert.deepStrictEqual(t.tracks.map((x) => x.track), ['Spa', 'Monza'], 'most raced first');
});

test('trends: adding a race moves only that track\'s numbers (roadmap R5)', () => {
  const store = openStore(':memory:');
  race(store.db, { track: 'Spa', day: 10, laps: [110000, 106000, 106400] });
  race(store.db, { track: 'Monza', day: 15, laps: [86000, 82000, 82300] });
  const before = trends(store.db);
  race(store.db, { track: 'Spa', day: 25, laps: [109000, 104000, 104500] });
  const after = trends(store.db);
  assert.deepStrictEqual(after.tracks.find((x) => x.track === 'Monza'), before.tracks.find((x) => x.track === 'Monza'));
  assert.notDeepStrictEqual(after.tracks.find((x) => x.track === 'Spa'), before.tracks.find((x) => x.track === 'Spa'));
});

test('trends: tyre wear a lap per track and tyre, from your laps on the same set', () => {
  const store = openStore(':memory:');
  race(store.db, { track: 'Spa', day: 10, laps: [110000, 106000, 106400, 106200, 106300], wear: 3 });
  const w = trends(store.db).wear.find((x) => x.track === 'Spa' && x.tyre === 'medium');
  assert.strictEqual(w.pctPerLap, 3);
  assert.strictEqual(w.laps, 4);
});

test('trends: how often the calls were right, race by race and in all', () => {
  const store = openStore(':memory:');
  race(store.db, { track: 'Spa', day: 10, laps: [110000, 106000, 106400], calls: [{ lap: 1, action: 'HOLD', kind: 'neutralised' }] });
  const t = trends(store.db);
  assert.strictEqual(t.calls.races.length, 1);
  assert.ok('right' in t.calls.total && 'graded' in t.calls.total);
});
