// Layer 4, decisions: turns the field (state/) and the numbers worked out
// from it (raceAnalysis.js) into what the driver hears - radio cards, each
// with an id, a severity and an expiry, settled before it's said - and the
// headline call (calls.js). evaluate() runs every tick: it builds one context
// for the tick and runs the rules in rules/, in the order of RULES below.
const { isRacing, raceLapsLeft } = require('../state/race');
const { qualiCall, raceCall, CALM_CALLS } = require('./calls');
const { SEVERITY, CATEGORY } = require('./rules/cards');
const { tyreCliff, tyreTemps } = require('./rules/tyres');
const { fuel } = require('./rules/fuel');
const { closingAhead, underAttack, battleCall, attackForecast, overtakeReady } = require('./rules/battle');
const { adjustments } = require('./rules/adjust');
const { scOptions, tyrePayback, undercutWindow, rivalStop, pitWindow, cheapStop, neighbourPitted, racePlan, start } = require('./rules/strategy');
const { weather } = require('./rules/weather');
const { damage } = require('./rules/damage');
const { quali } = require('./rules/quali');
const { penalties, flags, events } = require('./rules/flags');

/** @typedef {import('./rules/cards').Card} Card */
/** @typedef {import('./rules/cards').RuleContext} RuleContext */
/** @typedef {import('./rules/cards').SessionMemory} SessionMemory */
/** @typedef {import('./rules/cards').CallInputs} CallInputs */

const SEVERITY_RANK = { info: 0, advisory: 1, critical: 2 };
const SETTLE_MS = 5000;
const TEXT_HOLD_MS = 5000;
const numbersOut = (text) => String(text).replace(/[0-9]+([.:][0-9]+)?/g, '#');
const RESULT_FINISHED = 3; // lapData.resultStatus: 3 finished, 4+ out (DNF, DSQ, retired)
const NEUTRALISED_NAME = { 1: 'Safety car', 2: 'VSC' };

// Order matters: a later rule reads what an earlier one decided (the battle
// call stands the older defend and best-chance cards down; the cheap stop
// follows the settled safety-car options; a track-limits card replaces the
// game's own warning event).
/** @type {((ctx: RuleContext) => void)[]} */
const RULES = [
  tyreCliff, fuel, closingAhead, underAttack, adjustments, battleCall, scOptions, attackForecast, overtakeReady,
  tyrePayback, undercutWindow, rivalStop, pitWindow, cheapStop, weather, neighbourPitted, damage, quali,
  penalties, racePlan, start, tyreTemps, flags, events,
];

function average(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** @returns {SessionMemory} */
function freshMemory() {
  return {
    fuelReading: null,
    lastEventSeq: 0,
    qualiBestMs: null,
    qualiSeen: false,
    trackLimitsSaid: 0,
    startSaid: false,
    ersShown: null,
    ersCandidate: { key: null, since: 0 },
    announcedRetirements: new Set(),
  };
}

/** @returns {CallInputs} */
function freshCallInputs() {
  return {
    lapsToCliff: null,
    tyresReachFlag: false,
    fuelMarginLaps: null,
    fuelSavePct: null,
    battle: null,
    adjust: null,
    undercutOn: null,
    pitWindow: null,
    cheapStop: null,
    weatherBox: null,
    rainSoonLaps: null,
    rainInLaps: null,
    damageBox: null,
    penaltyBox: null,
  };
}

// Rule-based, re-evaluated every tick against the current FieldModel.
// Insights are keyed by a stable id so a still-true condition keeps the
// same card on the dashboard (refreshing its text) instead of re-firing a
// new toast every tick; a condition that's no longer true expires its id.
function createInsightEngine(fieldModel) {
  const { clock } = fieldModel;
  const tyreWearHistory = new Map(); // carIndex -> [{ lapNum, avgWear }]
  /** @type {Map<string, Card>} */
  const activeInsights = new Map(); // id -> insight

  // A card whose only change is its numbers ("0.3s behind" -> "0.4s") keeps
  // its text for TEXT_HOLD_MS: on a real race those rewrites were most of
  // the radio band's churn (97 for one "Closing on" card), unreadable at a
  // glance. A new word or severity shows at once.
  function upsert(id, insight) {
    const prior = activeInsights.get(id);
    const now = clock();
    let message = insight.message;
    let textAtMs = now;
    if (prior && prior.message !== message) {
      const sameWords = numbersOut(prior.message) === numbersOut(message) && prior.severity === insight.severity;
      if (sameWords && now - prior.textAtMs < TEXT_HOLD_MS) [message, textAtMs] = [prior.message, prior.textAtMs];
    } else if (prior) {
      textAtMs = prior.textAtMs;
    }
    activeInsights.set(id, { id, createdAtMs: prior ? prior.createdAtMs : now, ...insight, message, textAtMs });
  }

  function expire(id) {
    activeInsights.delete(id);
  }

  function pruneExpired() {
    const now = clock();
    for (const [id, insight] of activeInsights) {
      if (insight.expiresAtMs && now > insight.expiresAtMs) activeInsights.delete(id);
    }
  }

  // Recent-slope (last 3 samples) rather than whole-stint average: tyre
  // degradation accelerates late in a stint, so the recent trend predicts
  // the cliff far better than an average from lap 1.
  function trackTyreWear(carIndex, car) {
    if (!car.damage || !car.lapData) return null;
    const avgWear = average(car.damage.tyresWear);
    const lapNum = car.lapData.currentLapNum;
    let history = tyreWearHistory.get(carIndex) || [];
    // A new set (tyre age went down, or wear dropped sharply): the old
    // stint's samples would drag the new set's slope negative.
    const age = car.status ? car.status.tyresAgeLaps : null;
    // A flashback: laps from the rewound-to lap on never happened.
    if (history.length && lapNum < history[history.length - 1].lapNum) history = history.filter((h) => h.lapNum < lapNum);
    const prior = history[history.length - 1];
    if (prior && ((age != null && prior.age != null && age < prior.age) || avgWear < prior.avgWear - 10)) history = [];
    tyreWearHistory.set(carIndex, history);
    const last = history[history.length - 1];
    if (!last || last.lapNum !== lapNum) {
      history.push({ lapNum, avgWear, age });
      if (history.length > 20) history.shift();
      tyreWearHistory.set(carIndex, history);
    }

    const recent = history.slice(-3);
    if (recent.length < 2) return { avgWear, ratePerLap: null };
    const laps = recent[recent.length - 1].lapNum - recent[0].lapNum;
    const ratePerLap = laps > 0 ? (recent[recent.length - 1].avgWear - recent[0].avgWear) / laps : null;
    return { avgWear, ratePerLap };
  }

  // A call that names "who + where" is only made once the same who + where
  // has held for SETTLE_MS - in a train of cars the car ahead changes every
  // few seconds, and each change would otherwise be a new spoken call.
  const settleState = new Map(); // id -> { key, since }
  function settled(id, key) {
    const s = settleState.get(id);
    if (!s || s.key !== key) {
      settleState.set(id, { key, since: clock() });
      return false;
    }
    return clock() - s.since >= SETTLE_MS;
  }

  let seenGeneration = fieldModel.getGeneration();
  let strategy = null;
  let adjust = null;
  let mem = freshMemory();

  // A calm call (push, manage, an undercut on offer) has to hold SETTLE_MS
  // before it replaces another calm one: a real race flipped "undercut on" <->
  // "Tyres and fuel OK" 7 times in 3.5 minutes as the gap hovered. Anything
  // else (BOX, PIT, a safety car) is said at once.
  let shownCall = null;
  function steadyCall(c) {
    if (shownCall && CALM_CALLS.has(c.kind) && CALM_CALLS.has(shownCall.kind) && c.kind !== shownCall.kind && !settled('call', c.kind)) return shownCall;
    settleState.delete('call');
    shownCall = c;
    return c;
  }

  // `analysis` is RaceAnalysis.compute()'s result (rejoin + pit loss), when
  // the caller has one; the rules that judge a pit stop need it.
  function evaluate(analysis = null) {
    if (fieldModel.getGeneration() !== seenGeneration) {
      seenGeneration = fieldModel.getGeneration();
      tyreWearHistory.clear();
      activeInsights.clear();
      settleState.clear();
      shownCall = null;
      mem = freshMemory();
    }
    pruneExpired();
    strategy = null;
    adjust = null;

    const playerIdx = fieldModel.playerIndex();
    if (playerIdx == null) return [...activeInsights.values()];
    const player = fieldModel.getCar(playerIdx);
    if (!player.lapData) return [...activeInsights.values()];

    const ctx = tickContext(analysis, playerIdx, player);
    for (const rule of RULES) rule(ctx);
    const { out } = ctx;
    adjust = out.adjust;

    strategy = {
      battle: out.battle,
      lapsRemaining: ctx.lapsLeft,
      fuelMarginLaps: out.fuelMarginLaps,
      fuelSavePct: out.fuelSavePct,
      tyreLapsToCliff: out.lapsToCliff == null ? null : Math.max(0, out.lapsToCliff),
      tyresReachFlag: out.tyresReachFlag,
      tyreWearRatePerLap: ctx.wear ? ctx.wear.ratePerLap : null,
      call: ctx.q ? qualiCall(ctx.q) : steadyCall(raceCall({
        finished: ctx.finished,
        position: player.lapData.carPosition,
        lapsLeft: ctx.lapsLeft,
        lapsToCliff: out.lapsToCliff,
        fuelMarginLaps: out.fuelMarginLaps,
        fuelSavePct: out.fuelSavePct,
        inPits: !ctx.playerOnTrack,
        neutralised: ctx.neutralised,
        cheapStop: out.cheapStop,
        undercutOn: out.undercutOn,
        weatherBox: out.weatherBox,
        rainSoonLaps: out.rainSoonLaps,
        rainInLaps: out.rainInLaps,
        pitWindow: out.pitWindow,
        damageBox: out.damageBox,
        penaltyBox: out.penaltyBox,
      })),
    };

    // Most severe first, then newest - insights[0] is the dashboard's banner,
    // so the client never has to rank anything itself.
    return [...activeInsights.values()].sort(
      (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.createdAtMs - a.createdAtMs
    );
  }

  // Everything the rules read this tick, worked out once.
  /** @returns {RuleContext} */
  function tickContext(analysis, playerIdx, player) {
    const ordered = fieldModel.orderedByPosition();
    const myPosIdx = ordered.findIndex((c) => c.carIndex === playerIdx);
    const ahead = myPosIdx > 0 ? ordered[myPosIdx - 1] : null;
    const behind = myPosIdx >= 0 && myPosIdx < ordered.length - 1 ? ordered[myPosIdx + 1] : null;

    const session = fieldModel.getSession();
    // Past the flag (or out of it) the race is over for you: the cool-down lap
    // got "defend" and "empty the battery" on four real races.
    const finished = player.lapData.resultStatus >= RESULT_FINISHED ? player.lapData.resultStatus : null;
    const racing = isRacing(session) && !finished;
    // Fuel-to-the-flag, defend calls and the strategy call only mean
    // something in a race that's under way - not practice, qualifying, or
    // the formation lap (where gaps are 0 or unrelated to track position).
    // Under a safety car / VSC / red flag nobody can race, so gap and defend calls are noise.
    const redFlag = fieldModel.isRedFlag();
    const neutralised = redFlag ? 'Red flag' : (session && NEUTRALISED_NAME[session.safetyCarStatus]) || null;
    // A car in the pit lane is neither a target nor a threat - its gap is
    // about to jump by ~20s - so the pace/defend rules skip it.
    const onTrack = (c) => c && c.lapData && c.lapData.pitStatus === 0;
    const playerOnTrack = onTrack(player);
    const gapBehindNow = onTrack(behind) ? behind.lapData.deltaToCarInFrontInMS : null;
    const bc = analysis && analysis.battle && analysis.battle.call;
    const prevDefend = activeInsights.get('under-attack');
    const rowOf = (c) => (c && analysis && analysis.field ? analysis.field.find((r) => r.carIndex === c.carIndex) : null);

    return {
      clock,
      fieldModel,
      analysis,
      playerIdx,
      player,
      ordered,
      ahead,
      behind,
      session,
      finished,
      racing,
      lapsLeft: finished ? null : raceLapsLeft(session, player.lapData),
      redFlag,
      neutralised,
      onTrack,
      playerOnTrack,
      myTyreAge: player.status ? player.status.tyresAgeLaps : null,
      greenRacing: playerOnTrack && !neutralised,
      // Not on lap 1: the start scrambles every gap.
      pastLap1: player.lapData.currentLapNum > 1,
      gapAheadNow: player.lapData.deltaToCarInFrontInMS,
      gapBehindNow,
      bc,
      prevDefend,
      battleDefending: !!(bc && bc.mode === 'DEFEND' && prevDefend && prevDefend.battle),
      aheadRow: rowOf(ahead),
      behindRow: rowOf(behind),
      q: !racing && analysis && analysis.quali,
      wear: trackTyreWear(playerIdx, player),
      nameOf: (c) => (c.participant && c.participant.name ? c.participant.name : `P${c.lapData.carPosition}`),
      upsert,
      expire,
      settled,
      card: (id) => activeInsights.get(id),
      mem,
      out: freshCallInputs(),
    };
  }

  // Strategy numbers from the most recent evaluate() - null until the
  // player's car has lap data.
  function getStrategy() {
    return strategy;
  }

  // { current: { brakeBias, diff, ersMode, batteryPct, ... }, suggestions }
  // from the most recent evaluate(), or null.
  function getAdjust() {
    return adjust;
  }

  return { evaluate, getStrategy, getAdjust };
}

module.exports = { createInsightEngine, SEVERITY, CATEGORY };
