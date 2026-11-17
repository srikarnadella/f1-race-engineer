// Race-distance helpers shared by the insight rules, race analysis and
// weather, so "is this a race" and "how much is left" can't drift apart.

// F1 25 sessionType: 15/16/17 = race, race 2, race 3. Unknown (no Session
// packet yet) counts as a race so the rules aren't silently off.
const { SESSION_TYPES } = require('../udp/gameIds');

const RACE_SESSION_TYPES = new Set([15, 16, 17]);
const FORMATION_LAP = 3; // safetyCarStatus

function isRacing(session) {
  if (!session) return true;
  if (session.sessionType != null && !RACE_SESSION_TYPES.has(session.sessionType)) return false;
  return session.safetyCarStatus !== FORMATION_LAP;
}

// Race distance still to run, in laps, including the unfinished part of the
// current lap (fuel burns continuously, so a whole-lap count would jump by
// ~1 every time the line is crossed). Null outside a race under way.
function raceLapsLeft(session, lapData) {
  if (!session || !session.totalLaps || !lapData || !isRacing(session)) return null;
  const done = session.trackLength ? Math.max(0, Math.min(1, lapData.lapDistance / session.trackLength)) : 0;
  return session.totalLaps - (lapData.currentLapNum - 1) - done;
}

// The game calls a sprint "Race" (15) and the race after it "Race 2" (16). A weekend that had a sprint shootout is a
// sprint weekend: the game's weekend id is the same on every session of it.
// shortcut: weekends are remembered in memory only, so a sprint after an app restart is still "Race"; keep them on disk if that bites.
const SHOOTOUT_TYPES = new Set([10, 11, 12, 13, 14]);
const sprintWeekends = new Set();
function sessionName(session) {
  if (!session) return null;
  const { sessionType: type, weekendLinkIdentifier: weekend } = session;
  if (weekend && SHOOTOUT_TYPES.has(type)) sprintWeekends.add(weekend);
  if (weekend && sprintWeekends.has(weekend) && (type === 15 || type === 16)) return type === 15 ? 'Sprint' : 'Race';
  return SESSION_TYPES[type] || null;
}

module.exports = { RACE_SESSION_TYPES, isRacing, raceLapsLeft, sessionName };
