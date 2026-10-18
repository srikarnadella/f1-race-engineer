// Race-distance helpers shared by the insight rules, race analysis and
// weather, so "is this a race" and "how much is left" can't drift apart.

// F1 25 sessionType: 15/16/17 = race, race 2, race 3. Unknown (no Session
// packet yet) counts as a race so the rules aren't silently off.
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

module.exports = { RACE_SESSION_TYPES, isRacing, raceLapsLeft };
