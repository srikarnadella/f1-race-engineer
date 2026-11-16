// Corner trends at a track: each session's best clean lap against your fastest lap there, corner by corner (analysis/lapCompare.js
// does the comparing), so a corner that is getting closer to your best, or slipping away from it, shows up across sessions.
// The sessions differ in fuel, tyres and weather, so a small change is noise; the view says so.
const { compareLaps } = require('../analysis/lapCompare');
const { sessionStart } = require('../lib/sessionTime');

const MIN_POINTS = 100; // a trace this short is not a lap
const SIGNIFICANT_S = 0.05; // a corner's change smaller than this is not called out
const round = (v) => Math.round(v * 1000) / 1000;
const day = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// laps: [{ id, startedAt, name, lapNum, lapMs, points }] with points as the lap compare takes them
// ([distance, ms, speed, throttle, brake, steer, gear]). Oldest first in the answer.
function cornerSeries(laps) {
  const usable = laps.filter((l) => Array.isArray(l.points) && l.points.length >= MIN_POINTS).sort((a, b) => a.startedAt - b.startedAt);
  const empty = { sessions: usable.map((l) => ({ id: l.id, startedAt: l.startedAt, date: day(l.startedAt), name: l.name, lapMs: l.lapMs, isRef: false })), corners: [], headline: { improved: [], slipped: [] } };
  if (usable.length < 2) return empty;
  const ref = usable.reduce((best, l) => (l.lapMs < best.lapMs ? l : best));
  const per = usable.map((l) => (l === ref ? null : compareLaps(ref, l)));
  const first = per.find((c) => c); // the reference's own braking zones are the same in every comparison
  if (!first || !first.corners.length) return empty;
  const corners = first.corners.map((c, i) => {
    const deltas = per.map((cmp) => (cmp ? round(cmp.corners[i].timeS) : 0));
    return { corner: c.corner, atM: c.atM, deltas, change: round(deltas[deltas.length - 1] - deltas[0]) };
  });
  const rank = (sign) => corners.filter((c) => sign * c.change >= SIGNIFICANT_S).sort((a, b) => sign * b.change - sign * a.change).slice(0, 3).map((c) => ({ corner: c.corner, atM: c.atM, change: c.change }));
  return {
    sessions: usable.map((l) => ({ id: l.id, startedAt: l.startedAt, date: day(l.startedAt), name: l.name, lapMs: l.lapMs, isRef: l === ref })),
    corners,
    headline: { improved: rank(-1), slipped: rank(1) },
  };
}

// The player's best clean lap in each session at a track, with its trace (the laps the store kept traces for only).
function bestLaps(db, track) {
  const sessions = db.prepare(`SELECT s.session_id, s.session_name, s.started_at_ms, k.name AS capture, c.car_idx
    FROM session s JOIN capture k USING (capture_id) JOIN car c ON c.session_id = s.session_id AND c.is_player = 1
    WHERE s.track = ? ORDER BY s.started_at_ms`).all(track);
  const candidates = db.prepare(`SELECT lap_num, lap_ms FROM lap WHERE session_id = ? AND car_idx = ? AND pit = 0 AND neutralised = 0 AND valid IS NOT 0 AND lap_ms > 0 ORDER BY lap_ms LIMIT 6`);
  const trace = db.prepare('SELECT distance_m, lap_time_ms, speed_kmh, throttle, brake, steer, gear FROM trace_point WHERE session_id = ? AND car_idx = ? AND lap_num = ? ORDER BY distance_m');
  const out = [];
  for (const s of sessions) {
    for (const l of candidates.all(s.session_id, s.car_idx)) {
      const rows = trace.all(s.session_id, s.car_idx, l.lap_num);
      if (rows.length < MIN_POINTS) continue; // the fastest lap with a trace
      out.push({
        id: Number(s.session_id), startedAt: sessionStart(Number(s.started_at_ms), String(s.capture)) ?? Number(s.started_at_ms), name: String(s.session_name),
        lapNum: Number(l.lap_num), lapMs: Number(l.lap_ms),
        points: rows.map((r) => [Number(r.distance_m), Number(r.lap_time_ms), Number(r.speed_kmh), Number(r.throttle), Number(r.brake), Number(r.steer), Number(r.gear)]),
      });
      break;
    }
  }
  return out;
}

const cornerTrends = (db, track) => ({ track, ...cornerSeries(bestLaps(db, track)) });

// Tracks with at least two sessions that have a lap trace: the ones a trend can be drawn for.
function cornerTracks(db) {
  return db.prepare(`SELECT s.track, count(*) AS sessions FROM session s
    WHERE s.track IS NOT NULL AND EXISTS (SELECT 1 FROM trace_point t JOIN car c ON c.session_id = t.session_id AND c.car_idx = t.car_idx AND c.is_player = 1 WHERE t.session_id = s.session_id)
    GROUP BY s.track HAVING count(*) >= 2 ORDER BY s.track`).all().map((r) => ({ track: String(r.track), sessions: Number(r.sessions) }));
}

module.exports = { cornerSeries, cornerTrends, cornerTracks };
