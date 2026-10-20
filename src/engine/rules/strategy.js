const { SEVERITY, CATEGORY } = require('./cards');
const { laps } = require('../../lib/format');
const { planText } = require('../../analysis/racePlan');

/** @typedef {import('./cards').RuleContext} RuleContext */

// Only cars that pitted this recently count as a fresh undercut threat; the
// card itself then lives on via its own expiresAtMs.
const UNDERCUT_DETECT_WINDOW_MS = 3000;
// Undercut window on the car ahead: close enough that fresh tyres can
// jump it, on tyres old enough that a stop makes sense, with laps left to
// use them.
const UNDERCUT_GAP_MS = 1500;
const STOP_WORTH_IT_TYRE_AGE = 8;
const UNDERCUT_MIN_LAPS_LEFT = 5;
// An undercut needs the car ahead to stop soon after you: if it isn't due
// within this, there's nothing to undercut (a real race offered one on a car
// that had already made its stop - from P11 out into P21).
const UNDERCUT_THEY_STOP_WITHIN = 3;
// A neighbour this close and this near its stop is worth a heads-up.
const RIVAL_STOP_GAP_MS = 3000;
const RIVAL_STOP_WITHIN = 1;
const CHEAP_STOP_MIN_LAPS_LEFT = 3;
// The pit-timing simulator's best lap is this one, by at least this much
// over the next best - a near-tie is the driver's choice, not a call.
const PIT_WINDOW_MARGIN_S = 1.5;

// --- Safety car / VSC / red flag: the options, once per decision ---
/** @param {RuleContext} ctx */
function scOptions(ctx) {
  const { racing, analysis, settled, upsert, expire, clock } = ctx;
  const opts = analysis && analysis.options;
  // The settled pick, which the card shows - the cheap-stop call follows it, not a flicker.
  ctx.optsSettled = !!(racing && opts && settled('sc-options', `${opts.situation}:${opts.recommendedId}`));
  if (ctx.optsSettled) {
    upsert('sc-options', { severity: SEVERITY.ADVISORY, category: CATEGORY.STRATEGY, message: opts.headline, expiresAtMs: clock() + 4000 });
  } else if (!opts) {
    expire('sc-options');
  }
}

// --- ML tyre model: would fresh tyres pay for a stop? ---
// Only until pit timing has an answer - it says which lap, not just whether.
/** @param {RuleContext} ctx */
function tyrePayback({ racing, greenRacing, analysis, lapsLeft, myTyreAge, upsert, expire, clock }) {
  const payback = analysis && analysis.tyreModel && analysis.tyreModel.payback;
  if (racing && greenRacing && payback && payback.worthIt && !(analysis && analysis.pitTiming) && lapsLeft != null && payback.paybackLaps <= lapsLeft - 2 && myTyreAge >= STOP_WORTH_IT_TYRE_AGE) {
    upsert('tyre-payback', {
      severity: SEVERITY.INFO,
      category: CATEGORY.STRATEGY,
      message: `Fresh tyres would pay back a stop in ~${laps(Math.max(1, Math.round(payback.paybackLaps)))} (${Math.floor(lapsLeft)} left)`,
      expiresAtMs: clock() + 5000,
    });
  } else {
    expire('tyre-payback');
  }
}

// --- Undercut window on the car ahead ---
// The HUD shows the gap; it doesn't say whether stopping now would jump
// the car. Close behind it, on tyres at least as old, rejoining in clean
// air with enough race left - and fresh tyres gaining more in the laps
// before they stop than the gap to them: that's the classic undercut.
/** @param {RuleContext} ctx */
function undercutWindow({ racing, greenRacing, analysis, onTrack, ahead, aheadRow, gapAheadNow, myTyreAge, lapsLeft, out, upsert, expire, clock }) {
  const rejoin = analysis && analysis.rejoin;
  const theirAge = ahead && ahead.status ? ahead.status.tyresAgeLaps : null;
  const theyStopIn = aheadRow ? aheadRow.stopInLaps : null;
  const myDegMs = analysis && analysis.tyreModel && analysis.tyreModel.mine ? analysis.tyreModel.mine.degMsPerLap : null;
  const undercutGainMs = myDegMs > 0 && theyStopIn != null ? myDegMs * (theirAge ?? myTyreAge) * Math.max(1, theyStopIn) : 0;
  // Only until pit timing has an answer: it races the undercut out against
  // everyone's stops, and said "box in 3 laps" beside this "box now".
  const undercutOn = racing && greenRacing && !(analysis && analysis.pitTiming) && onTrack(ahead) && rejoin && !rejoin.inTraffic
    && gapAheadNow > 0 && gapAheadNow <= UNDERCUT_GAP_MS
    && myTyreAge >= STOP_WORTH_IT_TYRE_AGE && (theirAge == null || theirAge >= myTyreAge - 2)
    && theyStopIn != null && theyStopIn <= UNDERCUT_THEY_STOP_WITHIN
    && (lapsLeft == null || lapsLeft >= UNDERCUT_MIN_LAPS_LEFT)
    && undercutGainMs > gapAheadNow;
  if (undercutOn) {
    const name = ahead.participant ? ahead.participant.name : `P${ahead.lapData.carPosition}`;
    out.undercutOn = name;
    upsert('undercut-window', {
      severity: SEVERITY.INFO,
      category: CATEGORY.STRATEGY,
      message: `Undercut on ${name} is on - they're due in ${theyStopIn <= 1 ? 'this lap or next' : `~${laps(theyStopIn)}`}: box now, ~${((undercutGainMs - gapAheadNow) / 1000).toFixed(1)}s ahead after their stop`,
      expiresAtMs: clock() + 5000,
    });
  } else {
    expire('undercut-window');
  }
}

// --- A neighbour about to box: their stop changes your race ---
/** @param {RuleContext} ctx */
function rivalStop({ racing, greenRacing, neutralised, onTrack, ahead, behind, aheadRow, behindRow, gapAheadNow, gapBehindNow, nameOf, settled, upsert, expire, clock }) {
  const due = [[ahead, aheadRow, 'ahead', gapAheadNow], [behind, behindRow, 'behind', gapBehindNow]]
    .find(([c, row, , gap]) => onTrack(c) && row && row.stopInLaps != null && row.stopInLaps <= RIVAL_STOP_WITHIN && gap > 0 && gap <= RIVAL_STOP_GAP_MS);
  if (racing && greenRacing && !neutralised && due && settled('rival-stop', `${due[0].carIndex}`)) {
    const [c, row, side] = due;
    upsert('rival-stop', {
      severity: SEVERITY.INFO,
      category: CATEGORY.STRATEGY,
      message: `${nameOf(c)} ${side} is due to box ${row.stopInLaps === 0 ? 'this lap' : 'next lap'} (tyres ${row.tyresAgeLaps} laps old)${side === 'ahead' ? ' - clean air after, push' : ' - cover the undercut'}`,
      expiresAtMs: clock() + 5000,
    });
  } else if (!due) {
    expire('rival-stop');
  }
}

// --- Pit window: the simulator says this lap is the one ---
/** @param {RuleContext} ctx */
function pitWindow({ racing, greenRacing, analysis, out, upsert, expire, clock }) {
  const pt = analysis && analysis.pitTiming;
  const best = pt && pt.options.find((o) => o.best);
  if (racing && greenRacing && best && best.inLaps === 0 && pt.marginS >= PIT_WINDOW_MARGIN_S) {
    out.pitWindow = `Pit window - box this lap, rejoin P${best.rejoinPosition}${best.inTraffic ? ' in traffic' : ''} on ${best.compoundName.toLowerCase()}s`;
    upsert('pit-window', {
      severity: SEVERITY.ADVISORY,
      category: CATEGORY.STRATEGY,
      message: `${out.pitWindow}, ${pt.marginS.toFixed(1)}s better than waiting`,
      expiresAtMs: clock() + 5000,
    });
  } else {
    expire('pit-window');
  }
}

// --- Cheap stop under a safety car / VSC ---
// The biggest strategy swing of most races, and the game only tells you
// the safety car is out - not what a stop costs now.
/** @param {RuleContext} ctx */
function cheapStop({ racing, neutralised, redFlag, playerOnTrack, analysis, optsSettled, myTyreAge, lapsLeft, out, upsert, expire, clock }) {
  const opts = analysis && analysis.options;
  // The options card weighs the stop against the position: the call boxes only on its settled box.
  const optsSayBox = !opts || (optsSettled && opts.recommendedId !== 'stay');
  if (racing && neutralised && !redFlag && playerOnTrack && optsSayBox && myTyreAge >= STOP_WORTH_IT_TYRE_AGE
    && (lapsLeft == null || lapsLeft >= CHEAP_STOP_MIN_LAPS_LEFT)) {
    const pl = analysis && analysis.pitLoss;
    out.cheapStop = pl && pl.ms < pl.normalMs
      ? `${neutralised}: a stop costs ~${Math.round(pl.ms / 1000)}s, not ~${Math.round(pl.normalMs / 1000)}s`
      : `${neutralised}: pit stops are cheap now`;
    upsert('cheap-stop', {
      severity: SEVERITY.ADVISORY,
      category: CATEGORY.STRATEGY,
      message: `${out.cheapStop} - box this lap?`,
      expiresAtMs: clock() + 5000,
    });
  } else {
    expire('cheap-stop');
  }
}

// --- A neighbour just pitted ---
// The car behind stopping is the undercut threat (fresh tyres, it can jump
// us by stopping first). The car ahead stopping is the opposite: clean air
// for us to stay out and push - the overcut.
// Classified by the positions recorded at pit entry, not now: the car
// loses places down the pit lane and would otherwise flip sides.
/** @param {RuleContext} ctx */
function neighbourPitted({ racing, neutralised, ordered, playerIdx, upsert, clock }) {
  const label = (c) => (c.participant ? c.participant.name : `P${c.pitEntryPosition}`);
  // Under a safety car or red flag the whole field stops: nobody is undercutting anybody.
  for (const c of racing && !neutralised ? ordered : []) {
    if (c.carIndex === playerIdx || !c.pitEntryAtMs || clock() - c.pitEntryAtMs >= UNDERCUT_DETECT_WINDOW_MS) continue;
    const myPosThen = c.pitEntryPlayerPosition;
    if (myPosThen == null) continue;
    if (c.pitEntryPosition === myPosThen + 1) {
      upsert(`undercut-${c.carIndex}`, {
        severity: SEVERITY.ADVISORY,
        category: CATEGORY.STRATEGY,
        message: `${label(c)} just pitted behind you - undercut threat, cover within ~2 laps`,
        expiresAtMs: c.pitEntryAtMs + 20000,
      });
    } else if (c.pitEntryPosition === myPosThen - 1) {
      upsert(`overcut-${c.carIndex}`, {
        severity: SEVERITY.INFO,
        category: CATEGORY.STRATEGY,
        message: `${label(c)} pitted ahead - clean air, push for the overcut`,
        expiresAtMs: c.pitEntryAtMs + 20000,
      });
    }
  }
}

// --- Before the start: the plan ---
/** @param {RuleContext} ctx */
function racePlan({ analysis, upsert, expire, clock }) {
  const rp = analysis && analysis.racePlan;
  if (rp) {
    upsert('race-plan', {
      severity: SEVERITY.INFO,
      category: CATEGORY.STRATEGY,
      message: `Plan, ${planText(rp.best)}${rp.other ? ` (${rp.other.stops} stop${rp.other.stops === 1 ? '' : 's'} ~${Math.round(rp.other.slowerMs / 1000)}s slower)` : ''}`,
      expiresAtMs: clock() + 5000,
    });
  } else {
    expire('race-plan');
  }
}

// --- The start: what lap 1 did, once, as lap 2 begins ---
/** @param {RuleContext} ctx */
function start({ racing, player, mem, upsert, clock }) {
  const grid = player.lapData.gridPosition;
  if (racing && !mem.startSaid && player.lapData.currentLapNum === 2 && grid > 0) {
    mem.startSaid = true;
    const pos = player.lapData.carPosition;
    const d = grid - pos;
    upsert('start', {
      severity: SEVERITY.INFO,
      category: CATEGORY.PACE,
      message: `Lap 1: P${pos} from P${grid} on the grid - ${d > 0 ? `up ${d}` : d < 0 ? `down ${-d}` : 'held position'}`,
      expiresAtMs: clock() + 15000,
    });
  }
}

module.exports = { scOptions, tyrePayback, undercutWindow, rivalStop, pitWindow, cheapStop, neighbourPitted, racePlan, start, CHEAP_STOP_MIN_LAPS_LEFT };
