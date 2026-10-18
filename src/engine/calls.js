// The headline call - PUSH / HOLD / BOX / PIT / PREP and why - as pure
// functions of what the engine has worked out. Each race call carries a
// `kind` (why it was made) so the calls audit (analysis/callsAudit.js) can
// grade it after the race.
const { laps, clock, thousandths } = require('../lib/format');

// Kinds of call that are advice rather than an order: one of these has to
// hold a few seconds before it replaces another (insightEngine's steadyCall).
// fuel-short comes with a critical card, so it isn't one.
const CALM_CALLS = new Set(['ok', 'undercut', 'rain', 'tyres', 'fuel-tight']);

// Qualifying / practice: where you stand, in words.
function standing(q) {
  if (q.position == null) return 'no time yet';
  if (q.cut && q.cut.marginMs != null) return `P${q.position}, ${thousandths(q.cut.marginMs)} ${q.cut.marginMs < 0 ? 'clear of the cut' : `short of P${q.cut.position}`}`;
  return q.position === 1 ? 'P1 - fastest' : `P${q.position}, ${thousandths(q.gapToPoleMs)} off P1`;
}

// The call outside a race: PREP on the out lap, PUSH on a timed lap, BOX on
// the in lap - with what matters for each.
function qualiCall(q) {
  if (q.status === 'flying') {
    if (q.lapInvalid) return { action: 'HOLD', reason: "Lap deleted - track limits, it won't count" };
    const p = q.projected;
    if (!p) return { action: 'PUSH', reason: q.bestMs ? `Push lap - ${standing(q)}` : 'First timed lap - get a time on the board' };
    return { action: 'PUSH', reason: `On for P${p.position} - ${thousandths(p.lapMs - q.bestMs)} ${p.improves ? 'up on' : 'down on'} your best` };
  }
  if (q.timeLeftS === 0) return { action: 'HOLD', reason: `Session over - ${standing(q)}` };
  if (q.status === 'garage') {
    if (q.timeLeftS == null) return { action: 'PIT', reason: `In the garage - ${standing(q)}` };
    const runs = q.runs === 0 ? 'no time for another run' : q.runs === 1 ? 'time for one more run' : `time for ${q.runs} runs`;
    return { action: 'PIT', reason: `${clock(q.timeLeftS)} left, ${runs} - ${standing(q)}` };
  }
  if (q.status === 'in') return { action: 'BOX', reason: `In lap - ${standing(q)}` };
  const tl = q.toLine;
  if (tl && !tl.makesIt) return { action: 'HOLD', reason: `The flag falls before you reach the line - ${standing(q)}` };
  if (!tl) return { action: 'PREP', reason: `Out lap - ${standing(q)}` };
  return { action: 'PREP', reason: `Out lap - push lap starts in ${clock(tl.startsInS)}${tl.spareS != null ? `, ${clock(tl.spareS)} to spare` : ''}` };
}

// The headline call for the strategy tier, derived from the same numbers
// the insight rules use so the call and the radio messages never disagree.
function raceCall({ lapsLeft, lapsToCliff, fuelMarginLaps, fuelSavePct, inPits, neutralised, cheapStop, undercutOn, weatherBox, rainSoonLaps, rainInLaps, pitWindow, damageBox, penaltyBox }) {
  if (inPits) return { action: 'PIT', kind: 'pit', reason: 'In the pit lane' };
  // Not served in time = disqualified. Not servable under a safety car or red flag.
  if (penaltyBox && !neutralised) return { action: 'BOX', kind: 'penalty', reason: penaltyBox };
  // The wrong tyre for the conditions costs more per lap than anything else.
  if (weatherBox) return { action: 'BOX', kind: 'weather', reason: weatherBox };
  if (damageBox) return { action: 'BOX', kind: 'damage', reason: damageBox };
  if (cheapStop) return { action: 'BOX', kind: 'cheap-stop', reason: cheapStop };
  if (lapsToCliff != null && lapsToCliff <= 1) {
    if (lapsLeft != null && lapsLeft <= 2) return { action: 'HOLD', kind: 'too-late', reason: 'Tyres gone but too late to stop - bring it home' };
    // Stopping for new slicks just before the rain wastes a stop.
    return rainSoonLaps != null
      ? { action: 'BOX', kind: 'cliff', reason: `Tyres at the cliff - rain within ~${laps(Math.max(1, Math.round(rainSoonLaps)))}, think inters` }
      : { action: 'BOX', kind: 'cliff', reason: 'Tyres at the cliff - box this lap' };
  }
  if (pitWindow) return { action: 'BOX', kind: 'window', reason: pitWindow };
  // No racing under yellow, so "push" would be wrong whatever the tyres say.
  if (neutralised === 'Red flag') return { action: 'HOLD', kind: 'red-flag', reason: 'Red flag - race stopped' };
  if (neutralised) return { action: 'HOLD', kind: 'neutralised', reason: `${neutralised} - hold position, keep the delta positive` };
  if (fuelMarginLaps != null && fuelMarginLaps < 0) return { action: 'HOLD', kind: 'fuel-short', reason: `Fuel short - save ~${fuelSavePct || 1}% a lap, lift and coast` };
  if (lapsToCliff != null && lapsToCliff <= 3) return { action: 'HOLD', kind: 'tyres', reason: `Manage tyres - ~${laps(Math.round(lapsToCliff))} to the cliff` };
  if (fuelMarginLaps != null && fuelMarginLaps < 0.3) return { action: 'HOLD', kind: 'fuel-tight', reason: 'Fuel tight - save where you can' };
  // An undercut is an option, not an order - but the call must not read as
  // "nothing to think about" while the radio is offering one.
  if (undercutOn) return { action: 'PUSH', kind: 'undercut', reason: `Or box now - undercut on ${undercutOn} is on` };
  if (rainInLaps != null) return { action: 'PUSH', kind: 'rain', reason: `Rain within ~${laps(Math.max(1, Math.round(rainInLaps)))} - don't stop for slicks` };
  return { action: 'PUSH', kind: 'ok', reason: 'Tyres and fuel OK' };
}

module.exports = { qualiCall, raceCall, standing, CALM_CALLS };
