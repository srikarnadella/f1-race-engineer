const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/data/store');
const { trends } = require('../src/data/trends');

// The race start report: grid slot, position after the first lap, places gained or lost, across your races (the All races view).
function race(db, { id, track = 'Spa', startedAt, grid, lap1, finish, laps = 5, type = 15 }) {
  db.exec(`INSERT OR IGNORE INTO capture (name) VALUES ('live')`);
  const cap = db.prepare("SELECT capture_id FROM capture WHERE name = 'live'").get().capture_id;
  db.prepare('INSERT INTO session (session_id, session_uid, capture_id, track_id, track, session_type, session_name, is_race, total_laps, track_length_m, player_car_idx, started_at_ms, ended_at_ms, official) VALUES (?, ?, ?, 10, ?, ?, ?, 1, ?, 3000, 0, ?, ?, 1)').run(id, `uid${id}`, cap, track, type, type === 16 ? 'Sprint' : 'Race', laps, startedAt, startedAt + 1);
  db.prepare('INSERT INTO car (session_id, car_idx, driver, is_player, grid_position, finish_position) VALUES (?, 0, ?, 1, ?, ?)').run(id, 'YOU', grid, finish);
  for (let n = 1; n <= laps; n++) {
    db.prepare('INSERT INTO lap (session_id, car_idx, lap_num, lap_ms, valid, pit, neutralised, position) VALUES (?, 0, ?, ?, 1, 0, 0, ?)').run(id, n, 90000 + n * 10, n === 1 ? lap1 : finish);
  }
}

test('starts: each race has its grid slot, its position after lap 1 and the places gained there, oldest first', () => {
  const db = openStore(':memory:').db;
  race(db, { id: 2, startedAt: Date.UTC(2026, 9, 10, 12), grid: 8, lap1: 5, finish: 3 });
  race(db, { id: 1, startedAt: Date.UTC(2026, 9, 1, 12), grid: 4, lap1: 7, finish: 6 });
  const { starts } = trends(db);
  assert.deepStrictEqual(starts.races.map((r) => [r.grid, r.lap1, r.gained, r.finish]), [[4, 7, -3, 6], [8, 5, 3, 3]]);
  assert.strictEqual(starts.races[0].track, 'Spa');
  assert.match(starts.races[0].date, /^2026-10-01$/);
});

test('starts: the summary says how many races, the average places gained on lap 1, and how often it went badly', () => {
  const db = openStore(':memory:').db;
  race(db, { id: 1, startedAt: 1_000_000_000_000, grid: 4, lap1: 7, finish: 6 });
  race(db, { id: 2, startedAt: 1_000_000_100_000, grid: 8, lap1: 5, finish: 3 });
  race(db, { id: 3, startedAt: 1_000_000_200_000, grid: 6, lap1: 6, finish: 6 });
  race(db, { id: 4, startedAt: 1_000_000_300_000, grid: 3, lap1: 6, finish: 5 });
  const { starts } = trends(db);
  assert.deepStrictEqual(starts.summary, { races: 4, avgGained: -0.8, lostTwoOrMore: 2, gainedAny: 1, best: 3, worst: -3 });
});

test('starts: a race with no grid slot or no lap 1 on record is left out rather than counted as zero', () => {
  const db = openStore(':memory:').db;
  race(db, { id: 1, startedAt: 1_000_000_000_000, grid: null, lap1: 5, finish: 4 });
  race(db, { id: 2, startedAt: 1_000_000_100_000, grid: 6, lap1: null, finish: 4 });
  race(db, { id: 3, startedAt: 1_000_000_200_000, grid: 6, lap1: 4, finish: 4 });
  const { starts } = trends(db);
  assert.strictEqual(starts.races.length, 1);
  assert.strictEqual(starts.summary.races, 1);
});

test('starts: nothing recorded gives an empty report, not an error', () => {
  const { starts } = trends(openStore(':memory:').db);
  assert.deepStrictEqual(starts, { races: [], summary: null });
});
