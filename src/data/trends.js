// Race analysis, All races (roadmap R5): across every race in the race store, your pace per track
// over time, tyre wear per track and tyre, and how often the engineer's calls were right.
const { median } = require('../lib/stats');
const { sessionStart } = require('../llm/tools');
const { auditFromStore } = require('./storeAudit');

const TYRE = { 16: 'soft', 17: 'medium', 18: 'hard', 7: 'inter', 8: 'wet' };
const day = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function trends(db) {
  const sessions = db.prepare(`SELECT s.session_id, s.track, s.session_name, s.started_at_ms, k.name AS capture, c.car_idx, c.grid_position, c.finish_position
    FROM session s JOIN capture k USING (capture_id) JOIN car c ON c.session_id = s.session_id AND c.is_player = 1 WHERE s.is_race = 1`).all();
  const lapsOf = db.prepare('SELECT lap_num, lap_ms, pit, neutralised, valid, compound, tyre_age, wear_max_pct FROM lap WHERE session_id = ? AND car_idx = ? ORDER BY lap_num');

  const byTrack = new Map();
  const wear = new Map(); // track|tyre -> per-lap wear steps
  const races = [];
  for (const s of sessions) {
    const at = sessionStart(Number(s.started_at_ms), s.capture) ?? Number(s.started_at_ms);
    const laps = lapsOf.all(s.session_id, s.car_idx);
    // Clean laps: not the start, not a pit or safety-car lap, not invalid.
    const clean = laps.filter((l) => l.lap_num > 1 && !l.pit && !l.neutralised && l.valid !== 0 && l.lap_ms > 0).map((l) => l.lap_ms);
    if (!clean.length) continue;
    const race = { sessionId: s.session_id, type: s.session_name, date: day(at), at, grid: s.grid_position, finish: s.finish_position, laps: laps.length, bestMs: Math.min(...clean), typicalMs: Math.round(median(clean)) };
    races.push({ ...race, track: s.track });
    if (!byTrack.has(s.track)) byTrack.set(s.track, []);
    byTrack.get(s.track).push(race);
    // Wear a lap: the step between consecutive laps on the same set (no stop between them).
    for (let i = 1; i < laps.length; i++) {
      const a = laps[i - 1];
      const b = laps[i];
      if (b.pit || a.pit || b.compound !== a.compound || b.tyre_age !== a.tyre_age + 1 || a.wear_max_pct == null || b.wear_max_pct == null) continue;
      const key = `${s.track}|${TYRE[b.compound] || 'unknown'}`;
      if (!wear.has(key)) wear.set(key, []);
      wear.get(key).push(b.wear_max_pct - a.wear_max_pct);
    }
  }

  const tracks = [...byTrack].map(([track, rs]) => {
    rs.sort((a, b) => a.at - b.at);
    return { track, races: rs.map(({ at, ...r }) => r), bestEverMs: Math.min(...rs.map((r) => r.bestMs)), improvedMs: rs.length > 1 ? rs[0].bestMs - rs[rs.length - 1].bestMs : null,
      // Race pace says more than one lap: the typical (median clean) lap, first race against latest.
      typicalImprovedMs: rs.length > 1 ? rs[0].typicalMs - rs[rs.length - 1].typicalMs : null };
  }).sort((a, b) => b.races.length - a.races.length || a.track.localeCompare(b.track));

  // The calls, graded race by race as the Strategy view grades them.
  const graded = races.sort((a, b) => a.at - b.at).map((r) => {
    const a = auditFromStore(db, r.sessionId);
    return { sessionId: r.sessionId, track: r.track, date: r.date, ...a.summary };
  }).filter((r) => r.calls > 0);
  const total = graded.reduce((t, r) => ({ calls: t.calls + r.calls, graded: t.graded + r.graded, right: t.right + r.right, wrong: t.wrong + r.wrong, unclear: t.unclear + r.unclear }), { calls: 0, graded: 0, right: 0, wrong: 0, unclear: 0 });

  return {
    tracks,
    wear: [...wear].map(([k, steps]) => {
      const [track, tyre] = k.split('|');
      return { track, tyre, pctPerLap: Math.round(median(steps) * 100) / 100, laps: steps.length };
    }).filter((w) => w.laps >= 3).sort((a, b) => a.track.localeCompare(b.track) || a.tyre.localeCompare(b.tyre)),
    calls: { races: graded, total },
  };
}

module.exports = { trends };
