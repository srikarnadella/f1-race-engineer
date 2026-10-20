const { SEVERITY, CATEGORY } = require('./cards');

/** @typedef {import('./cards').RuleContext} RuleContext */

const ALERT_EVENT_CODES = new Set(['SCAR', 'RDFL', 'CHQF', 'PENA', 'FTLP', 'RTMT']);
const CRITICAL_EVENT_CODES = new Set(['SCAR', 'RDFL']);
// Drive-through, stop-go, time penalty, warning, disqualified.
const RADIO_PENALTY_TYPES = new Set([0, 1, 4, 5]); // not 6 ("Disqualified"): sent in F1 26 to a driver who raced on
const PENALTY_WARNING = 5;
const EVENT_CARD_MS = 8000;
// vehicleFiaFlags / zoneFlag: 0 none, 1 green, 2 blue, 3 yellow.
const FIA_BLUE = 2;
const FIA_YELLOW = 3;
const YELLOW_AHEAD_M = 800;
const BLUE_LOOKUP_M = 500;

// --- Penalties and track limits ---
/** @param {RuleContext} ctx */
function penalties(ctx) {
  const { analysis, racing, neutralised, mem, out, upsert, expire, clock } = ctx;
  const pen = analysis && analysis.penalties;
  const tl = pen ? pen.trackLimits : { count: 0 };
  // The game's own "Warning" event for the same infringement would say less.
  ctx.trackLimitNew = tl.count > mem.trackLimitsSaid;
  if (tl.count < mem.trackLimitsSaid) mem.trackLimitsSaid = tl.count; // a flashback took one back
  if (ctx.trackLimitNew) {
    mem.trackLimitsSaid = tl.count;
    const where = !tl.last ? '' : tl.last.corner != null ? ` at turn ${tl.last.corner}` : ` at ${(tl.last.atM / 1000).toFixed(1)} km`;
    upsert(`track-limits:${tl.count}`, {
      severity: SEVERITY.ADVISORY,
      category: CATEGORY.FLAG,
      message: `Track limits - warning ${tl.count}${where}${tl.sameAgain ? ', same corner again - keep it inside there' : ''}`,
      expiresAtMs: clock() + 15000,
    });
  }
  if (pen && (pen.stopGos || pen.driveThroughs)) {
    out.penaltyBox = pen.stopGos ? 'Serve the stop-go - box, no tyre change' : 'Serve the drive-through - box';
    upsert('penalty-serve', { severity: SEVERITY.CRITICAL, category: CATEGORY.FLAG, message: neutralised ? `${out.penaltyBox} once the ${neutralised === 'Red flag' ? 'race restarts' : 'safety car is in'}` : `${out.penaltyBox} (3 laps to take it)`, expiresAtMs: clock() + 5000 });
  } else {
    expire('penalty-serve');
  }
  if (racing && pen && pen.timeS) {
    const f = pen.flag;
    upsert('penalty-time', {
      severity: f && !f.covered ? SEVERITY.ADVISORY : SEVERITY.INFO,
      category: CATEGORY.FLAG,
      // Whole seconds: the gap mustn't rewrite the card ten times a second.
      message: pen.servedAt === 'stop'
        ? `${pen.timeS}s penalty - served at your stop`
        : f
          ? `${pen.timeS}s penalty at the flag - ${f.name} ${Math.round(f.gapMs / 1000)}s behind: ${f.covered ? 'covered' : 'not covered, push'}`
          : `${pen.timeS}s penalty - added at the flag`,
      expiresAtMs: clock() + 5000,
    });
  } else {
    expire('penalty-time');
  }
}

// --- Flags: a yellow round the next corners, a blue for the car lapping you ---
// The HUD shows the flag for where you are; a yellow a few hundred metres
// on is the one worth hearing early (a stopped car after a blind corner).
/** @param {RuleContext} ctx */
function flags({ session, player, racing, ordered, playerIdx, fieldModel, upsert, expire, clock }) {
  const L = session && session.trackLength;
  const myFlag = player.status ? player.status.vehicleFiaFlags : null;
  // Already in it: the HUD says so, the radio needn't.
  let yellow = null;
  if (myFlag !== FIA_YELLOW && L > 0 && session.marshalZones && player.lapData.lapDistance >= 0) {
    const me = player.lapData.lapDistance;
    const next = session.marshalZones
      .filter((z) => z.zoneFlag === FIA_YELLOW)
      .map((z) => ({ atM: z.zoneStart * L, inM: (z.zoneStart * L - me + L) % L }))
      .filter((z) => z.inM <= YELLOW_AHEAD_M)
      .sort((a, b) => a.inM - b.inM)[0];
    if (next) {
      // Named by the corner it covers, not a distance that counts down every tick.
      const corner = fieldModel.getPlayerCorners().find((c) => c.startM >= next.atM);
      yellow = `Yellow ahead${corner ? ` at turn ${corner.corner}` : ''} - careful, no overtaking`;
    }
  }
  if (yellow) upsert('yellow', { severity: SEVERITY.ADVISORY, category: CATEGORY.FLAG, message: yellow, expiresAtMs: clock() + 3000 });
  else expire('yellow');
  if (racing && myFlag === FIA_BLUE) {
    // The car lapping you: a lap or more up, closest behind on the road.
    const lapper = ordered
      .filter((c) => c.lapData && c.carIndex !== playerIdx && c.lapData.currentLapNum > player.lapData.currentLapNum)
      .map((c) => ({ c, behindM: L > 0 ? (player.lapData.lapDistance - c.lapData.lapDistance + L) % L : Infinity }))
      .sort((a, b) => a.behindM - b.behindM)[0];
    const who = lapper && lapper.behindM < BLUE_LOOKUP_M && lapper.c.participant ? lapper.c.participant.name : 'the leaders';
    upsert('blue', { severity: SEVERITY.ADVISORY, category: CATEGORY.FLAG, message: `Blue flag - let ${who} by`, expiresAtMs: clock() + 3000 });
  } else {
    expire('blue');
  }
}

// What an event says on the radio - naming the driver it's about. A
// fastest lap replaces the previous one (one card, not three at once);
// penalties only matter when they're the player's.
function eventCard(event, playerIdx, fieldModel, mem) {
  const who = (idx) => {
    const car = idx == null ? null : fieldModel.getCar(idx);
    return idx === playerIdx ? 'you' : (car && car.participant && car.participant.name) || `car ${idx}`;
  };
  if (event.code === 'FTLP') {
    const t = event.lapTimeS > 0 ? ` ${Math.floor(event.lapTimeS / 60)}:${(event.lapTimeS % 60).toFixed(3).padStart(6, '0')}` : '';
    return { id: 'event-FTLP', message: event.vehicleIdx === playerIdx ? `Fastest lap - that's you,${t}` : `Fastest lap: ${who(event.vehicleIdx)}${t}` };
  }
  if (event.code === 'PENA') {
    // Only penalty types whose meaning is certain reach the radio: in a
    // real F1 26 race, type 16 ("Retired" in the F1 25 list) arrived for a
    // driver who was racing on with no penalties - the list has changed.
    if (event.vehicleIdx !== playerIdx || !RADIO_PENALTY_TYPES.has(event.penaltyType)) return null;
    return { severity: SEVERITY.ADVISORY, message: `${event.name} for you${event.timeS ? ` (+${event.timeS}s)` : ''}${event.lapNum ? `, lap ${event.lapNum}` : ''}` };
  }
  // Once per car per session: the game re-sends retirements after a
  // flashback or a red flag (one real race announced Albon six times).
  if (event.code === 'RTMT') {
    if (event.vehicleIdx === playerIdx || mem.announcedRetirements.has(event.vehicleIdx)) return null;
    mem.announcedRetirements.add(event.vehicleIdx);
    return { message: `${who(event.vehicleIdx)} has retired` };
  }
  return { message: event.name };
}

// --- Discrete event callouts (safety car, flags, fastest lap, penalties) ---
// Every event since the last tick, not just the newest: a safety car
// followed within 100ms by a speed-trap or button event must still land.
/** @param {RuleContext} ctx */
function events({ fieldModel, playerIdx, trackLimitNew, mem, upsert, clock }) {
  for (const event of fieldModel.getRecentEvents()) {
    if (event.seq <= mem.lastEventSeq) continue;
    mem.lastEventSeq = event.seq;
    if (!ALERT_EVENT_CODES.has(event.code) || clock() - event.atMs >= EVENT_CARD_MS) continue;
    if (trackLimitNew && event.code === 'PENA' && event.penaltyType === PENALTY_WARNING) continue;
    const card = eventCard(event, playerIdx, fieldModel, mem);
    if (!card) continue;
    upsert(card.id || `event-${event.seq}`, {
      // Only a deployment interrupts; "SC in this lap" / "race resumed" are follow-ups.
      severity: card.severity || (CRITICAL_EVENT_CODES.has(event.code) && !(event.safetyCarEventType > 0) ? SEVERITY.CRITICAL : SEVERITY.INFO),
      category: CATEGORY.FLAG,
      message: card.message,
      expiresAtMs: event.atMs + EVENT_CARD_MS,
    });
  }
}

module.exports = { penalties, flags, events };
