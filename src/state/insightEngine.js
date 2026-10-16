const { computeAdjustments } = require('./adjustments');
const { isRacing, raceLapsLeft } = require('./race');

const SEVERITY = { INFO: 'info', ADVISORY: 'advisory', CRITICAL: 'critical' };
const CATEGORY = { PACE: 'pace', STRATEGY: 'strategy', HEALTH: 'health', FLAG: 'flag', CAR: 'car' };
const SEVERITY_RANK = { info: 0, advisory: 1, critical: 2 };

const ALERT_EVENT_CODES = new Set(['SCAR', 'RDFL', 'CHQF', 'PENA', 'FTLP', 'RTMT']);
const CRITICAL_EVENT_CODES = new Set(['SCAR', 'RDFL']);
const TYRE_CLIFF_THRESHOLD_PCT = 85;

const CLOSING_WINDOW_S = 30;
const CLOSING_THRESHOLD_MS_PER_LAP = -150;
// Below this you're already in the fight (DRS range) - "closing by 2.1s/lap,
// gap 0.2s" in a live race told the driver nothing.
const CLOSING_MIN_GAP_MS = 1000;
const ERS_SETTLE_MS = 5000;
const SETTLE_MS = 5000;
// Drive-through, stop-go, time penalty, warning, disqualified.
const RADIO_PENALTY_TYPES = new Set([0, 1, 4, 5, 6]);
const FALLBACK_LAP_MS = 90000;
// Only cars that pitted this recently count as a fresh undercut threat; the
// card itself then lives on via its own expiresAtMs.
const UNDERCUT_DETECT_WINDOW_MS = 3000;
// Undercut window on the car ahead: close enough that fresh tyres can
// jump it, on tyres old enough that a stop makes sense, with laps left to
// use them.
const UNDERCUT_GAP_MS = 1500;
const STOP_WORTH_IT_TYRE_AGE = 8;
const UNDERCUT_MIN_LAPS_LEFT = 5;
const CHEAP_STOP_MIN_LAPS_LEFT = 3;
// Weather: warn this many laps ahead of rain; call the tyre switch once the
// other tyre is this much quicker per lap (less is lap-time noise).
const RAIN_WARN_LAPS = 10;
const RAIN_IMMINENT_LAPS = 3;
const CROSSOVER_MS = 1000;
const WEATHER_NAME = ['clear', 'light cloud', 'overcast', 'light rain', 'heavy rain', 'storm'];

const laps = (n) => `${n} lap${n === 1 ? '' : 's'}`;

const EVENT_CARD_MS = 8000;
const NEUTRALISED_NAME = { 1: 'Safety car', 2: 'VSC' };

// Car Status `fuelRemainingLaps` is documented as "the value on the MFD",
// which reads as the surplus over the race (+0.4) - but it could be total
// laps of fuel. The two are easy to tell apart while plenty of race is
// left (a surplus sits near zero, laps-of-fuel tracks the laps remaining),
// so each session decides once and keeps that reading. Until then the
// spec's surplus reading is used. `npm run analyze` checks it from the burn rate.
const FUEL_DECIDE_MIN_LAPS_LEFT = 8;
function fuelMeaning(fuelRemainingLaps, lapsLeft) {
  if (lapsLeft == null || lapsLeft < FUEL_DECIDE_MIN_LAPS_LEFT) return null;
  return fuelRemainingLaps > lapsLeft / 2 ? 'laps-of-fuel' : 'surplus';
}

function average(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Gap change per lap to the car ahead, from FieldModel's game-time samples.
// Negative = closing. Null until there's a full window of history.
function closingRateMsPerLap(car) {
  const h = car.gapAheadHistory;
  if (h.length < 2) return null;
  const now = h[h.length - 1];
  let then = null;
  for (let i = h.length - 2; i >= 0; i--) {
    if (now.t - h[i].t >= CLOSING_WINDOW_S) {
      then = h[i];
      break;
    }
  }
  if (!then) return null;
  const lapMs = car.lapData.lastLapTimeInMS || FALLBACK_LAP_MS;
  return ((now.gapMs - then.gapMs) / (now.t - then.t)) * (lapMs / 1000);
}

// Rule-based, re-evaluated every tick against the current FieldModel.
// Insights are keyed by a stable id so a still-true condition keeps the
// same card on the dashboard (refreshing its text) instead of re-firing a
// new toast every tick; a condition that's no longer true expires its id.
function createInsightEngine(fieldModel) {
  const tyreWearHistory = new Map(); // carIndex -> [{ lapNum, avgWear }]
  const activeInsights = new Map(); // id -> insight

  function upsert(id, insight) {
    const prior = activeInsights.get(id);
    activeInsights.set(id, { id, createdAtMs: prior ? prior.createdAtMs : Date.now(), ...insight });
  }

  function expire(id) {
    activeInsights.delete(id);
  }

  function pruneExpired() {
    const now = Date.now();
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
  let battleShown = null; // the settled ATTACK / DEFEND / ... call this tick
  const announcedRetirements = new Set();
  function settled(id, key) {
    const s = settleState.get(id);
    if (!s || s.key !== key) {
      settleState.set(id, { key, since: Date.now() });
      return false;
    }
    return Date.now() - s.since >= SETTLE_MS;
  }

  // A new ERS tip (or none) replaces the one on screen only after it has
  // held for ERS_SETTLE_MS; the tip on screen keeps its latest text.
  let ersShown = null;
  let ersCandidate = { key: null, since: 0 };
  function settleErs(tip) {
    const key = tip ? tip.action : null;
    const shownKey = ersShown ? ersShown.action : null;
    if (key === shownKey) {
      ersCandidate = { key, since: Date.now() };
      ersShown = tip;
      return ersShown;
    }
    if (ersCandidate.key !== key) ersCandidate = { key, since: Date.now() };
    if (Date.now() - ersCandidate.since >= ERS_SETTLE_MS) ersShown = tip;
    return ersShown;
  }

  // What an event says on the radio - naming the driver it's about. A
  // fastest lap replaces the previous one (one card, not three at once);
  // penalties only matter when they're the player's.
  function eventCard(event, playerIdx) {
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
      if (event.vehicleIdx === playerIdx || announcedRetirements.has(event.vehicleIdx)) return null;
      announcedRetirements.add(event.vehicleIdx);
      return { message: `${who(event.vehicleIdx)} has retired` };
    }
    return { message: event.name };
  }

  let seenGeneration = fieldModel.getGeneration();
  let strategy = null;
  let adjust = null;
  let fuelReading = null; // 'surplus' | 'laps-of-fuel', decided per session
  let lastEventSeq = 0; // newest event already turned into a card

  // The headline call for the strategy tier, derived from the same numbers
  // the insight rules use so the call and the radio messages never disagree.
  function strategyCall({ lapsLeft, lapsToCliff, fuelMarginLaps, inPits, neutralised, cheapStop, undercutOn, weatherBox, rainSoonLaps, rainInLaps }) {
    if (inPits) return { action: 'PIT', reason: 'In the pit lane' };
    // The wrong tyre for the conditions costs more per lap than anything else.
    if (weatherBox) return { action: 'BOX', reason: weatherBox };
    if (cheapStop) return { action: 'BOX', reason: cheapStop };
    if (lapsToCliff != null && lapsToCliff <= 1) {
      if (lapsLeft != null && lapsLeft <= 2) return { action: 'HOLD', reason: 'Tyres gone but too late to stop - bring it home' };
      // Stopping for new slicks just before the rain wastes a stop.
      return rainSoonLaps != null
        ? { action: 'BOX', reason: `Tyres at the cliff - rain within ~${laps(Math.max(1, Math.round(rainSoonLaps)))}, think inters` }
        : { action: 'BOX', reason: 'Tyres at the cliff - box this lap' };
    }
    // No racing under yellow, so "push" would be wrong whatever the tyres say.
    if (neutralised === 'Red flag') return { action: 'HOLD', reason: 'Red flag - race stopped' };
    if (neutralised) return { action: 'HOLD', reason: `${neutralised} - hold position, keep the delta positive` };
    if (fuelMarginLaps != null && fuelMarginLaps < 0) return { action: 'HOLD', reason: 'Fuel short - lift and coast' };
    if (lapsToCliff != null && lapsToCliff <= 3) return { action: 'HOLD', reason: `Manage tyres - ~${laps(Math.round(lapsToCliff))} to the cliff` };
    if (fuelMarginLaps != null && fuelMarginLaps < 0.3) return { action: 'HOLD', reason: 'Fuel tight - save where you can' };
    // An undercut is an option, not an order - but the call must not read as
    // "nothing to think about" while the radio is offering one.
    if (undercutOn) return { action: 'PUSH', reason: `Or box now - undercut on ${undercutOn} is on` };
    if (rainInLaps != null) return { action: 'PUSH', reason: `Rain within ~${laps(Math.max(1, Math.round(rainInLaps)))} - don't stop for slicks` };
    return { action: 'PUSH', reason: 'Tyres and fuel OK' };
  }

  // `analysis` is RaceAnalysis.compute()'s result (rejoin + pit loss), when
  // the caller has one; the rules that judge a pit stop need it.
  function evaluate(analysis = null) {
    if (fieldModel.getGeneration() !== seenGeneration) {
      seenGeneration = fieldModel.getGeneration();
      tyreWearHistory.clear();
      activeInsights.clear();
      lastEventSeq = 0;
      fuelReading = null;
      ersShown = null;
      ersCandidate = { key: null, since: 0 };
      settleState.clear();
      announcedRetirements.clear();
    }
    pruneExpired();
    strategy = null;
    adjust = null;

    const playerIdx = fieldModel.playerIndex();
    if (playerIdx == null) return [...activeInsights.values()];
    const player = fieldModel.getCar(playerIdx);
    if (!player.lapData) return [...activeInsights.values()];
    let lapsToCliff = null;
    let lapsLeft = null;
    let fuelMarginLaps = null;

    const ordered = fieldModel.orderedByPosition();
    const myPosIdx = ordered.findIndex((c) => c.carIndex === playerIdx);
    const ahead = myPosIdx > 0 ? ordered[myPosIdx - 1] : null;
    const behind = myPosIdx >= 0 && myPosIdx < ordered.length - 1 ? ordered[myPosIdx + 1] : null;

    // --- Tyres: laps-to-cliff projection ---
    const wear = trackTyreWear(playerIdx, player);
    if (wear && wear.ratePerLap > 0) {
      lapsToCliff = (TYRE_CLIFF_THRESHOLD_PCT - wear.avgWear) / wear.ratePerLap;
      if (lapsToCliff <= 3) {
        upsert('tyre-cliff', {
          severity: lapsToCliff <= 1 ? SEVERITY.CRITICAL : SEVERITY.ADVISORY,
          category: CATEGORY.STRATEGY,
          message: lapsToCliff < 0.5
            ? 'Tyres: at the cliff - lap time is going'
            : `Tyres: ~${laps(Math.round(lapsToCliff))} to the cliff at this wear rate`,
          expiresAtMs: Date.now() + 15000,
        });
      } else {
        expire('tyre-cliff');
      }
    } else {
      // Fresh tyres (no wear trend yet) - the old set's warning is void.
      expire('tyre-cliff');
    }

    // Fuel-to-the-flag, defend calls and the strategy call only mean
    // something in a race that's under way - not practice, qualifying, or
    // the formation lap (where gaps are 0 or unrelated to track position).
    const session = fieldModel.getSession();
    const racing = isRacing(session);
    // Under a safety car / VSC nobody can race, so gap and defend calls are noise.
    // Under a safety car / VSC / red flag nobody can race, so gap and defend calls are noise.
    const redFlag = fieldModel.isRedFlag();
    const neutralised = redFlag ? 'Red flag' : (session && NEUTRALISED_NAME[session.safetyCarStatus]) || null;
    // A car in the pit lane is neither a target nor a threat - its gap is
    // about to jump by ~20s - so the pace/defend rules skip it.
    const onTrack = (c) => c && c.lapData && c.lapData.pitStatus === 0;
    const playerOnTrack = onTrack(player);
    const myTyreAge = player.status ? player.status.tyresAgeLaps : null;

    lapsLeft = raceLapsLeft(session, player.lapData);

    // --- Fuel: will current load last to the flag? ---
    if (lapsLeft != null && player.status) {
      const frl = player.status.fuelRemainingLaps;
      if (!fuelReading) fuelReading = fuelMeaning(frl, lapsLeft);
      const fuelDelta = fuelReading === 'laps-of-fuel' ? frl - lapsLeft : frl;
      fuelMarginLaps = fuelDelta;
      if (fuelDelta < 0.3) {
        upsert('fuel-risk', {
          severity: fuelDelta < 0 ? SEVERITY.CRITICAL : SEVERITY.ADVISORY,
          category: CATEGORY.STRATEGY,
          message: fuelDelta < 0
            ? `Fuel: on pace to run ${Math.abs(fuelDelta).toFixed(1)} laps short - lift and coast`
            : `Fuel: only ${fuelDelta.toFixed(1)} laps of margin to the end`,
          expiresAtMs: Date.now() + 15000,
        });
      } else {
        expire('fuel-risk');
      }
    }

    // --- Pace vs car ahead: is the gap closing? ---
    // Compares the gap now with the gap ~30s of game time ago and expresses
    // it per lap, which is how an engineer would call it on the radio.
    const closingRate = closingRateMsPerLap(player);
    const greenRacing = playerOnTrack && !neutralised;
    if (!greenRacing) expire('closing-ahead');
    if (greenRacing && onTrack(ahead) && closingRate != null) {
      if (closingRate <= CLOSING_THRESHOLD_MS_PER_LAP && player.lapData.deltaToCarInFrontInMS >= CLOSING_MIN_GAP_MS) {
        upsert('closing-ahead', {
          severity: SEVERITY.INFO,
          category: CATEGORY.PACE,
          message: `Closing on P${ahead.lapData.carPosition} by ${(Math.abs(closingRate) / 1000).toFixed(1)}s/lap - gap ${(player.lapData.deltaToCarInFrontInMS / 1000).toFixed(1)}s`,
          expiresAtMs: Date.now() + 10000,
        });
      } else {
        expire('closing-ahead');
      }
    }

    // --- Pace vs car behind: is it a threat? ---
    // The gap is reported by the chasing car, about the gap to us. Exactly 0
    // means "no timing yet" (grid, first sector), not a car in our gearbox.
    // Never critical: the driver already has mirrors and the HUD's proximity
    // arrows, and a full-width red banner mid-battle is a distraction. The
    // interrupt is kept for things the driver can't see from the cockpit.
    const gapBehindNow = onTrack(behind) ? behind.lapData.deltaToCarInFrontInMS : null;
    if (!(racing && greenRacing)) expire('under-attack');
    if (racing && greenRacing && gapBehindNow > 0) {
      if (gapBehindNow < 1000) {
        // The overtake model (trained on recorded races) says how likely a
        // pass actually is; "likely" escalates the call even outside 0.5s.
        const threat = analysis && analysis.battle && analysis.battle.defend;
        const likely = threat && threat.level === 'high';
        const fc = analysis && analysis.battle && analysis.battle.defendForecast;
        const watch = fc && fc.where ? `, watch corner ${fc.where.corner}` : '';
        upsert('under-attack', {
          severity: gapBehindNow < 500 || likely ? SEVERITY.ADVISORY : SEVERITY.INFO,
          category: CATEGORY.PACE,
          // Named, and "right behind" inside half a second: the exact gap
          // changed the text 250 times in one real race without telling the
          // driver anything new (the Battle card has the number).
          message: `${behind.participant && behind.participant.name ? behind.participant.name : `P${behind.lapData.carPosition}`} ${gapBehindNow < 500 ? 'is right behind you' : `is ${(gapBehindNow / 1000).toFixed(1)}s behind`} - defend${likely ? ', pass likely' : ''}${watch}`,
          expiresAtMs: Date.now() + 8000,
        });
      } else {
        expire('under-attack');
      }
    }

    // --- Live adjustments: brake bias, diff, ERS ---
    // Balance issues count in any session (practice is where they're fixed);
    // the ERS attack/defend calls only mean something wheel-to-wheel.
    const wheelToWheel = racing && greenRacing;
    adjust = computeAdjustments({
      player,
      issues: fieldModel.getPlayerBalanceIssues(),
      gapAheadMs: wheelToWheel && onTrack(ahead) && player.lapData.deltaToCarInFrontInMS > 0 ? player.lapData.deltaToCarInFrontInMS : null,
      gapBehindMs: wheelToWheel && gapBehindNow > 0 ? gapBehindNow : null,
      lapsLeft,
      neutralised: racing ? neutralised : null,
      lapNum: player.lapData.currentLapNum,
    });
    // ERS advice is about a race, and must hold still long enough to act on:
    // in a real race it flipped Overtake/Medium/save every couple of seconds
    // as gaps and charge hovered around the thresholds.
    const ersRaw = racing && !redFlag ? adjust.suggestions.find((s) => s.kind === 'ers') || null : null;
    const ersSteady = settleErs(ersRaw);
    adjust.suggestions = [...(ersSteady ? [ersSteady] : []), ...adjust.suggestions.filter((s) => s.kind !== 'ers')];
    // At most one of each on the radio, so tips never crowd out race calls.
    const ersTip = adjust.suggestions.find((s) => s.kind === 'ers');
    const balanceTip = adjust.suggestions.find((s) => s.kind !== 'ers');
    for (const [id, tip] of [['ers', ersTip], ['balance', balanceTip]]) {
      if (tip && playerOnTrack) {
        upsert(id, { severity: SEVERITY.INFO, category: CATEGORY.CAR, message: tip.radio, expiresAtMs: Date.now() + 5000 });
      } else {
        expire(id);
      }
    }

    // --- ATTACK / DEFEND: the one battle call (analysis/battleCall.js) ---
    // Settled like the other who-and-where calls, and the single voice of
    // the battle: when it's active, the older separate "defend" and "best
    // chance" calls stand down so nothing is said twice.
    const bc = analysis && analysis.battle && analysis.battle.call;
    battleShown = null;
    if (racing && greenRacing && bc && (bc.mode === 'ATTACK' || bc.mode === 'DEFEND' || bc.mode === 'CLOSE IN')
      && settled('battle-call', `${bc.mode}:${bc.target}`)) {
      battleShown = bc;
      const text = bc.mode === 'ATTACK' ? `Attack ${bc.target} - ${bc.reason}` : bc.mode === 'DEFEND' ? `Defend from ${bc.target} - ${bc.reason}` : `Close in on ${bc.target} - ${bc.reason}`;
      upsert('battle-call', { severity: bc.mode === 'CLOSE IN' ? SEVERITY.INFO : SEVERITY.ADVISORY, category: CATEGORY.PACE, message: text, expiresAtMs: Date.now() + 4000 });
    } else if (!bc || bc.mode === 'CLEAR' || bc.mode === 'HOLD' || !(racing && greenRacing)) {
      expire('battle-call');
    }
    if (activeInsights.has('battle-call')) {
      expire('under-attack');
      expire('attack-chance');
    }
    if (bc && (bc.mode === 'CLEAR' || bc.mode === 'HOLD')) battleShown = bc;

    // --- Safety car / VSC / red flag: the options, once per decision ---
    const opts = analysis && analysis.options;
    if (racing && opts && settled('sc-options', `${opts.situation}:${opts.recommendedId}`)) {
      upsert('sc-options', { severity: SEVERITY.ADVISORY, category: CATEGORY.STRATEGY, message: opts.headline, expiresAtMs: Date.now() + 4000 });
    } else if (!opts) {
      expire('sc-options');
    }

    // --- Attack forecast: when and where the car behind will come at you,
    // and your best chance on the car ahead (analysis/attackForecast.js) ---
    const nameOf = (c) => (c.participant && c.participant.name ? c.participant.name : `P${c.lapData.carPosition}`);
    const km = (m) => `${(m / 1000).toFixed(1)} km`;
    const dfc = analysis && analysis.battle && analysis.battle.defendForecast;
    if (racing && greenRacing && behind && dfc && dfc.where && dfc.when.laps > 0 && dfc.when.laps <= 3
      && settled('attack-warning', `${behind.carIndex}:${dfc.where.corner}`)) {
      upsert('attack-warning', {
        severity: SEVERITY.INFO,
        category: CATEGORY.PACE,
        message: `${nameOf(behind)} closing ${dfc.closingSPerLap.toFixed(1)}s/lap - expect an attack into corner ${dfc.where.corner} (${km(dfc.where.atM)}) ${dfc.when.text}`,
        expiresAtMs: Date.now() + 5000,
      });
    } else {
      expire('attack-warning');
    }
    const afc = analysis && analysis.battle && analysis.battle.attackForecast;
    if (racing && greenRacing && ahead && afc && afc.where && afc.when.laps <= 2 && !activeInsights.has('battle-call')
      && settled('attack-chance', `${ahead.carIndex}:${afc.where.corner}`)) {
      const gain = afc.candidates && afc.candidates[0] && afc.candidates[0].gainS >= 0.02 ? ` - you gain ${afc.candidates[0].gainS.toFixed(2)}s on the run to it` : '';
      upsert('attack-chance', {
        severity: SEVERITY.INFO,
        category: CATEGORY.PACE,
        message: `Best chance on ${nameOf(ahead)}: into corner ${afc.where.corner} (${km(afc.where.atM)})${gain}`,
        expiresAtMs: Date.now() + 5000,
      });
    } else {
      expire('attack-chance');
    }

    // --- 2026: Overtake mode earned on the car ahead ---
    const ot = analysis && analysis.overtake;
    if (racing && greenRacing && ot && ot.available && onTrack(ahead) && player.lapData.deltaToCarInFrontInMS > 0 && player.lapData.deltaToCarInFrontInMS < 1500) {
      const name = ahead.participant && ahead.participant.name ? ahead.participant.name : `P${ahead.lapData.carPosition}`;
      upsert('overtake-ready', { severity: SEVERITY.INFO, category: CATEGORY.PACE, message: `Overtake mode available on ${name} - use it on the straight`, expiresAtMs: Date.now() + 4000 });
    } else {
      expire('overtake-ready');
    }

    // --- ML tyre model: would fresh tyres pay for a stop? ---
    const payback = analysis && analysis.tyreModel && analysis.tyreModel.payback;
    if (racing && greenRacing && payback && payback.worthIt && lapsLeft != null && payback.paybackLaps <= lapsLeft - 2 && myTyreAge >= STOP_WORTH_IT_TYRE_AGE) {
      upsert('tyre-payback', {
        severity: SEVERITY.INFO,
        category: CATEGORY.STRATEGY,
        message: `Fresh tyres would pay back a stop in ~${laps(Math.max(1, Math.round(payback.paybackLaps)))} (${Math.floor(lapsLeft)} left)`,
        expiresAtMs: Date.now() + 5000,
      });
    } else {
      expire('tyre-payback');
    }

    // --- Undercut window on the car ahead ---
    // The HUD shows the gap; it doesn't say whether stopping now would jump
    // the car. Close behind it, on tyres at least as old, rejoining in clean
    // air with enough race left: that's the classic undercut.
    const rejoin = analysis && analysis.rejoin;
    const theirAge = ahead && ahead.status ? ahead.status.tyresAgeLaps : null;
    const gapAheadNow = player.lapData.deltaToCarInFrontInMS;
    const undercutOn = racing && greenRacing && onTrack(ahead) && rejoin && !rejoin.inTraffic
      && gapAheadNow > 0 && gapAheadNow <= UNDERCUT_GAP_MS
      && myTyreAge >= STOP_WORTH_IT_TYRE_AGE && (theirAge == null || theirAge >= myTyreAge - 2)
      && (lapsLeft == null || lapsLeft >= UNDERCUT_MIN_LAPS_LEFT);
    let undercutTarget = null;
    if (undercutOn) {
      const name = ahead.participant ? ahead.participant.name : `P${ahead.lapData.carPosition}`;
      undercutTarget = name;
      upsert('undercut-window', {
        severity: SEVERITY.INFO,
        category: CATEGORY.STRATEGY,
        message: `Undercut on ${name} is on - box now, rejoin P${rejoin.position} in clean air`,
        expiresAtMs: Date.now() + 5000,
      });
    } else {
      expire('undercut-window');
    }

    // --- Cheap stop under a safety car / VSC ---
    // The biggest strategy swing of most races, and the game only tells you
    // the safety car is out - not what a stop costs now.
    let cheapStop = null;
    if (racing && neutralised && !redFlag && playerOnTrack && myTyreAge >= STOP_WORTH_IT_TYRE_AGE
      && (lapsLeft == null || lapsLeft >= CHEAP_STOP_MIN_LAPS_LEFT)) {
      const pl = analysis && analysis.pitLoss;
      cheapStop = pl && pl.ms < pl.normalMs
        ? `${neutralised}: a stop costs ~${Math.round(pl.ms / 1000)}s, not ~${Math.round(pl.normalMs / 1000)}s`
        : `${neutralised}: pit stops are cheap now`;
      upsert('cheap-stop', {
        severity: SEVERITY.ADVISORY,
        category: CATEGORY.STRATEGY,
        message: `${cheapStop} - box this lap?`,
        expiresAtMs: Date.now() + 5000,
      });
    } else {
      expire('cheap-stop');
    }

    // --- Weather ---
    // The MFD lists forecast slots in minutes; the driver needs "how many
    // laps until it rains / stops", and - once conditions change - whether
    // the cars on the other tyre are already faster (the crossover).
    const wx = analysis && analysis.weather;
    const nc = wx && wx.nextChange;
    const lapsAway = (n) => `~${laps(Math.max(1, Math.round(n)))}`;
    let rainSoonLaps = null;
    let rainInLaps = null;
    if (nc && nc.to === 'rain' && !nc.afterFlag && nc.inLaps <= RAIN_WARN_LAPS) {
      if (wx.playerOnSlicks) rainInLaps = nc.inLaps;
      // Judged on the rounded figure the message shows, so "~3 laps" is always imminent.
      const imminent = Math.round(nc.inLaps) <= RAIN_IMMINENT_LAPS;
      if (wx.playerOnSlicks && imminent) rainSoonLaps = nc.inLaps;
      upsert('rain-coming', {
        severity: imminent ? SEVERITY.ADVISORY : SEVERITY.INFO,
        category: CATEGORY.STRATEGY,
        message: `Rain within ${lapsAway(nc.inLaps)} (${WEATHER_NAME[nc.weather]}, ${nc.rainPct}%)${wx.playerOnSlicks ? ' - plan the inters stop' : ''}`,
        expiresAtMs: Date.now() + 5000,
      });
    } else {
      expire('rain-coming');
    }
    if (nc && nc.to === 'dry' && !nc.afterFlag) {
      upsert('rain-stopping', {
        severity: SEVERITY.INFO,
        category: CATEGORY.STRATEGY,
        message: `Rain stops within ${lapsAway(nc.inLaps)} - then the track starts drying`,
        expiresAtMs: Date.now() + 5000,
      });
    } else {
      expire('rain-stopping');
    }
    let weatherBox = null;
    const cx = wx && wx.crossover;
    if (playerOnTrack && cx && cx.wetGainMs != null) {
      if (wx.playerOnSlicks && cx.wetGainMs >= CROSSOVER_MS) {
        weatherBox = `Inters ${(cx.wetGainMs / 1000).toFixed(1)}s/lap faster - box for inters`;
      } else if (wx.playerOnWets && -cx.wetGainMs >= CROSSOVER_MS) {
        weatherBox = `Slicks ${(-cx.wetGainMs / 1000).toFixed(1)}s/lap faster - box for slicks`;
      }
    }
    if (weatherBox) {
      const n = wx.playerOnSlicks ? cx.wetCars : cx.slickCars;
      upsert('crossover', {
        severity: SEVERITY.ADVISORY,
        category: CATEGORY.STRATEGY,
        message: `${weatherBox} (${n} car${n === 1 ? '' : 's'} on them)`,
        expiresAtMs: Date.now() + 5000,
      });
    } else {
      expire('crossover');
    }

    // --- A neighbour just pitted ---
    // The car behind stopping is the undercut threat (fresh tyres, it can jump
    // us by stopping first). The car ahead stopping is the opposite: clean air
    // for us to stay out and push - the overcut.
    // Classified by the positions recorded at pit entry, not now: the car
    // loses places down the pit lane and would otherwise flip sides.
    const label = (c) => (c.participant ? c.participant.name : `P${c.pitEntryPosition}`);
    for (const c of racing ? ordered : []) {
      if (c.carIndex === playerIdx || !c.pitEntryAtMs || Date.now() - c.pitEntryAtMs >= UNDERCUT_DETECT_WINDOW_MS) continue;
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

    // --- Discrete event callouts (safety car, flags, fastest lap, penalties) ---
    // Every event since the last tick, not just the newest: a safety car
    // followed within 100ms by a speed-trap or button event must still land.
    for (const event of fieldModel.getRecentEvents()) {
      if (event.seq <= lastEventSeq) continue;
      lastEventSeq = event.seq;
      if (!ALERT_EVENT_CODES.has(event.code) || Date.now() - event.atMs >= EVENT_CARD_MS) continue;
      const card = eventCard(event, playerIdx);
      if (!card) continue;
      upsert(card.id || `event-${event.seq}`, {
        // Only a deployment interrupts; "SC in this lap" / "race resumed" are follow-ups.
        severity: card.severity || (CRITICAL_EVENT_CODES.has(event.code) && !(event.safetyCarEventType > 0) ? SEVERITY.CRITICAL : SEVERITY.INFO),
        category: CATEGORY.FLAG,
        message: card.message,
        expiresAtMs: event.atMs + EVENT_CARD_MS,
      });
    }

    strategy = {
      battle: battleShown,
      lapsRemaining: lapsLeft,
      fuelMarginLaps,
      tyreLapsToCliff: lapsToCliff == null ? null : Math.max(0, lapsToCliff),
      tyreWearRatePerLap: wear ? wear.ratePerLap : null,
      call: strategyCall({ lapsLeft, lapsToCliff, fuelMarginLaps, inPits: !playerOnTrack, neutralised, cheapStop, undercutOn: undercutTarget, weatherBox, rainSoonLaps, rainInLaps }),
    };

    // Most severe first, then newest - insights[0] is the dashboard's banner,
    // so the client never has to rank anything itself.
    return [...activeInsights.values()].sort(
      (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.createdAtMs - a.createdAtMs
    );
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
