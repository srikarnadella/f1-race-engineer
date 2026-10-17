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

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// A lap this much slower than the car's own typical lap is a spin, a crash,
// or a safety-car lap the flags missed - not pace. The tyre model and the
// pace figures both drop them.
const SLOW_LAP_FACTOR = 1.07;
function withoutSlowLaps(laps) {
  const typical = median(laps.map((l) => l.lapMs));
  return typical == null ? laps : laps.filter((l) => l.lapMs <= typical * SLOW_LAP_FACTOR);
}

module.exports = { RACE_SESSION_TYPES, isRacing, raceLapsLeft, median, withoutSlowLaps };
