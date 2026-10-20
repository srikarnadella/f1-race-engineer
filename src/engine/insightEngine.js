// Layer 4, decisions: turns the field (state/) and the numbers worked out
// from it (raceAnalysis.js) into what the driver hears - radio cards, each
// with an id, a severity and an expiry, settled before it's said - and the
// headline call (calls.js). evaluate() runs every tick; its sections, in
// order, are marked "// --- <topic> ---".
const { computeAdjustments } = require('./adjustments');
const { isRacing, raceLapsLeft } = require('../state/race');
const { planText } = require('../analysis/racePlan');
const { qualiCall, raceCall, standing, CALM_CALLS } = require('./calls');
const { laps } = require('../lib/format');
const { RAIN_IMMINENT_LAPS } = require('./weather');

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
// Faster than this is a broken reading, not pace: a gap measured across a
// pit stop or a safety car came out as "closing by 166.3s/lap".
const CLOSING_MAX_MS_PER_LAP = 5000;
const ERS_SETTLE_MS = 5000;
const SETTLE_MS = 5000;
// Drive-through, stop-go, time penalty, warning, disqualified.
const RADIO_PENALTY_TYPES = new Set([0, 1, 4, 5]); // not 6 ("Disqualified"): sent in F1 26 to a driver who raced on
const PENALTY_WARNING = 5;
const TEXT_HOLD_MS = 5000;
const numbersOut = (text) => String(text).replace(/[0-9]+([.:][0-9]+)?/g, '#');
// vehicleFiaFlags / zoneFlag: 0 none, 1 green, 2 blue, 3 yellow.
const FIA_BLUE = 2;
const OUT_LAP = 3; // lapData.driverStatus
const FIA_YELLOW = 3;
const YELLOW_AHEAD_M = 800;
const BLUE_LOOKUP_M = 500;
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
// Weather: warn this many laps ahead of rain; call the tyre switch once the
// other tyre is this much quicker per lap (less is lap-time noise).
const RAIN_WARN_LAPS = 10;
const CROSSOVER_MS = 1000;
const WEATHER_NAME = ['clear', 'light cloud', 'overcast', 'light rain', 'heavy rain', 'storm'];
// Damage costing less than this a lap is within lap-to-lap noise.
const DAMAGE_NOISE_MS = 150;
const DAMAGE_ADVISORY_MS = 500;
// A front wing this broken is worth a stop before it's even measured.
const WING_HEAVY_PCT = 50;
const DAMAGE_STAGES = ['damage:measuring', 'damage:cost'];

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
// Negative = closing. Null until there's a full window of green history: the
// field bunching up behind a safety car / VSC isn't pace.
function closingRateMsPerLap(car, paceMs) {
  const h = car.gapAheadHistory;
  if (h.length < 2) return null;
  const now = h[h.length - 1];
  let then = null;
  for (let i = h.length - 2; i >= 0; i--) {
    if (h[i].neutralised) break;
    if (now.t - h[i].t >= CLOSING_WINDOW_S) {
      then = h[i];
      break;
    }
  }
  if (!then || now.neutralised) return null;
  // Clean pace, not the last lap: that can be a safety-car or pit lap.
  const lapMs = paceMs || (car.lapData.currentLapNum > 2 && car.lapData.lastLapTimeInMS) || FALLBACK_LAP_MS; // not lap 1's time
  return ((now.gapMs - then.gapMs) / (now.t - then.t)) * (lapMs / 1000);
}

// Rule-based, re-evaluated every tick against the current FieldModel.
// Insights are keyed by a stable id so a still-true condition keeps the
// same card on the dashboard (refreshing its text) instead of re-firing a
// new toast every tick; a condition that's no longer true expires its id.
function createInsightEngine(fieldModel) {
  const { clock } = fieldModel;
  const tyreWearHistory = new Map(); // carIndex -> [{ lapNum, avgWear }]
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
      settleState.set(id, { key, since: clock() });
      return false;
    }
    return clock() - s.since >= SETTLE_MS;
  }

  // A new ERS tip (or none) replaces the one on screen only after it has
  // held for ERS_SETTLE_MS; the tip on screen keeps its latest text.
  let ersShown = null;
  let ersCandidate = { key: null, since: 0 };
  function settleErs(tip) {
    const key = tip ? tip.action : null;
    const shownKey = ersShown ? ersShown.action : null;
    if (key === shownKey) {
      ersCandidate = { key, since: clock() };
      ersShown = tip;
      return ersShown;
    }
    if (ersCandidate.key !== key) ersCandidate = { key, since: clock() };
    if (clock() - ersCandidate.since >= ERS_SETTLE_MS) ersShown = tip;
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
  let qualiBestMs = null; // the best lap last announced
  let qualiSeen = false;
  let trackLimitsSaid = 0; // the player's track-limit warnings already on the radio
  let startSaid = false;

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
      lastEventSeq = 0;
      fuelReading = null;
      ersShown = null;
      ersCandidate = { key: null, since: 0 };
      settleState.clear();
      announcedRetirements.clear();
      qualiBestMs = null;
      qualiSeen = false;
      trackLimitsSaid = 0;
      startSaid = false;
      shownCall = null;
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
    let fuelSavePct = null;

    const ordered = fieldModel.orderedByPosition();
    const myPosIdx = ordered.findIndex((c) => c.carIndex === playerIdx);
    const ahead = myPosIdx > 0 ? ordered[myPosIdx - 1] : null;
    const behind = myPosIdx >= 0 && myPosIdx < ordered.length - 1 ? ordered[myPosIdx + 1] : null;

    const session = fieldModel.getSession();
    const racing = isRacing(session);

    // --- Tyres: laps-to-cliff projection (a race thing: a qualifying run is three laps) ---
    const wear = trackTyreWear(playerIdx, player);
    if (racing && wear && wear.ratePerLap > 0) {
      lapsToCliff = (TYRE_CLIFF_THRESHOLD_PCT - wear.avgWear) / wear.ratePerLap;
      if (lapsToCliff <= 3) {
        upsert('tyre-cliff', {
          severity: lapsToCliff <= 1 ? SEVERITY.CRITICAL : SEVERITY.ADVISORY,
          category: CATEGORY.STRATEGY,
          message: lapsToCliff < 0.5
            ? 'Tyres: at the cliff - lap time is going'
            : `Tyres: ~${laps(Math.round(lapsToCliff))} to the cliff at this wear rate`,
          expiresAtMs: clock() + 15000,
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
      // A lap of fuel is a lap's burn: 0.4 laps short with 14 to go = save ~3% of every lap's fuel.
      fuelSavePct = fuelDelta < 0 && lapsLeft >= 1 ? Math.max(1, Math.round((-fuelDelta / lapsLeft) * 100)) : null;
      if (fuelDelta < 0.3) {
        upsert('fuel-risk', {
          severity: fuelDelta < 0 ? SEVERITY.CRITICAL : SEVERITY.ADVISORY,
          category: CATEGORY.STRATEGY,
          message: fuelDelta < 0
            ? `Fuel: on pace to run ${Math.abs(fuelDelta).toFixed(1)} laps short - save ~${fuelSavePct}% a lap: lift and coast into the big stops`
            : `Fuel: only ${fuelDelta.toFixed(1)} laps of margin to the end`,
          expiresAtMs: clock() + 15000,
        });
      } else {
        expire('fuel-risk');
      }
    }

    // --- Pace vs car ahead: is the gap closing? ---
    // Compares the gap now with the gap ~30s of game time ago and expresses
    // it per lap, which is how an engineer would call it on the radio.
    const closingRate = closingRateMsPerLap(player, analysis && analysis.playerPaceMs);
    const greenRacing = playerOnTrack && !neutralised;
    // Not on lap 1: the start scrambles every gap.
    const pastLap1 = player.lapData.currentLapNum > 1;
    if (!(racing && greenRacing && pastLap1)) expire('closing-ahead');
    if (racing && greenRacing && pastLap1 && onTrack(ahead) && closingRate != null) {
      if (closingRate <= CLOSING_THRESHOLD_MS_PER_LAP && closingRate >= -CLOSING_MAX_MS_PER_LAP && player.lapData.deltaToCarInFrontInMS >= CLOSING_MIN_GAP_MS) {
        upsert('closing-ahead', {
          severity: SEVERITY.INFO,
          category: CATEGORY.PACE,
          message: `Closing on P${ahead.lapData.carPosition} by ${(Math.abs(closingRate) / 1000).toFixed(1)}s/lap - gap ${(player.lapData.deltaToCarInFrontInMS / 1000).toFixed(1)}s`,
          expiresAtMs: clock() + 10000,
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
    // Not on lap 1 either: the whole field is nose to tail, and one real start
    // named eleven different "right behind you" cars in under a minute.
    // The battle call's DEFEND speaks on this same card (below), so the
    // driver hears one defend call, not two that take turns - 45 of 55 key
    // calls in a real race were the pair. While it holds the card, it owns it.
    const bc = analysis && analysis.battle && analysis.battle.call;
    const prevDefend = activeInsights.get('under-attack');
    const battleDefending = !!(bc && bc.mode === 'DEFEND' && prevDefend && prevDefend.battle);
    if (!(racing && greenRacing && pastLap1)) expire('under-attack');
    if (racing && greenRacing && pastLap1 && gapBehindNow > 0 && !battleDefending) {
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
          expiresAtMs: clock() + 8000,
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
        upsert(id, { severity: SEVERITY.INFO, category: CATEGORY.CAR, message: tip.radio, expiresAtMs: clock() + 5000 });
      } else {
        expire(id);
      }
    }

    // --- ATTACK / DEFEND: the one battle call (analysis/battleCall.js) ---
    // Settled like the other who-and-where calls, and the single voice of
    // the battle: when it's active, the older separate "defend" and "best
    // chance" calls stand down so nothing is said twice. DEFEND takes over
    // the defend card ('under-attack') rather than adding one.
    battleShown = null;
    if (racing && greenRacing && bc && (bc.mode === 'ATTACK' || bc.mode === 'DEFEND' || bc.mode === 'CLOSE IN')
      && settled('battle-call', `${bc.mode}:${bc.target}`)) {
      battleShown = bc;
      const text = bc.mode === 'ATTACK' ? `Attack ${bc.target} - ${bc.reason}` : bc.mode === 'DEFEND' ? `Defend from ${bc.target} - ${bc.reason}` : `Close in on ${bc.target} - ${bc.reason}`;
      const id = bc.mode === 'DEFEND' ? 'under-attack' : 'battle-call';
      expire(id === 'under-attack' ? 'battle-call' : 'under-attack');
      upsert(id, { severity: bc.mode === 'CLOSE IN' ? SEVERITY.INFO : SEVERITY.ADVISORY, category: CATEGORY.PACE, message: text, expiresAtMs: clock() + 4000, battle: true });
    } else if (!bc || bc.mode === 'CLEAR' || bc.mode === 'HOLD' || !(racing && greenRacing)) {
      expire('battle-call');
      if (prevDefend && prevDefend.battle) expire('under-attack');
    }
    if (activeInsights.has('battle-call') || battleDefending || (battleShown && battleShown.mode === 'DEFEND')) {
      expire('attack-chance');
    }
    if (bc && (bc.mode === 'CLEAR' || bc.mode === 'HOLD')) battleShown = bc;

    // --- Safety car / VSC / red flag: the options, once per decision ---
    const opts = analysis && analysis.options;
    // The settled pick, which the card shows - the cheap-stop call follows it, not a flicker.
    const optsSettled = !!(racing && opts && settled('sc-options', `${opts.situation}:${opts.recommendedId}`));
    if (optsSettled) {
      upsert('sc-options', { severity: SEVERITY.ADVISORY, category: CATEGORY.STRATEGY, message: opts.headline, expiresAtMs: clock() + 4000 });
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
        expiresAtMs: clock() + 5000,
      });
    } else {
      expire('attack-warning');
    }
    const afc = analysis && analysis.battle && analysis.battle.attackForecast;
    if (racing && greenRacing && ahead && afc && afc.where && afc.when.laps <= 2 && !activeInsights.has('battle-call') && !(activeInsights.get('under-attack') || {}).battle
      && settled('attack-chance', `${ahead.carIndex}:${afc.where.corner}`)) {
      const gain = afc.candidates && afc.candidates[0] && afc.candidates[0].gainS >= 0.02 ? ` - you gain ${afc.candidates[0].gainS.toFixed(2)}s on the run to it` : '';
      upsert('attack-chance', {
        severity: SEVERITY.INFO,
        category: CATEGORY.PACE,
        message: `Best chance on ${nameOf(ahead)}: into corner ${afc.where.corner} (${km(afc.where.atM)})${gain}`,
        expiresAtMs: clock() + 5000,
      });
    } else {
      expire('attack-chance');
    }

    // --- 2026: Overtake mode earned on the car ahead ---
    const ot = analysis && analysis.overtake;
    if (racing && greenRacing && ot && ot.available && onTrack(ahead) && player.lapData.deltaToCarInFrontInMS > 0 && player.lapData.deltaToCarInFrontInMS < 1500) {
      const name = ahead.participant && ahead.participant.name ? ahead.participant.name : `P${ahead.lapData.carPosition}`;
      upsert('overtake-ready', { severity: SEVERITY.INFO, category: CATEGORY.PACE, message: `Overtake mode available on ${name} - use it on the straight`, expiresAtMs: clock() + 4000 });
    } else {
      expire('overtake-ready');
    }

    // --- ML tyre model: would fresh tyres pay for a stop? ---
    // Only until pit timing has an answer - it says which lap, not just whether.
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

    // --- Undercut window on the car ahead ---
    // The HUD shows the gap; it doesn't say whether stopping now would jump
    // the car. Close behind it, on tyres at least as old, rejoining in clean
    // air with enough race left - and fresh tyres gaining more in the laps
    // before they stop than the gap to them: that's the classic undercut.
    const rejoin = analysis && analysis.rejoin;
    const theirAge = ahead && ahead.status ? ahead.status.tyresAgeLaps : null;
    const gapAheadNow = player.lapData.deltaToCarInFrontInMS;
    const rowOf = (c) => (c && analysis && analysis.field ? analysis.field.find((r) => r.carIndex === c.carIndex) : null);
    const aheadRow = rowOf(ahead);
    const behindRow = rowOf(behind);
    const theyStopIn = aheadRow ? aheadRow.stopInLaps : null;
    const myDegMs = analysis && analysis.tyreModel && analysis.tyreModel.mine ? analysis.tyreModel.mine.degMsPerLap : null;
    const undercutGainMs = myDegMs > 0 && theyStopIn != null ? myDegMs * (theirAge ?? myTyreAge) * Math.max(1, theyStopIn) : 0;
    const undercutOn = racing && greenRacing && onTrack(ahead) && rejoin && !rejoin.inTraffic
      && gapAheadNow > 0 && gapAheadNow <= UNDERCUT_GAP_MS
      && myTyreAge >= STOP_WORTH_IT_TYRE_AGE && (theirAge == null || theirAge >= myTyreAge - 2)
      && theyStopIn != null && theyStopIn <= UNDERCUT_THEY_STOP_WITHIN
      && (lapsLeft == null || lapsLeft >= UNDERCUT_MIN_LAPS_LEFT)
      && undercutGainMs > gapAheadNow;
    let undercutTarget = null;
    if (undercutOn) {
      const name = ahead.participant ? ahead.participant.name : `P${ahead.lapData.carPosition}`;
      undercutTarget = name;
      upsert('undercut-window', {
        severity: SEVERITY.INFO,
        category: CATEGORY.STRATEGY,
        message: `Undercut on ${name} is on - they're due in ${theyStopIn <= 1 ? 'this lap or next' : `~${laps(theyStopIn)}`}: box now, ~${((undercutGainMs - gapAheadNow) / 1000).toFixed(1)}s ahead after their stop`,
        expiresAtMs: clock() + 5000,
      });
    } else {
      expire('undercut-window');
    }

    // --- A neighbour about to box: their stop changes your race ---
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

    // --- Pit window: the simulator says this lap is the one ---
    const pt = analysis && analysis.pitTiming;
    const best = pt && pt.options.find((o) => o.best);
    let pitWindow = null;
    if (racing && greenRacing && best && best.inLaps === 0 && pt.marginS >= PIT_WINDOW_MARGIN_S) {
      pitWindow = `Pit window - box this lap, rejoin P${best.rejoinPosition}${best.inTraffic ? ' in traffic' : ''} on ${best.compoundName.toLowerCase()}s`;
      upsert('pit-window', {
        severity: SEVERITY.ADVISORY,
        category: CATEGORY.STRATEGY,
        message: `${pitWindow}, ${pt.marginS.toFixed(1)}s better than waiting`,
        expiresAtMs: clock() + 5000,
      });
    } else {
      expire('pit-window');
    }

    // --- Cheap stop under a safety car / VSC ---
    // The biggest strategy swing of most races, and the game only tells you
    // the safety car is out - not what a stop costs now.
    let cheapStop = null;
    // The options card weighs the stop against the position: the call boxes only on its settled box.
    const optsSayBox = !opts || (optsSettled && opts.recommendedId !== 'stay');
    if (racing && neutralised && !redFlag && playerOnTrack && optsSayBox && myTyreAge >= STOP_WORTH_IT_TYRE_AGE
      && (lapsLeft == null || lapsLeft >= CHEAP_STOP_MIN_LAPS_LEFT)) {
      const pl = analysis && analysis.pitLoss;
      cheapStop = pl && pl.ms < pl.normalMs
        ? `${neutralised}: a stop costs ~${Math.round(pl.ms / 1000)}s, not ~${Math.round(pl.normalMs / 1000)}s`
        : `${neutralised}: pit stops are cheap now`;
      upsert('cheap-stop', {
        severity: SEVERITY.ADVISORY,
        category: CATEGORY.STRATEGY,
        message: `${cheapStop} - box this lap?`,
        expiresAtMs: clock() + 5000,
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
    const rainDue = !!(nc && nc.to === 'rain' && !nc.afterFlag && nc.inLaps <= RAIN_WARN_LAPS);
    if (rainDue) {
      if (wx.playerOnSlicks) rainInLaps = nc.inLaps;
      // Judged on the rounded figure the message shows, so "~3 laps" is always imminent.
      const imminent = Math.round(nc.inLaps) <= RAIN_IMMINENT_LAPS;
      if (wx.playerOnSlicks && imminent) rainSoonLaps = nc.inLaps;
      upsert('rain-coming', {
        severity: imminent ? SEVERITY.ADVISORY : SEVERITY.INFO,
        category: CATEGORY.STRATEGY,
        // To the nearest 10%: the game nudges it every few seconds.
        message: `Rain within ${lapsAway(nc.inLaps)} (${WEATHER_NAME[nc.weather]}, ${Math.round(nc.rainPct / 10) * 10}%)${wx.playerOnSlicks ? ' - plan the inters stop' : ''}`,
        expiresAtMs: clock() + 5000,
      });
    } else {
      expire('rain-coming');
    }
    if (nc && nc.to === 'dry' && !nc.afterFlag) {
      upsert('rain-stopping', {
        severity: SEVERITY.INFO,
        category: CATEGORY.STRATEGY,
        message: `Rain stops within ${lapsAway(nc.inLaps)} - then the track starts drying`,
        expiresAtMs: clock() + 5000,
      });
    } else {
      expire('rain-stopping');
    }
    let weatherBox = null;
    const cx = wx && wx.crossover;
    // Lap times can mislead (a fast car on the wrong tyre), the sky can't: no
    // inters on a dry track with no rain due, no slicks while it's raining.
    if (playerOnTrack && cx && cx.wetGainMs != null) {
      if (wx.playerOnSlicks && (wx.nowWet || rainDue) && cx.wetGainMs >= CROSSOVER_MS) {
        weatherBox = `Inters ${(cx.wetGainMs / 1000).toFixed(1)}s/lap faster - box for inters`;
      } else if (wx.playerOnWets && !wx.nowWet && -cx.wetGainMs >= CROSSOVER_MS) {
        weatherBox = `Slicks ${(-cx.wetGainMs / 1000).toFixed(1)}s/lap faster - box for slicks`;
      }
    }
    if (weatherBox) {
      const n = cx.basis === 'switchers' ? cx.switchers : wx.playerOnSlicks ? cx.wetCars : cx.slickCars;
      upsert('crossover', {
        severity: SEVERITY.ADVISORY,
        category: CATEGORY.STRATEGY,
        message: `${weatherBox} (${n} car${n === 1 ? '' : 's'} ${cx.basis === 'switchers' ? `that switched, before vs after` : 'on them'})`,
        expiresAtMs: clock() + 5000,
      });
    } else {
      expire('crossover');
    }
    // Before anyone is on inters there are no lap times to compare: box on the
    // forecast once the rain is under a lap away, or a few laps out when a
    // safety car makes the stop cheap enough to pay for the dry laps on inters.
    const rs = analysis && analysis.rainStop;
    if (!weatherBox && playerOnTrack && rainDue && wx.playerOnSlicks) {
      const n = Math.max(1, Math.round(nc.inLaps));
      if (n <= 1) weatherBox = `Rain within ~${laps(1)} - box for inters`;
      else if (neutralised && !redFlag && rs && rs.gainS > 0) weatherBox = `${neutralised}, rain within ~${laps(n)} - box for inters, ~${Math.max(1, Math.round(rs.gainS))}s better than stopping later`;
    }

    // --- A neighbour just pitted ---
    // The car behind stopping is the undercut threat (fresh tyres, it can jump
    // us by stopping first). The car ahead stopping is the opposite: clean air
    // for us to stay out and push - the overcut.
    // Classified by the positions recorded at pit entry, not now: the car
    // loses places down the pit lane and would otherwise flip sides.
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

    // --- Damage: what it's costing, measured from your mini-sectors ---
    // One card per stage ("measuring", then the figure), so each is said once
    // and the number can firm up on screen without being read out again.
    const dmg = analysis && analysis.damage;
    let damageBox = null;
    let damageCard = null;
    if (dmg && playerOnTrack) {
      const what = dmg.parts.map((x) => `${x.label.toLowerCase()} ${x.pct}%`).join(', ');
      const loss = dmg.lossPerLapMs;
      const heavyWing = dmg.parts.some((x) => x.fixable && x.pct >= WING_HEAVY_PCT);
      if (loss == null) {
        damageCard = { id: 'damage:measuring', message: `Damage: ${what} - ${dmg.basis === 'no-baseline' ? 'no clean lap before it to measure against' : 'measuring what it costs'}` };
        if (racing && heavyWing && dmg.basis === 'no-baseline' && (lapsLeft == null || lapsLeft > CHEAP_STOP_MIN_LAPS_LEFT)) damageBox = 'Heavy front wing damage - box for a new nose';
      } else if (loss < DAMAGE_NOISE_MS) {
        damageCard = { id: 'damage:cost', message: `Damage: ${what} - not costing lap time` };
      } else {
        const where = dmg.where.length ? `, most of it at corner${dmg.where.length > 1 ? 's' : ''} ${dmg.where.join(' and ')}` : '';
        const flag = dmg.toFlagMs ? ` (~${Math.round(dmg.toFlagMs / 1000)}s to the flag)` : '';
        let verdict = '';
        if (dmg.fix) {
          if (dmg.fix.pays && dmg.fix.stopAnyway) verdict = ' - change the nose at your stop';
          else if (dmg.fix.pays) verdict = ` - a new nose costs ~${Math.round(dmg.fix.costMs / 1000)}s: box`;
          else verdict = ` - a new nose costs ~${Math.round(dmg.fix.costMs / 1000)}s: stay out`;
        }
        if (racing && dmg.fix && dmg.fix.pays && !dmg.fix.stopAnyway) damageBox = `Front wing costing ~${(loss / 1000).toFixed(1)}s a lap - a new nose pays back`;
        damageCard = { id: 'damage:cost', severity: loss >= DAMAGE_ADVISORY_MS ? SEVERITY.ADVISORY : SEVERITY.INFO, message: `Damage costing ~${(loss / 1000).toFixed(1)}s a lap${dmg.basis === 'partial' ? ' (early read)' : ''}${where}${flag}${verdict}` };
      }
    }
    for (const id of DAMAGE_STAGES) if (!damageCard || damageCard.id !== id) expire(id);
    if (damageCard) {
      upsert(damageCard.id, { severity: damageCard.severity || (damageBox ? SEVERITY.ADVISORY : SEVERITY.INFO), category: CATEGORY.CAR, message: damageCard.message, expiresAtMs: clock() + 5000 });
    }

    // --- Qualifying / practice: traffic on the road, a new best ---
    const q = !racing && analysis && analysis.quali;
    const tr = q && q.traffic;
    const inTheWay = tr && (tr.ahead || tr.behind);
    if (inTheWay && settled('traffic', inTheWay.name)) {
      upsert('traffic', {
        severity: SEVERITY.INFO,
        category: CATEGORY.PACE,
        message: tr.ahead
          // The gap ticks on the This lap panel; here it would rewrite the card every tick.
          ? `Traffic: ${tr.ahead.name} on ${tr.ahead.status === 'out' ? 'an out lap' : tr.ahead.status === 'in' ? 'an in lap' : 'a slow lap'} up the road`
          : `${tr.behind.name} on a push lap behind - let them by`,
        expiresAtMs: clock() + 4000,
      });
    } else if (!inTheWay) {
      expire('traffic');
    }
    // A first time or a quicker one - but not the time already set when the dashboard joined.
    if (q && qualiSeen && q.bestMs && (qualiBestMs == null || q.bestMs < qualiBestMs)) {
      const m = Math.floor(q.bestMs / 60000);
      upsert('quali-best', {
        severity: SEVERITY.INFO,
        category: CATEGORY.PACE,
        message: `Best lap ${m}:${((q.bestMs % 60000) / 1000).toFixed(3).padStart(6, '0')} - ${standing(q)}`,
        expiresAtMs: clock() + 10000,
      });
    }
    if (q) {
      qualiSeen = true;
      if (q.bestMs) qualiBestMs = q.bestMs;
    }

    // --- Penalties and track limits ---
    const pen = analysis && analysis.penalties;
    const tl = pen ? pen.trackLimits : { count: 0 };
    // The game's own "Warning" event for the same infringement would say less.
    const trackLimitNew = tl.count > trackLimitsSaid;
    if (tl.count < trackLimitsSaid) trackLimitsSaid = tl.count; // a flashback took one back
    if (trackLimitNew) {
      trackLimitsSaid = tl.count;
      const where = !tl.last ? '' : tl.last.corner != null ? ` at turn ${tl.last.corner}` : ` at ${(tl.last.atM / 1000).toFixed(1)} km`;
      upsert(`track-limits:${tl.count}`, {
        severity: SEVERITY.ADVISORY,
        category: CATEGORY.FLAG,
        message: `Track limits - warning ${tl.count}${where}${tl.sameAgain ? ', same corner again - keep it inside there' : ''}`,
        expiresAtMs: clock() + 15000,
      });
    }
    let penaltyBox = null;
    if (pen && (pen.stopGos || pen.driveThroughs)) {
      penaltyBox = pen.stopGos ? 'Serve the stop-go - box, no tyre change' : 'Serve the drive-through - box';
      upsert('penalty-serve', { severity: SEVERITY.CRITICAL, category: CATEGORY.FLAG, message: neutralised ? `${penaltyBox} once the ${neutralised === 'Red flag' ? 'race restarts' : 'safety car is in'}` : `${penaltyBox} (3 laps to take it)`, expiresAtMs: clock() + 5000 });
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

    // --- Before the start: the plan ---
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

    // --- The start: what lap 1 did, once, as lap 2 begins ---
    const grid = player.lapData.gridPosition;
    if (racing && !startSaid && player.lapData.currentLapNum === 2 && grid > 0) {
      startSaid = true;
      const pos = player.lapData.carPosition;
      const d = grid - pos;
      upsert('start', {
        severity: SEVERITY.INFO,
        category: CATEGORY.PACE,
        message: `Lap 1: P${pos} from P${grid} on the grid - ${d > 0 ? `up ${d}` : d < 0 ? `down ${-d}` : 'held position'}`,
        expiresAtMs: clock() + 15000,
      });
    }

    // --- Tyre temperatures, against your own racing laps ---
    const tt = racing && analysis && analysis.tyreTemps;
    const fiveC = (c) => Math.max(5, Math.round(c / 5) * 5);
    // Behind the safety car or on an out lap: the moment to get heat in.
    if (tt && tt.coldByC && (neutralised || player.lapData.driverStatus === OUT_LAP)) {
      upsert('tyres-cold', {
        severity: SEVERITY.ADVISORY,
        category: CATEGORY.CAR,
        message: `Tyres ~${fiveC(tt.coldByC)}°C under racing temperature - ${neutralised ? 'get heat in before the restart' : 'careful on the out lap'}`,
        expiresAtMs: clock() + 5000,
      });
    } else {
      expire('tyres-cold');
    }
    if (tt && tt.hot && !neutralised && playerOnTrack) {
      upsert('tyres-hot', {
        severity: SEVERITY.INFO,
        category: CATEGORY.CAR,
        message: tt.hot.axle === 'rear'
          ? `Rears ~${fiveC(tt.hot.byC)}°C hotter than early in the stint - easy on the throttle out of slow corners`
          : `Fronts ~${fiveC(tt.hot.byC)}°C hotter than early in the stint - less lock, brake in a straight line`,
        expiresAtMs: clock() + 5000,
      });
    } else {
      expire('tyres-hot');
    }

    // --- Flags: a yellow round the next corners, a blue for the car lapping you ---
    // The HUD shows the flag for where you are; a yellow a few hundred metres
    // on is the one worth hearing early (a stopped car after a blind corner).
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

    // --- Discrete event callouts (safety car, flags, fastest lap, penalties) ---
    // Every event since the last tick, not just the newest: a safety car
    // followed within 100ms by a speed-trap or button event must still land.
    for (const event of fieldModel.getRecentEvents()) {
      if (event.seq <= lastEventSeq) continue;
      lastEventSeq = event.seq;
      if (!ALERT_EVENT_CODES.has(event.code) || clock() - event.atMs >= EVENT_CARD_MS) continue;
      if (trackLimitNew && event.code === 'PENA' && event.penaltyType === PENALTY_WARNING) continue;
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
      fuelSavePct,
      tyreLapsToCliff: lapsToCliff == null ? null : Math.max(0, lapsToCliff),
      tyreWearRatePerLap: wear ? wear.ratePerLap : null,
      call: q ? qualiCall(q) : steadyCall(raceCall({ lapsLeft, lapsToCliff, fuelMarginLaps, fuelSavePct, inPits: !playerOnTrack, neutralised, cheapStop, undercutOn: undercutTarget, weatherBox, rainSoonLaps, rainInLaps, pitWindow, damageBox, penaltyBox })),
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
