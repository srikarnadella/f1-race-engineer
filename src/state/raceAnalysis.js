// Field-wide numbers the game's own HUD never shows: each car's clean-lap
// pace, whether gaps are growing or shrinking per lap, what a pit stop
// actually costs at this track today, and where the player would rejoin if
// they boxed now. Recomputed on every snapshot tick from FieldModel.

const { createWeatherAnalysis } = require('./weather');
const { raceLapsLeft, median } = require('./race');
const { fitDegradation, stopPayback } = require('../ml/tyreModel');
const { pairFeatures, toVector } = require('../ml/overtakeFeatures');
const { predict } = require('../ml/logistic');
const { forecastAttack } = require('../analysis/attackForecast');
const { strategyOptions } = require('../analysis/strategyOptions');
const { battleCall } = require('../analysis/battleCall');
const { projectBattery } = require('../analysis/batteryProjection');
const { pitTiming } = require('../analysis/pitTiming');

// The trained overtake model (npm run train:overtake), if one has been built.
let OVERTAKE_MODEL = null;
try {
  OVERTAKE_MODEL = require('../ml/models/overtake.json');
} catch (_) {
  OVERTAKE_MODEL = null;
}
// The model is well calibrated up to ~40% and overconfident above (few
// samples), so the dashboard gets a level plus a capped percentage.
const PASS_CAP = 0.5;
const MIN_DEG_CARS = 5;
const MIN_DEG_LAPS = 25;
const passLevel = (p) => (p >= 0.25 ? 'high' : p >= 0.1 ? 'medium' : 'low');
function passChance(attacker, defender) {
  if (!OVERTAKE_MODEL || !attacker || !defender) return null;
  const f = pairFeatures(attacker, defender);
  if (!f || f.gapS > 3) return null;
  const x = OVERTAKE_MODEL.features.map((k) => f[k]);
  const p = predict(OVERTAKE_MODEL, x);
  return { p: Math.min(PASS_CAP, Math.round(p * 100) / 100), level: passLevel(p), horizonS: OVERTAKE_MODEL.horizonS };
}

// Where passes happen at each track, learned from recorded races
// (npm run train:overtake) - the prior for the attack forecast, topped up
// live with this session's own passes.
let PASS_HOTSPOTS = {};
try {
  PASS_HOTSPOTS = require('../ml/models/pass-hotspots.json').tracks || {};
} catch (_) {
  PASS_HOTSPOTS = {};
}
function knownPassesAt(trackId, trackLength, sessionPasses, usePrior = true) {
  const prior = usePrior ? PASS_HOTSPOTS[trackId] : null;
  const out = sessionPasses.map((p) => p.atM);
  // Only trust the stored map if it's for this layout (same length).
  if (prior && trackLength && Math.abs(prior.lengthM - trackLength) < 50) {
    prior.counts.forEach((n, i) => {
      for (let k = 0; k < n; k++) out.push((i + 0.5) * prior.binM);
    });
  }
  return out;
}

// Fuel used per lap across the field (median of lap-to-lap drops).
function fieldBurnKgPerLap(cars) {
  const drops = [];
  for (const car of cars) {
    const h = car.lapHistory.filter((l) => l.fuelKg != null);
    for (let k = 1; k < h.length; k++) if (h[k].lapNum === h[k - 1].lapNum + 1 && h[k - 1].fuelKg > h[k].fuelKg) drops.push(h[k - 1].fuelKg - h[k].fuelKg);
  }
  return drops.length >= 3 ? median(drops) : 1.6;
}

const PACE_LAPS = 3;
const DRS_RANGE_MS = 1000;
const MAX_PROJECTION_LAPS = 30;
const TRAFFIC_MS = 1500;
const PIT_LOSS_SANE_RANGE_MS = [8000, 45000];
// A new best lap to box on must hold this long before it's shown.
const PICK_SETTLE_MS = 5000;

// Rough pit-lane time loss by F1 trackId (pit entry to exit vs. a racing
// lap, stationary time included). Only a starting point: as soon as anyone
// completes a stop this session, the measured figure replaces it.
const PIT_LOSS_ESTIMATE_MS = {
  0: 19000, 2: 22000, 3: 23000, 4: 21000, 5: 19000, 6: 18000, 7: 20000, 9: 20000,
  10: 18000, 11: 23000, 12: 28000, 13: 22000, 14: 21000, 15: 20000, 16: 21000, 17: 20000,
  19: 22000, 20: 19000, 26: 21000, 27: 27000, 29: 20000, 30: 20000, 31: 20000, 32: 25000,
};
const PIT_LOSS_FALLBACK_MS = 22000;
// The field crawls under a safety car (1) or VSC (2) while the pit lane
// speed limit doesn't change, so a stop costs a fraction of its usual time.
// Rough real-world ratios; the reason a stop under yellow is "cheap".
const NEUTRALISED_PIT_LOSS_FACTOR = { 1: 0.55, 2: 0.65 };
const NEUTRALISED_LABEL = { 1: 'SC', 2: 'VSC' };

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// Average of the last few laps that weren't pit or safety-car laps.
function cleanPaceMs(car) {
  const clean = car.lapHistory.filter((l) => !l.pit && !l.neutralised).slice(-PACE_LAPS);
  return clean.length ? Math.round(avg(clean.map((l) => l.lapMs))) : null;
}

// Signed gap between two cars in an ordered list, summing the intervals in
// between (each car only reports its interval to the car directly ahead).
// Negative = `theirIdx` is ahead of `myIdx`.
function gapBetweenMs(ordered, myIdx, theirIdx) {
  const [from, to] = theirIdx < myIdx ? [theirIdx, myIdx] : [myIdx, theirIdx];
  let sum = 0;
  for (let k = from + 1; k <= to; k++) sum += ordered[k].lapData.deltaToCarInFrontInMS || 0;
  return theirIdx < myIdx ? -sum : sum;
}

const isRunning = (car) => car.lapData && (car.lapData.resultStatus == null || car.lapData.resultStatus === 2);
// Driver name from the Participants packet, which may not have arrived yet.
const nameOf = (car, fallback = `Car ${car.carIndex}`) => (car.participant && car.participant.name) || fallback;

// If the player boxed now: their time behind the leader grows by the pit
// loss; everyone else is assumed to stay out. Where does that slot in?
// The game reports a gap to the leader of 0 while a car is in the pit lane
// and for ~8s after it rejoins (seen on a real F1 26 race). Taken literally,
// every car mid-stop counts as leading the race, which put a rejoin in a
// pit cycle 8 places out (npm run accuracy) - so an unknown gap takes the
// time of the car ahead in the running order instead.
function timesBehindLeader(ordered) {
  const t = new Map();
  let prev = 0;
  for (const c of ordered) {
    const d = c.lapData.deltaToRaceLeaderInMS;
    prev = c.lapData.carPosition === 1 ? 0 : d > 0 ? d : prev;
    t.set(c.carIndex, prev);
  }
  return t;
}

function predictRejoin(ordered, player, loss) {
  if (!player.lapData || player.lapData.pitStatus !== 0) return null;
  // Our own gap unknown (just out of the pits, or a red flag): no guess beats a wrong one.
  if (player.lapData.carPosition !== 1 && !(player.lapData.deltaToRaceLeaderInMS > 0)) return null;
  const times = timesBehindLeader(ordered);
  const myTime = (times.get(player.carIndex) || 0) + loss;
  const others = ordered
    .filter((c) => c.carIndex !== player.carIndex && isRunning(c))
    .map((c) => ({ car: c, t: times.get(c.carIndex) || 0 }))
    .sort((a, b) => a.t - b.t);
  // Most of the field without a gap is a red flag or a restart, not a race order.
  const known = others.filter((o) => o.car.lapData.carPosition === 1 || o.car.lapData.deltaToRaceLeaderInMS > 0).length;
  if (known < others.length / 2) return null;
  const aheadList = others.filter((o) => o.t < myTime);
  const ahead = aheadList[aheadList.length - 1];
  const behind = others.find((o) => o.t >= myTime);
  const summary = (o, gapMs) => o && {
    carIndex: o.car.carIndex,
    name: nameOf(o.car),
    gapMs: Math.round(gapMs),
    tyreCompound: o.car.status ? o.car.status.visualTyreCompound : null,
    tyresAgeLaps: o.car.status ? o.car.status.tyresAgeLaps : null,
  };
  const position = aheadList.length + 1;
  return {
    position,
    positionsLost: position - player.lapData.carPosition,
    // Rejoining within this of the car ahead means a stint stuck in its dirty air.
    inTraffic: !!ahead && myTime - ahead.t < TRAFFIC_MS,
    ahead: summary(ahead, ahead ? myTime - ahead.t : 0),
    behind: summary(behind, behind ? behind.t - myTime : 0),
  };
}

// Builds pitTiming()'s inputs from the field. Only called once the player's
// degradation is trusted (the same bar as the stop pay-back).
const DRY = new Set([16, 17, 18]);
function pitTimingFor({ ordered, player, myPace, myDeg, tyreModel, lapsLeft, pitLossMs, prefer, hold }) {
  const degOf = (compound) => (tyreModel.compounds[compound] ? tyreModel.compounds[compound].degMsPerLap : 0);
  const age = player.status.tyresAgeLaps;
  const fitted = (player.tyreSets || []).find((x) => x.fitted);
  // The freshest dry set of each compound you have left.
  const freshest = new Map();
  for (const x of player.tyreSets || []) {
    if (!x.available || x.fitted || !DRY.has(x.visualTyreCompound)) continue;
    const b = freshest.get(x.visualTyreCompound);
    if (!b || x.lifeSpan > b.lifeSpan) freshest.set(x.visualTyreCompound, x);
  }
  // No Tyre Sets packet (older games, the synthetic demo): a new set of the same compound.
  const sets = freshest.size
    ? [...freshest.values()].map((x) => ({ compound: x.visualTyreCompound, gainMs: x.lapDeltaTimeMs ? -x.lapDeltaTimeMs : myDeg.degMsPerLap * age, degMs: degOf(x.visualTyreCompound) || myDeg.degMsPerLap, life: x.lifeSpan }))
    : [{ compound: player.status.visualTyreCompound, gainMs: myDeg.degMsPerLap * age, degMs: myDeg.degMsPerLap, life: Infinity }];
  const times = timesBehindLeader(ordered);
  const rivals = ordered
    .filter((c) => c.carIndex !== player.carIndex && isRunning(c))
    .map((c) => {
      const pace = cleanPaceMs(c);
      return {
        t: times.get(c.carIndex) || 0,
        paceDeltaMs: pace == null ? 0 : pace - myPace,
        degMs: c.status ? degOf(c.status.visualTyreCompound) : 0,
        owesStop: !c.lapData.numPitStops,
      };
    });
  return pitTiming({
    me: { t: times.get(player.carIndex) || 0, position: player.lapData.carPosition, compound: player.status.visualTyreCompound, degMs: myDeg.degMsPerLap, lifeLeft: fitted ? fitted.lifeSpan : null, stopped: player.lapData.numPitStops > 0 },
    sets,
    rivals,
    laps: Math.ceil(lapsLeft),
    pitLossMs,
    prefer,
    hold,
  });
}

// options.hotspotPrior: use the pass map learned from recorded races (off when
// evaluating on those same races, so they can't leak into the score).
function createRaceAnalysis(fieldModel, { hotspotPrior = true } = {}) {
  const measuredLosses = new Map(); // `${carIndex}:${inLapNum}` -> ms; survives lapHistory rolling over
  const weatherAnalysis = createWeatherAnalysis();
  let seenGeneration = fieldModel.getGeneration();
  // The pit-timing pick (a lap number, or 'stay') and a different best lap
  // waiting to settle - it replaces the pick once it has held PICK_SETTLE_MS.
  let pitPick = null;
  let pitNext = { lap: null, since: 0 };

  // A stop splits across two laps (pit entry before the line, box after it),
  // so loss = in-lap + out-lap - 2 x the car's clean pace around it.
  function measurePitLosses(car) {
    const h = car.lapHistory;
    for (let k = 0; k < h.length - 1; k++) {
      const inLap = h[k];
      const outLap = h[k + 1];
      if (!inLap.pit || !outLap.pit || outLap.lapNum !== inLap.lapNum + 1) continue;
      if (inLap.neutralised || outLap.neutralised) continue; // a stop under SC/VSC is cheaper, not typical
      const key = `${car.carIndex}:${inLap.lapNum}`;
      if (measuredLosses.has(key)) continue;
      const around = [...h.slice(0, k), ...h.slice(k + 2)].filter((l) => !l.pit && !l.neutralised);
      if (!around.length) continue;
      const loss = inLap.lapMs + outLap.lapMs - 2 * avg(around.slice(-PACE_LAPS).map((l) => l.lapMs));
      if (loss >= PIT_LOSS_SANE_RANGE_MS[0] && loss <= PIT_LOSS_SANE_RANGE_MS[1]) {
        measuredLosses.set(key, { ms: Math.round(loss), by: nameOf(car) });
      }
    }
  }

  // ms is what a stop costs right now; normalMs is the green-flag figure.
  function pitLoss(session) {
    let base;
    if (measuredLosses.size) {
      const samples = [...measuredLosses.values()];
      base = {
        normalMs: Math.round(median(samples.map((s) => s.ms))),
        source: 'measured',
        samples: samples.length,
        lastMeasuredFrom: samples[samples.length - 1].by,
      };
    } else {
      const est = session && PIT_LOSS_ESTIMATE_MS[session.trackId];
      base = { normalMs: est || PIT_LOSS_FALLBACK_MS, source: est ? 'track estimate' : 'generic estimate', samples: 0, lastMeasuredFrom: null };
    }
    const sc = session && session.safetyCarStatus;
    const factor = NEUTRALISED_PIT_LOSS_FACTOR[sc];
    return { ms: factor ? Math.round(base.normalMs * factor) : base.normalMs, neutralised: NEUTRALISED_LABEL[sc] || null, ...base };
  }

  function compute() {
    if (fieldModel.getGeneration() !== seenGeneration) {
      seenGeneration = fieldModel.getGeneration();
      measuredLosses.clear();
      weatherAnalysis.reset();
      pitPick = null;
      pitNext = { lap: null, since: 0 };
    }
    const playerIdx = fieldModel.playerIndex();
    const ordered = fieldModel.orderedByPosition();
    for (const car of ordered) measurePitLosses(car);
    const session = fieldModel.getSession();
    const loss = pitLoss(session);

    const myPos = ordered.findIndex((c) => c.carIndex === playerIdx);
    const playerCar = myPos === -1 ? null : ordered[myPos];
    const myPace = playerCar ? cleanPaceMs(playerCar) : null;
    const weather = weatherAnalysis.compute({
      session,
      sessionTime: fieldModel.getSessionTime(),
      lapMs: myPace || (playerCar && playerCar.lapData.lastLapTimeInMS),
      lapsLeft: playerCar ? raceLapsLeft(session, playerCar.lapData) : null,
      cars: ordered,
      player: playerCar,
    });

    if (myPos === -1) return { field: [], playerPaceMs: null, pitLoss: loss, rejoin: null, weather };
    const player = playerCar;

    const field = ordered.map((car, j) => {
      const pace = cleanPaceMs(car);
      const gap = gapBetweenMs(ordered, myPos, j);
      const isPlayer = j === myPos;
      // Change in the size of the gap per lap: negative = it's shrinking.
      let gapTrend = null;
      if (!isPlayer && pace != null && myPace != null) gapTrend = j < myPos ? myPace - pace : pace - myPace;
      // A projection 75 laps out is noise, not information.
      const closing = gapTrend != null && gapTrend < 0 && Math.abs(gap) / -gapTrend <= MAX_PROJECTION_LAPS;
      const absGap = Math.abs(gap);
      return {
        carIndex: car.carIndex,
        position: car.lapData.carPosition,
        name: nameOf(car),
        teamId: car.participant ? car.participant.teamId : null,
        isPlayer,
        gapToPlayerMs: isPlayer ? 0 : gap,
        intervalMs: j === 0 ? null : car.lapData.deltaToCarInFrontInMS,
        lastLapTimeInMS: car.lapData.lastLapTimeInMS,
        paceMs: pace,
        gapTrendMsPerLap: gapTrend,
        lapsToDrs: closing && absGap > DRS_RANGE_MS ? (absGap - DRS_RANGE_MS) / -gapTrend : null,
        lapsToCatch: closing ? absGap / -gapTrend : null,
        tyreCompound: car.status ? car.status.visualTyreCompound : null,
        tyresAgeLaps: car.status ? car.status.tyresAgeLaps : null,
        numPitStops: car.lapData.numPitStops,
        pitStatus: car.lapData.pitStatus,
        running: isRunning(car),
        // F1 26 Overtake mode: this car has it available right now.
        overtakeAvailable: car.telemetry2 ? car.telemetry2.overtakeAvailable : null,
      };
    });

    // ML: pass / threat chance for the battles either side of the player.
    const ahead = myPos > 0 ? ordered[myPos - 1] : null;
    const behind = myPos < ordered.length - 1 ? ordered[myPos + 1] : null;
    const battle = { attack: passChance(player, ahead), defend: passChance(behind, player) };

    // When and where the car behind is likely to attack - and your best
    // chance on the car ahead. Closing rate from clean-lap pace (field rows).
    const corners = fieldModel.getPlayerCorners();
    const passesAtM = knownPassesAt(session && session.trackId, session && session.trackLength, fieldModel.getPassLog(), hotspotPrior);
    const rowOf = (car) => car && field.find((r) => r.carIndex === car.carIndex);
    const closing = (row) => (row && row.gapTrendMsPerLap != null ? -row.gapTrendMsPerLap / 1000 : 0);
    const trackLength = session && session.trackLength;
    // The player's own history this session: where they've been passed, and
    // where they've passed others.
    const log = fieldModel.getPassLog();
    const passedAt = log.filter((p) => p.overtakenIdx === player.carIndex).map((p) => p.atM);
    const passingAt = log.filter((p) => p.overtakerIdx === player.carIndex).map((p) => p.atM);
    // Not on lap 1: the corner map is still being learned, and nobody has a
    // clean lap of mini-sectors yet.
    const ready = player.lapData.currentLapNum >= 2 && player.lapData.pitStatus === 0;
    battle.defendForecast = ready && behind && behind.lapData.pitStatus === 0
      ? forecastAttack({ attacker: behind, defender: player, corners, trackLength, passesAtM, personalPassesAtM: passedAt, gapS: behind.lapData.deltaToCarInFrontInMS / 1000, closingSPerLap: closing(rowOf(behind)), role: 'defend' })
      : null;
    battle.attackForecast = ready && ahead && ahead.lapData.pitStatus === 0
      ? forecastAttack({ attacker: player, defender: ahead, corners, trackLength, passesAtM, personalPassesAtM: passingAt, gapS: player.lapData.deltaToCarInFrontInMS / 1000, closingSPerLap: closing(rowOf(ahead)), role: 'attack' })
      : null;
    // Where each battery will be at the line - who has the energy when it counts.
    battle.battery = {
      you: projectBattery(player, trackLength),
      ahead: ahead ? projectBattery(ahead, trackLength) : null,
      behind: behind ? projectBattery(behind, trackLength) : null,
    };

    // ML: field-wide tyre degradation, and whether a stop would pay off now.
    const tyreModel = fitDegradation(ordered, fieldBurnKgPerLap(ordered));
    const myCompound = player.status ? player.status.visualTyreCompound : null;
    const myDeg = tyreModel.compounds[myCompound];
    // Only trusted with enough of the field behind it: at Monaco a fit from
    // 4 cars / 16 laps read 0.21 s per lap of age - traffic, not tyres.
    const payback = myDeg && myDeg.cars >= MIN_DEG_CARS && myDeg.laps >= MIN_DEG_LAPS && player.status
      ? stopPayback({ degMsPerLap: myDeg.degMsPerLap, tyreAge: player.status.tyresAgeLaps, pitLossMs: loss.ms, lapsLeft: raceLapsLeft(session, player.lapData) })
      : null;

    const rejoin = predictRejoin(ordered, player, loss.ms);

    // ATTACK / DEFEND / CLOSE IN / CLEAR.
    const neutralisedNow = fieldModel.isRedFlag() || !!(session && session.safetyCarStatus);
    battle.call = player.lapData.pitStatus === 0 ? battleCall({
      ahead: rowOf(ahead),
      behind: rowOf(behind),
      gapAheadS: ahead ? player.lapData.deltaToCarInFrontInMS / 1000 : null,
      gapBehindS: behind ? behind.lapData.deltaToCarInFrontInMS / 1000 : null,
      battle,
      overtakeAvailable: !!(player.telemetry2 && player.telemetry2.overtakeAvailable),
      batteryPct: player.status && Number.isFinite(player.status.ersStoreEnergy) ? (player.status.ersStoreEnergy / 4e6) * 100 : null,
      neutralised: neutralisedNow,
    }) : null;

    // Under a safety car, VSC or red flag: the options, side by side.
    const situation = fieldModel.isRedFlag() ? 'Red flag' : session && session.safetyCarStatus === 1 ? 'Safety car' : session && session.safetyCarStatus === 2 ? 'VSC' : null;
    const options = situation
      ? strategyOptions({
        situation,
        lapsLeft: raceLapsLeft(session, player.lapData) ?? (session && session.totalLaps ? session.totalLaps - player.lapData.currentLapNum + 1 : null),
        player,
        tyreSets: player.tyreSets,
        rejoin,
        stopLossMs: loss.ms,
        normalLossMs: loss.normalMs,
        wetConditions: !!(weather && (weather.trackState === 'raining' || (weather.trackState === 'drying' && weather.playerOnWets))),
      })
      : null;

    // Green flag, dry, a race with laps to go: which lap to box on.
    const dry = !weather || weather.trackState === 'dry';
    const lapsLeftNow = raceLapsLeft(session, player.lapData);
    const lap = player.lapData.currentLapNum;
    const toLap = (k) => (k === 'stay' || k == null ? k : lap + k);
    const timingInputs = { ordered, player, myPace, myDeg, tyreModel, lapsLeft: lapsLeftNow, pitLossMs: loss.ms };
    let timing = !situation && dry && payback && rejoin && myPace != null && lapsLeftNow != null
      ? pitTimingFor({ ...timingInputs, prefer: pitPick === 'stay' ? 'stay' : pitPick != null ? pitPick - lap : null, hold: true })
      : null;
    if (timing) {
      const cheapest = toLap(timing.cheapestInLaps);
      const shown = toLap(timing.bestInLaps == null ? 'stay' : timing.bestInLaps);
      if (cheapest === shown) pitNext = { lap: null, since: 0 };
      else if (pitNext.lap !== cheapest) pitNext = { lap: cheapest, since: Date.now() };
      else if (Date.now() - pitNext.since >= PICK_SETTLE_MS) timing = pitTimingFor({ ...timingInputs, prefer: timing.cheapestInLaps });
      pitPick = toLap(timing.bestInLaps == null ? 'stay' : timing.bestInLaps);
    }

    return {
      field,
      playerPaceMs: myPace,
      pitLoss: loss,
      rejoin,
      options,
      pitTiming: timing,
      weather,
      battle,
      tyreModel: { ...tyreModel, mine: myDeg ? { compound: myCompound, ...myDeg } : null, payback },
      regs2026: !!(player.telemetry2 && player.telemetry2.regulations2026),
      overtake: player.telemetry2 ? { available: player.telemetry2.overtakeAvailable, active: player.telemetry2.overtakeActive, activationM: player.telemetry2.overtakeActivationDistance, aeroStraight: player.telemetry2.activeAeroMode === 1 } : null,
    };
  }

  return { compute };
}

module.exports = { predictRejoin, createRaceAnalysis, gapBetweenMs, cleanPaceMs, nameOf, PIT_LOSS_ESTIMATE_MS };
