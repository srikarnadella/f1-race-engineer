// Qualifying (and practice) mode: the race calls - gaps, defend, pit
// timing, fuel to the flag - mean nothing when the order is by best lap.
// What a qualifying engineer says instead: where this lap would put you,
// how far you are from pole and from the knockout line, how long is left
// and whether you'll make it back to the line to start another lap, and
// who's in the way on the road.

// F1 25/26 sessionType: 1-4 practice, 5-9 qualifying (Q1-Q3, short, one-shot),
// 10-14 sprint shootout (SQ1-SQ3, short, one-shot), 15-17 race, 18 time trial.
const NAMES = {
  1: 'Practice 1', 2: 'Practice 2', 3: 'Practice 3', 4: 'Short practice',
  5: 'Q1', 6: 'Q2', 7: 'Q3', 8: 'Short qualifying', 9: 'One-shot qualifying',
  10: 'SQ1', 11: 'SQ2', 12: 'SQ3', 13: 'Short shootout', 14: 'One-shot shootout',
  18: 'Time trial',
};
function sessionKind(sessionType) {
  if (sessionType >= 1 && sessionType <= 4) return 'practice';
  if (sessionType >= 5 && sessionType <= 14) return 'qualifying';
  if (sessionType === 18) return 'time trial';
  return null;
}
// The last place that goes through: Q1 drops half of those outside the top
// ten (5 of 20, 6 of 22), Q2 drops the rest of them. Short / one-shot and
// the final part have no cut.
function cutPosition(sessionType, cars) {
  if (sessionType === 5 || sessionType === 10) return 10 + Math.floor((cars - 10) / 2);
  if (sessionType === 6 || sessionType === 11) return 10;
  return null;
}

const STATUS = { 0: 'garage', 1: 'flying', 2: 'in', 3: 'out', 4: 'track' };
// An out or in lap runs about this much slower than a push lap.
const SLOW_LAP_FACTOR = 1.25;
const FALLBACK_LAP_MS = 90000;
// A car this close on the road can spoil (or be spoilt by) a push lap.
const TRAFFIC_M = 500;
// A cool-down lap reads as a flying lap to the game: this far down, the lap is gone.
const LAP_GONE_MS = 2000;
// Closer than this they are alongside - being passed, not in the way.
const ALONGSIDE_M = 30;

// A car's best valid lap this session, from its Session History.
function bestLapMs(car) {
  const h = car.sessionHistory;
  const l = h && h.bestLapNum > 0 ? h.laps[h.bestLapNum - 1] : null;
  return l && l.lapMs > 0 && l.valid ? l.lapMs : null;
}

// session: Session packet; cars: FieldModel ordered cars; player: one of them;
// delta: FieldModel.getPlayerDelta() (live delta to your best lap).
function qualifying({ session, cars, player, delta }) {
  const kind = session && sessionKind(session.sessionType);
  if (!kind || !player || !player.lapData) return null;
  const lap = player.lapData;
  const L = session.trackLength;
  const name = (c) => (c.participant && c.participant.name) || `Car ${c.carIndex}`;

  const times = cars.filter((c) => c.carIndex !== player.carIndex).map((c) => ({ car: c, ms: bestLapMs(c) })).filter((x) => x.ms != null).sort((a, b) => a.ms - b.ms);
  const myBest = bestLapMs(player) || delta.bestLapTimeInMS || null;
  const rankOf = (ms) => 1 + times.filter((x) => x.ms < ms).length;
  const position = myBest ? rankOf(myBest) : null;
  const pole = times[0] ? Math.min(times[0].ms, myBest || Infinity) : myBest;

  const cutPos = cutPosition(session.sessionType, cars.length);
  let cut = null;
  if (cutPos) {
    // The time to beat is whoever sits on the cut place among the others.
    const line = times[cutPos - 1] || null;
    cut = { position: cutPos, lineMs: line ? line.ms : null, marginMs: line && myBest ? myBest - line.ms : null };
  }

  const status = lap.pitStatus !== 0 ? 'garage' : STATUS[lap.driverStatus] || 'track';
  const lapMs = myBest || lap.lastLapTimeInMS || FALLBACK_LAP_MS;
  // This lap if it holds its current delta to your best.
  let projected = null;
  if (status === 'flying' && myBest && delta.deltaToBestMs != null) {
    const ms = myBest + delta.deltaToBestMs;
    projected = { lapMs: ms, position: rankOf(ms), improves: ms < myBest };
  }
  const lapGone = !!(projected && projected.lapMs - myBest > LAP_GONE_MS);

  // Getting to the line before the flag: a lap only counts if it's started in time.
  // Time trial has no session clock.
  const timeLeftS = kind === 'time trial' ? null : session.sessionTimeLeft;
  let toLine = null;
  if ((status === 'out' || status === 'track') && L && lap.lapDistance >= 0) {
    const startsInS = Math.round(((L - lap.lapDistance) / L) * lapMs * SLOW_LAP_FACTOR / 1000);
    toLine = timeLeftS == null ? { startsInS, spareS: null, makesIt: true } : { startsInS, spareS: timeLeftS - startsInS, makesIt: startsInS < timeLeftS };
  }
  // From the garage: each run is an out lap, a push lap and an in lap - and
  // the last one only has to start its push lap before the flag.
  const outMs = lapMs * SLOW_LAP_FACTOR;
  const runs = status === 'garage' && timeLeftS != null ? (timeLeftS * 1000 < outMs ? 0 : 1 + Math.floor((timeLeftS * 1000 - outMs) / (lapMs + 2 * outMs))) : null;

  // Who's in the way on the road.
  let traffic = null;
  const me = player.telemetry;
  if (L && lap.pitStatus === 0 && lap.lapDistance >= 0) {
    const mps = Math.max(20, ((me && me.speed) || 0) / 3.6);
    const onRoad = cars.filter((c) => c.carIndex !== player.carIndex && c.lapData && c.lapData.pitStatus === 0 && c.lapData.driverStatus !== 0 && c.lapData.lapDistance >= 0);
    const near = (sign) => onRoad
      .map((c) => ({ c, m: (((c.lapData.lapDistance - lap.lapDistance) * sign) % L + L) % L }))
      .filter((x) => x.m > ALONGSIDE_M && x.m < TRAFFIC_M)
      .sort((a, b) => a.m - b.m)[0];
    const view = (x) => x && { name: name(x.c), gapS: Math.round((x.m / mps) * 10) / 10, status: STATUS[x.c.lapData.driverStatus] };
    // On a push lap, a slow car ahead is the problem; on a slow lap, a push lap behind is.
    const pushing = status === 'flying' && !lapGone;
    const ahead = pushing ? near(1) : null;
    const behind = !pushing ? near(-1) : null;
    traffic = {
      ahead: ahead && ahead.c.lapData.driverStatus !== 1 ? view(ahead) : null,
      behind: behind && behind.c.lapData.driverStatus === 1 ? view(behind) : null,
    };
  }

  return {
    kind,
    name: NAMES[session.sessionType] || 'Session',
    status,
    lapInvalid: !!lap.currentLapInvalid,
    timeLeftS,
    position,
    bestMs: myBest,
    poleMs: pole,
    gapToPoleMs: myBest && pole ? myBest - pole : null,
    cut,
    projected,
    lapGone,
    toLine,
    runs,
    traffic,
  };
}

module.exports = { qualifying, sessionKind, cutPosition, bestLapMs };
