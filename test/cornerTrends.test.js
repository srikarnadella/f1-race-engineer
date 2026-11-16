const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/data/store');
const { cornerSeries, cornerTrends, cornerTracks } = require('../src/data/cornerTrends');

// Corner trends at a track: each session's best clean lap against your fastest lap there, corner by corner, so a change in a corner
// shows up as that corner getting closer to (or further from) your best. Handcrafted 3 km laps with two corners, 1.0 and 2.0 km.
function lap(apex1, apex2) {
  const points = [];
  let t = 0;
  const speedAt = (d) => {
    const dip = (c, apex) => (d >= c - 100 && d < c ? 250 - ((d - (c - 100)) / 100) * (250 - apex) : d >= c && d <= c + 100 ? apex : null);
    return dip(1000, apex1) ?? dip(2000, apex2) ?? 250;
  };
  for (let d = 0; d <= 3000; d += 10) {
    const s = speedAt(d);
    const braking = (d >= 900 && d < 1000) || (d >= 1900 && d < 2000);
    points.push([d, Math.round(t), s, braking ? 0 : 1, braking ? 1 : 0, 0, 4]);
    t += (10 / (s / 3.6)) * 1000;
  }
  return { points, lapMs: Math.round(t) };
}
const session = (id, startedAt, name, laps) => ({ id, startedAt, name, lapNum: 5, ...laps });

test('series: your fastest lap is the reference at zero, the others are measured against it corner by corner', () => {
  const fast = session(1, Date.UTC(2026, 9, 1), 'Qualifying', lap(100, 100));
  const slow2 = session(2, Date.UTC(2026, 9, 8), 'Race', lap(100, 80)); // loses time in the second corner only
  const out = cornerSeries([slow2, fast]);
  assert.deepStrictEqual(out.sessions.map((s) => [s.name, s.isRef]), [['Qualifying', true], ['Race', false]], 'oldest first');
  assert.strictEqual(out.corners.length, 2);
  assert.deepStrictEqual(out.corners.map((c) => c.deltas[0]), [0, 0], 'the reference against itself');
  assert.ok(Math.abs(out.corners[0].deltas[1]) < 0.03, 'corner 1 is the same');
  assert.ok(out.corners[1].deltas[1] > 0.05, `corner 2 lost time: ${out.corners[1].deltas[1]}`);
});

test('series: a corner that got closer to your best over the sessions says so, and one that slipped says that', () => {
  const ref = session(1, Date.UTC(2026, 9, 15), 'Race 2', lap(100, 100));
  const early = session(2, Date.UTC(2026, 9, 1), 'Practice', lap(70, 100)); // slow in corner 1 at first
  const mid = session(3, Date.UTC(2026, 9, 8), 'Qualifying', lap(85, 100));
  const out = cornerSeries([ref, early, mid]);
  const c1 = out.corners[0];
  assert.ok(c1.deltas[0] > c1.deltas[1] && c1.deltas[1] > c1.deltas[2] - 0.001, `closing in: ${c1.deltas.join(', ')}`);
  assert.ok(c1.change < -0.05, 'the change from the first to the latest is a gain');
  assert.ok(out.headline.improved.length >= 1);
  assert.strictEqual(out.headline.improved[0].corner, 1);
});

test('series: one session, or sessions with no usable trace, give nothing to compare and say so', () => {
  assert.deepStrictEqual(cornerSeries([]).corners, []);
  assert.deepStrictEqual(cornerSeries([session(1, 1, 'Race', lap(100, 100))]).corners, []);
  assert.deepStrictEqual(cornerSeries([session(1, 1, 'A', { points: [], lapMs: 90000 }), session(2, 2, 'B', { points: [[0, 0, 1, 1, 0, 0, 1]], lapMs: 91000 })]).corners, []);
});

// ---- from the store ----
function addSession(db, { id, track = 'Spa', trackId = 10, startedAt, name, laps }) {
  db.exec(`INSERT OR IGNORE INTO capture (name) VALUES ('2026-10-0${id}_120000')`);
  const cap = db.prepare("SELECT capture_id FROM capture WHERE name = ?").get(`2026-10-0${id}_120000`).capture_id;
  db.prepare('INSERT INTO session (session_id, session_uid, capture_id, track_id, track, session_type, session_name, is_race, total_laps, track_length_m, player_car_idx, started_at_ms, ended_at_ms, official) VALUES (?, ?, ?, ?, ?, 5, ?, 0, 0, 3000, 0, ?, ?, 1)').run(id, `uid${id}`, cap, trackId, track, name, startedAt, startedAt + 1);
  db.prepare('INSERT INTO car (session_id, car_idx, driver, is_player) VALUES (?, 0, ?, 1)').run(id, 'YOU');
  for (const l of laps) {
    db.prepare('INSERT INTO lap (session_id, car_idx, lap_num, lap_ms, valid, pit, neutralised) VALUES (?, 0, ?, ?, ?, ?, ?)').run(id, l.lapNum, l.lapMs, l.valid ?? 1, l.pit ?? 0, l.neutralised ?? 0);
    for (const p of l.points || []) db.prepare('INSERT INTO trace_point (session_id, car_idx, lap_num, distance_m, lap_time_ms, speed_kmh, throttle, brake, steer, gear) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, l.lapNum, ...p);
  }
}

test('store: the best clean lap of each session at the track, with its trace, is compared; a faster lap that was invalid or in the pits is not used', () => {
  const store = openStore(':memory:');
  const a = lap(100, 100);
  const b = lap(100, 80);
  addSession(store.db, { id: 1, startedAt: 1000, name: 'Qualifying', laps: [{ lapNum: 3, lapMs: a.lapMs - 5000, valid: 0, points: a.points }, { lapNum: 4, lapMs: a.lapMs, points: a.points }] });
  addSession(store.db, { id: 2, startedAt: 2000, name: 'Race', laps: [{ lapNum: 2, lapMs: b.lapMs, points: b.points }, { lapNum: 3, lapMs: b.lapMs - 3000, pit: 1, points: b.points }] });
  addSession(store.db, { id: 3, track: 'Monaco', trackId: 5, startedAt: 3000, name: 'Race', laps: [{ lapNum: 2, lapMs: b.lapMs, points: b.points }] });
  const out = cornerTrends(store.db, 'Spa');
  assert.strictEqual(out.sessions.length, 2);
  assert.deepStrictEqual(out.sessions.map((s) => s.lapMs), [a.lapMs, b.lapMs], 'the invalid lap and the pit lap were not the best');
  assert.strictEqual(out.corners.length, 2);
  assert.ok(out.corners[1].deltas[1] > 0.05);
  assert.deepStrictEqual(cornerTrends(store.db, 'Monaco').corners, [], 'one session is not a trend');
  assert.deepStrictEqual(cornerTracks(store.db), [{ track: 'Spa', sessions: 2 }]);
  assert.deepStrictEqual(cornerTrends(store.db, 'Nowhere').corners, []);
});
