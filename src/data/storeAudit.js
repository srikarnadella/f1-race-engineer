// The calls audit from the race store (race.db), for sessions whose saved debrief predates the calls
// being kept with it. race.db has every car's laps and the engineer's calls for each session, and
// re-processing a recording (npm run db) fills them for old races too. Graded by the same auditCalls.
const { auditCalls, stopsOf } = require('../analysis/callsAudit');
const { sessionStart } = require('../llm/tools');
const { TRACKS } = require('../udp/gameIds');

const MATCH_MS = 20 * 60 * 1000; // a debrief and a race.db session this close in start time are one

// The race.db session for a debrief summary: by the game's session id, else same track, type and a
// start time within 20 minutes. Returns its session_id or null.
function findStoreSession(db, { uid, track, sessionType, startedAt }) {
  if (uid) {
    const hit = db.prepare('SELECT session_id FROM session WHERE session_uid = ?').get(String(uid));
    if (hit) return hit.session_id;
  }
  const rows = db.prepare('SELECT s.session_id, s.track, s.track_id, s.session_type, s.started_at_ms, k.name AS capture FROM session s JOIN capture k USING (capture_id) WHERE s.session_type = ?').all(sessionType);
  let best = null;
  for (const r of rows) {
    const name = r.track || TRACKS[r.track_id] || '';
    if (track && name !== track) continue;
    const at = sessionStart(Number(r.started_at_ms), r.capture) ?? Number(r.started_at_ms);
    const off = Math.abs(at - startedAt);
    if (off <= MATCH_MS && (!best || off < best.off)) best = { id: r.session_id, off };
  }
  return best ? best.id : null;
}

// Every car's laps and the calls of one race.db session, graded.
function auditFromStore(db, sessionId) {
  const total = db.prepare('SELECT total_laps FROM session WHERE session_id = ?').get(sessionId);
  const laps = db.prepare(`SELECT l.car_idx, l.lap_num, l.lap_ms, l.pit, l.neutralised, l.compound, l.tyre_age, l.position, l.num_pit_stops, c.is_player
    FROM lap l JOIN car c USING (session_id, car_idx) WHERE l.session_id = ? ORDER BY l.car_idx, l.lap_num`).all(sessionId).map((l) => ({
    carIndex: l.car_idx, lapNum: l.lap_num, lapMs: l.lap_ms, pit: !!l.pit, neutralised: !!l.neutralised, compound: l.compound,
    tyreAge: l.tyre_age, position: l.position, numPitStops: l.num_pit_stops, isPlayer: !!l.is_player, totalLaps: total ? total.total_laps : null,
  }));
  const calls = db.prepare('SELECT lap_num, action, kind, reason FROM engineer_call WHERE session_id = ? ORDER BY seq').all(sessionId)
    .map((c) => ({ lapNum: c.lap_num, action: c.action, kind: c.kind, reason: c.reason }));
  return { ...auditCalls(calls, laps), stops: stopsOf(laps), source: 'race.db' };
}

module.exports = { findStoreSession, auditFromStore };
