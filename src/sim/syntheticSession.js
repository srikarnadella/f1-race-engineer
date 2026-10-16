const enc = require('./encoders');

// A scripted, physically-plausible race stint used as the demo session
// until a real F1 26 capture is committed (PROJECT_SPEC Epic C). It is NOT
// real game data - every number comes from the simple models below - but
// it is encoded into genuine F1 25-layout packets and replayed through the
// real parsers, FieldModel and InsightEngine, so the dashboard exercises
// the exact live code path.
//
// The script is tuned so each insight rule fires at a different moment:
// tyre-cliff warning, a rival pitting (undercut), a VSC, the car behind
// attacking, closing on the car ahead, and a shrinking fuel margin.

const TICK_MS = 100;
const TRACK = { id: 17, name: 'Austria', lengthM: 4318 };
const TOTAL_LAPS = 22;
const START_LAP = 15;
const END_LAP = 19; // generation stops when the player starts this lap + 1
const PLAYER = 6;
// Every car's (totalDistance, sessionTime) trace is kept this long so gaps
// can be measured the way timing screens do: how long ago the car ahead
// passed the point where this car is now.
const TRACE_TICKS = 1500;

// Weather: cloud building from the west. The game's forecast is a list of
// slots ("now", +5, +10... minutes), each re-evaluated as time passes - so
// the demo's rain first shows up beyond the flag, then moves inside the
// race distance as the forecast slides forward. The player never actually
// gets wet; the dashboard's job here is the warning.
const FORECAST_SLOTS_MIN = [0, 5, 10, 15, 30];
function weatherAt(minFromStart) {
  if (minFromStart < 4) return { weather: 1, rainPct: 10, trackTemperature: 38, airTemperature: 26 };
  if (minFromStart < 6.5) return { weather: 2, rainPct: 45, trackTemperature: 35, airTemperature: 24 };
  if (minFromStart < 20) return { weather: 3, rainPct: 75, trackTemperature: 29, airTemperature: 21 };
  return { weather: 2, rainPct: 30, trackTemperature: 31, airTemperature: 22 };
}

const COMPOUND = { SOFT: { actual: 18, visual: 16 }, MEDIUM: { actual: 19, visual: 17 }, HARD: { actual: 20, visual: 18 } };

// Array index = car index = starting order. `gap` is the starting interval
// (seconds) to the car one place ahead. The cast around the player (P7):
//   P5 RUSSELL  - worn hards, slow: the player closes on him once P6 pits
//   P6 HAMILTON - old mediums, pits at the end of lap 15: overcut chance,
//                 and the stop the dashboard measures pit loss from
//   P8 SAINZ    - fresh softs, much quicker: attacks the player
const GRID = [
  { name: 'VERSTAPPEN', team: 2, num: 1, paceMs: 65400, tyre: 'HARD', age: 9, wear: 30, gap: 0 },
  { name: 'NORRIS', team: 8, num: 4, paceMs: 65500, tyre: 'HARD', age: 9, wear: 31, gap: 1.9 },
  { name: 'PIASTRI', team: 8, num: 81, paceMs: 65650, tyre: 'HARD', age: 8, wear: 27, gap: 3.1 },
  { name: 'LECLERC', team: 1, num: 16, paceMs: 65700, tyre: 'MEDIUM', age: 15, wear: 52, gap: 1.2 },
  { name: 'RUSSELL', team: 0, num: 63, paceMs: 66800, tyre: 'HARD', age: 22, wear: 62, gap: 4.2 },
  { name: 'HAMILTON', team: 1, num: 44, paceMs: 66350, tyre: 'MEDIUM', age: 17, wear: 66, gap: 2.6, pitLap: 15 },
  { name: 'PLAYER', team: 0, num: 99, paceMs: 65800, tyre: 'MEDIUM', age: 16, wear: 61, gap: 2.4, player: true },
  { name: 'SAINZ', team: 3, num: 55, paceMs: 65200, tyre: 'SOFT', age: 4, wear: 14, gap: 3.0 },
  { name: 'ALONSO', team: 4, num: 14, paceMs: 66600, tyre: 'HARD', age: 12, wear: 40, gap: 3.4 },
  { name: 'GASLY', team: 5, num: 10, paceMs: 66700, tyre: 'MEDIUM', age: 14, wear: 49, gap: 1.6 },
  { name: 'ALBON', team: 3, num: 23, paceMs: 66750, tyre: 'HARD', age: 11, wear: 37, gap: 1.1 },
  { name: 'HULKENBERG', team: 9, num: 27, paceMs: 66800, tyre: 'HARD', age: 13, wear: 42, gap: 2.0 },
  { name: 'TSUNODA', team: 6, num: 22, paceMs: 66850, tyre: 'MEDIUM', age: 15, wear: 54, gap: 1.4 },
  { name: 'OCON', team: 7, num: 31, paceMs: 66900, tyre: 'HARD', age: 12, wear: 39, gap: 0.9 },
  { name: 'STROLL', team: 4, num: 18, paceMs: 66950, tyre: 'HARD', age: 13, wear: 41, gap: 2.7 },
  { name: 'BEARMAN', team: 7, num: 87, paceMs: 67000, tyre: 'MEDIUM', age: 16, wear: 57, gap: 1.8 },
  { name: 'ANTONELLI', team: 0, num: 12, paceMs: 66900, tyre: 'HARD', age: 6, wear: 21, gap: 3.0 },
  { name: 'LAWSON', team: 6, num: 30, paceMs: 67100, tyre: 'HARD', age: 14, wear: 44, gap: 1.3 },
  { name: 'HADJAR', team: 6, num: 6, paceMs: 67150, tyre: 'MEDIUM', age: 15, wear: 53, gap: 2.2 },
  { name: 'COLAPINTO', team: 5, num: 43, paceMs: 67250, tyre: 'HARD', age: 12, wear: 38, gap: 1.7 },
  { name: 'BORTOLETO', team: 9, num: 5, paceMs: 67300, tyre: 'HARD', age: 13, wear: 40, gap: 2.5 },
  { name: 'DOOHAN', team: 5, num: 7, paceMs: 67400, tyre: 'MEDIUM', age: 16, wear: 59, gap: 3.6 },
];

// --- Track speed profile ---------------------------------------------------
// Corners as (fraction of lap, apex speed km/h). Speed at any point is the
// slowest of each corner's "accelerate away / brake into" envelope, capped
// at vmax - a crude but convincing shape for speed, gear and throttle traces.
const CORNERS = [
  [0.07, 95], [0.27, 75], [0.4, 105], [0.52, 160], [0.6, 195], [0.72, 175], [0.86, 210], [0.96, 165],
];
const VMAX_KMH = 318;
const ACCEL_MS2 = 9;
const BRAKE_MS2 = 38;

const profile = new Float64Array(TRACK.lengthM + 1); // km/h per metre
for (let d = 0; d <= TRACK.lengthM; d++) {
  let v = VMAX_KMH / 3.6;
  for (const [frac, apexKmh] of CORNERS) {
    const apexD = frac * TRACK.lengthM;
    // Distance from the apex, wrapping around the lap.
    let after = d - apexD;
    if (after < 0) after += TRACK.lengthM;
    let before = apexD - d;
    if (before < 0) before += TRACK.lengthM;
    const vApex = apexKmh / 3.6;
    v = Math.min(v, Math.sqrt(vApex * vApex + 2 * ACCEL_MS2 * after), Math.sqrt(vApex * vApex + 2 * BRAKE_MS2 * before));
  }
  profile[d] = v * 3.6;
}
const speedAt = (lapDist) => profile[Math.max(0, Math.min(TRACK.lengthM, Math.floor(lapDist)))];

// Lap time of a car that follows the profile exactly - the reference that
// each car's target pace is scaled against.
let refLapS = 0;
for (let d = 0; d < TRACK.lengthM; d++) refLapS += 1 / (profile[d] / 3.6);
const REF_LAP_MS = refLapS * 1000;

// --- Simple car models ------------------------------------------------------
const GEAR_TOP_KMH = [0, 95, 130, 165, 200, 235, 265, 295, 330];
function gearFor(kmh) {
  for (let g = 1; g <= 8; g++) if (kmh <= GEAR_TOP_KMH[g]) return g;
  return 8;
}
function rpmFor(kmh, gear) {
  const lo = GEAR_TOP_KMH[gear - 1];
  const hi = GEAR_TOP_KMH[gear];
  return Math.round(9500 + ((kmh - lo) / (hi - lo)) * 3200);
}

// Wear (%) accrues faster as a tyre ages; lap time suffers mildly with wear
// and sharply past ~70% - the "cliff" the tyre insight is meant to predict.
function wearRatePerLap(car) {
  const base = { SOFT: 3.4, MEDIUM: 2.6, HARD: 1.9 }[car.tyre];
  return base * (1 + car.age / 12) * (car.wearScale || 1);
}
function degradationMs(car) {
  const w = car.wear;
  return w * 6 + (w > 70 ? (w - 70) * 90 : 0);
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function buildCars() {
  // Lay the field out on track: leader near the end of lap START_LAP - 1's
  // finish line, everyone else behind by their cumulative gap.
  const avgMs = REF_LAP_MS / 1000;
  let cumulativeS = 0;
  return GRID.map((g, i) => {
    cumulativeS += g.gap;
    const startDist = (START_LAP - 1) * TRACK.lengthM + 200 - cumulativeS * (TRACK.lengthM / avgMs);
    return {
      index: i,
      ...g,
      wear: g.wear,
      fuelKg: g.player ? 15.4 : 15.5,
      ersJ: 0.76 * ERS_MAX_J,
      totalDistance: startDist,
      lapStartTimeS: null,
      lastLapMs: g.paceMs + Math.round(g.wear * 6),
      numPitStops: 1,
      pitPhase: null, // null | 'in' | 'stopped' | 'out'
      pitTimerS: 0,
      wearScale: g.player ? 1.15 : 1,
      trace: [],
    };
  });
}

// Time since `ahead` was at `behind`'s current distance (binary search over
// its trace, interpolated between ticks). Falls back to a distance/average
// speed estimate when the gap is older than the trace.
function timeGapMs(ahead, behind, now) {
  const tr = ahead.trace;
  const d = behind.totalDistance;
  if (!tr.length || tr[0].d > d) return ((ahead.totalDistance - d) / TRACK.lengthM) * REF_LAP_MS;
  let lo = 0;
  let hi = tr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tr[mid].d <= d) lo = mid;
    else hi = mid;
  }
  const a = tr[lo];
  const b = tr[hi];
  const t = b.d > a.d ? a.t + ((d - a.d) / (b.d - a.d)) * (b.t - a.t) : a.t;
  return Math.max(0, (now - t) * 1000);
}

function lapNumOf(car) {
  return Math.floor(car.totalDistance / TRACK.lengthM) + 1;
}
function lapDistOf(car) {
  return ((car.totalDistance % TRACK.lengthM) + TRACK.lengthM) % TRACK.lengthM;
}

// Generates the session tick by tick, calling emit(tMs, packetBuffer).
function generate(emit, { seed = 26 } = {}) {
  const rand = makeRng(seed);
  const cars = buildCars();
  const sessionUID = 0x26f1de0000000001n;
  let sessionTime = 1830; // seconds into the session, as the game would report
  let frame = 50000;
  let vscUntilS = null;
  const firedEvents = new Set();

  const participants = cars.map((c) => ({ aiControlled: !c.player, driverId: c.player ? 255 : c.index, teamId: c.team, raceNumber: c.num, nationality: 1, name: c.name }));

  for (let tick = 0; ; tick++) {
    const tMs = tick * TICK_MS;
    const dt = TICK_MS / 1000;
    sessionTime += dt;
    frame += 6;
    const player = cars[PLAYER];
    if (lapNumOf(player) > END_LAP) break;

    // --- Scripted race events ---
    const playerLap = lapNumOf(player);
    const playerFrac = lapDistOf(player) / TRACK.lengthM;
    const events = []; // [code, detailBytes, onceKey]
    if (playerLap === 16 && playerFrac > 0.3) {
      // Fastest lap: Sainz on fresh softs. Detail = vehicleIdx, float lapTime (s).
      const lapTime = Buffer.alloc(4);
      lapTime.writeFloatLE(65.284);
      events.push(['FTLP', [7, ...lapTime], 'FTLP']);
    }
    if (playerLap === 17 && playerFrac > 0.55) events.push(['SCAR', [2, 0], 'VSC-deployed']);
    if (vscUntilS && sessionTime > vscUntilS) {
      vscUntilS = null;
      events.push(['SCAR', [2, 3], 'VSC-ended']);
    }
    const toEmit = events.filter(([, , key]) => !firedEvents.has(key));
    for (const [code, , key] of toEmit) {
      firedEvents.add(key);
      if (key === 'VSC-deployed') vscUntilS = sessionTime + 22;
    }

    // --- Advance every car ---
    for (const car of cars) {
      const lapBefore = lapNumOf(car);
      const lapDist = lapDistOf(car);
      const targetMs = car.paceMs + degradationMs(car) + (rand() - 0.5) * 120;
      let factor = REF_LAP_MS / targetMs;
      if (vscUntilS) factor *= 0.62;

      // Pit stop: in-lap entry at 95% of the lap, stationary, then out-lap exit at 6%.
      if (car.pitLap && lapBefore === car.pitLap && lapDist > 0.95 * TRACK.lengthM && !car.pitPhase && !car.pitDone) {
        car.pitPhase = 'in';
      }
      let speedKmh;
      if (car.pitPhase === 'in' || car.pitPhase === 'out') {
        speedKmh = 80;
        car.totalDistance += (80 / 3.6) * dt;
        if (car.pitPhase === 'in' && lapDistOf(car) < 0.02 * TRACK.lengthM && lapNumOf(car) > car.pitLap) {
          car.pitPhase = 'stopped';
          car.pitTimerS = 2.6;
        } else if (car.pitPhase === 'out' && lapDistOf(car) > 0.06 * TRACK.lengthM) {
          car.pitPhase = null;
          car.pitDone = true;
        }
      } else if (car.pitPhase === 'stopped') {
        speedKmh = 0;
        car.pitTimerS -= dt;
        if (car.pitTimerS <= 0) {
          Object.assign(car, { pitPhase: 'out', tyre: 'HARD', age: 0, wear: 2, numPitStops: car.numPitStops + 1, paceMs: car.paceMs - 450 });
        }
      } else {
        speedKmh = speedAt(lapDist) * factor * (0.985 + rand() * 0.03);
        car.totalDistance += (speedKmh / 3.6) * dt;
      }
      car.speedKmh = speedKmh;

      // Per-lap bookkeeping when the car crosses the line.
      if (lapNumOf(car) > lapBefore) {
        // Interpolate the moment the line was crossed within this tick, so
        // lap times aren't quantised to the 100ms simulation step.
        const metresPast = lapDistOf(car);
        const travelled = (speedKmh / 3.6) * dt;
        const crossedAtS = travelled > 0 ? sessionTime - (metresPast / travelled) * dt : sessionTime;
        if (car.lapStartTimeS != null) car.lastLapMs = Math.round((crossedAtS - car.lapStartTimeS) * 1000);
        car.lapStartTimeS = crossedAtS;
        car.age += 1;
      }
      // Continuous wear accrual, scaled by distance covered this tick.
      const lapFraction = (speedKmh / 3.6) * dt / TRACK.lengthM;
      car.wear += wearRatePerLap(car) * lapFraction;
      car.fuelKg -= (car.player ? 1.95 : 1.75) * lapFraction;
      // The player deploys more than they harvest (~9% of the battery a
      // lap) and recharges under the VSC.
      if (car.player) {
        const change = vscUntilS ? 0.004 * dt : -0.09 * lapFraction; // fraction of a full battery
        car.ersJ = Math.max(0, Math.min(ERS_MAX_J, car.ersJ + change * ERS_MAX_J));
      }
    }

    // --- Derive positions and time gaps ---
    for (const car of cars) {
      car.trace.push({ d: car.totalDistance, t: sessionTime });
      if (car.trace.length > TRACE_TICKS) car.trace.shift();
    }
    const ordered = [...cars].sort((a, b) => b.totalDistance - a.totalDistance);
    ordered.forEach((car, i) => {
      car.position = i + 1;
      car.deltaToCarInFrontMs = i === 0 ? 0 : timeGapMs(ordered[i - 1], car, sessionTime);
      car.deltaToLeaderMs = i === 0 ? 0 : timeGapMs(ordered[0], car, sessionTime);
    });

    const h = { sessionUID, sessionTime, frameIdentifier: frame, playerCarIndex: PLAYER };

    if (tick === 0 || tick % 50 === 0) emit(tMs, enc.encodeParticipants(h, participants));
    if (tick === 0 || tick % 20 === 0) {
      const nowMin = tMs / 60000;
      emit(tMs, enc.encodeSession(h, {
        ...weatherAt(nowMin), totalLaps: TOTAL_LAPS, trackLength: TRACK.lengthM,
        trackId: TRACK.id, safetyCarStatus: vscUntilS ? 2 : 0,
        forecast: FORECAST_SLOTS_MIN.map((offset) => {
          const w = weatherAt(nowMin + offset);
          return { sessionType: 15, timeOffsetMin: offset, weather: w.weather, rainPercentage: w.rainPct, trackTemperature: w.trackTemperature, airTemperature: w.airTemperature };
        }),
        forecastAccuracy: 0,
      }));
    }
    for (const [code, detail] of toEmit) emit(tMs, enc.encodeEvent(h, code, detail));

    emit(tMs, enc.encodeCarTelemetry(h, cars.map((car) => telemetryFor(car, rand))));
    if (tick % 2 === 0) emit(tMs, enc.encodeLapData(h, cars.map((car) => lapDataFor(car, sessionTime))));
    if (tick % 5 === 0) emit(tMs, enc.encodeCarStatus(h, cars.map((car) => statusFor(car))));
    if (tick % 10 === 0) emit(tMs, enc.encodeCarDamage(h, cars.map((car) => damageFor(car))));
    if (tick === 0 || tick % 50 === 0) emit(tMs, enc.encodeCarSetups(h, cars.map((car) => (car.player ? PLAYER_SETUP : {}))));
    emit(tMs, enc.encodeMotionEx(h, motionExFor(player, rand)));
  }
}

// --- The player's driving habits, for the live-adjustment suggestions ---
// Corner numbers count braking zones from the line, as the dashboard does:
// corner 1 = the 0.07 hairpin, 2 = the 0.27 hairpin, 3 = the 0.40 corner.
const PLAYER_SETUP = { onThrottle: 60, brakeBias: 56 };
const ERS_MAX_J = 4e6;
const near = (frac, lo, hi) => frac >= lo && frac <= hi;
function motionExFor(car, rand) {
  const frac = lapDistOf(car) / TRACK.lengthM;
  const lap = lapNumOf(car);
  const speed = car.speedKmh;
  const braking = speedAt(lapDistOf(car) + 25) < speed - 8;
  const slip = [0, 1, 2, 3].map(() => (rand() - 0.5) * 0.02);
  const angle = [0, 1, 2, 3].map(() => 0.02 + rand() * 0.01);
  if (!car.pitPhase) {
    // Corner 2: the front-left locks at the end of the braking zone, every lap.
    if (braking && near(frac, 0.255, 0.268)) slip[2] = -0.6;
    // Corner 1 exit: rear wheelspin once the tyres are past ~65% (lap 16 on).
    if (!braking && lap >= 16 && near(frac, 0.072, 0.095)) slip[0] = slip[1] = 0.6;
    // Corner 3 exit: understeer on the power from lap 17.
    if (!braking && lap >= 17 && near(frac, 0.402, 0.43)) {
      angle[2] = angle[3] = 0.15;
      angle[0] = angle[1] = 0.03;
    }
  }
  const ms = speed / 3.6;
  return {
    wheelSpeed: slip.map((s) => ms * (1 + s)),
    wheelSlipRatio: slip,
    wheelSlipAngle: angle,
  };
}
// Steering: turned in around every apex.
function steerFor(lapDist) {
  const frac = lapDist / TRACK.lengthM;
  return CORNERS.some(([apex]) => near(frac, apex - 0.02, apex + 0.035)) ? 0.35 : 0.02;
}

function telemetryFor(car, rand) {
  const lapDist = lapDistOf(car);
  const speed = car.speedKmh;
  const ahead = speedAt(lapDist + 25);
  const braking = ahead < speed - 8;
  const gear = speed < 1 ? 0 : gearFor(speed);
  const wearHeat = car.wear * 0.15;
  return {
    speed,
    throttle: braking ? 0 : ahead > speed + 1 ? 1 : 0.55 + rand() * 0.2,
    brake: braking ? Math.min(1, (speed - ahead) / 60) : 0,
    steer: steerFor(lapDist),
    gear,
    engineRPM: gear === 0 ? 4000 : rpmFor(speed, gear),
    drs: speed > 290 && !car.pitPhase ? 1 : 0,
    revLightsPercent: gear === 0 ? 0 : Math.min(100, ((rpmFor(speed, gear) - 9500) / 3200) * 100),
    brakesTemperature: [1, 1, 1, 1].map(() => (braking ? 780 : 520) + rand() * 40),
    tyresSurfaceTemperature: [0, 1, 2, 3].map((k) => 92 + wearHeat + (braking ? 6 : 0) + (k < 2 ? 3 : 0) + rand() * 3),
    tyresInnerTemperature: [0, 1, 2, 3].map(() => 101 + wearHeat * 0.6),
    engineTemperature: 108,
    tyresPressure: [23.1, 23.1, 21.6, 21.6],
  };
}

function lapDataFor(car, sessionTime) {
  const lapStart = car.lapStartTimeS ?? sessionTime - (lapDistOf(car) / TRACK.lengthM) * (car.lastLapMs / 1000);
  return {
    lastLapTimeInMS: car.lastLapMs,
    currentLapTimeInMS: Math.round((sessionTime - lapStart) * 1000),
    deltaToCarInFrontInMS: car.deltaToCarInFrontMs,
    deltaToRaceLeaderInMS: car.deltaToLeaderMs,
    lapDistance: lapDistOf(car),
    totalDistance: car.totalDistance,
    carPosition: car.position,
    currentLapNum: lapNumOf(car),
    pitStatus: car.pitPhase === 'stopped' ? 2 : car.pitPhase ? 1 : 0,
    numPitStops: car.numPitStops,
    sector: Math.min(2, Math.floor((lapDistOf(car) / TRACK.lengthM) * 3)),
    // Sector times for the lap in progress, once each sector is done - an
    // even-ish split of the car's last lap, enough for the debrief to show.
    sector1TimeInMS: lapDistOf(car) / TRACK.lengthM > 0.33 ? Math.round(car.lastLapMs * 0.318) : 0,
    sector2TimeInMS: lapDistOf(car) / TRACK.lengthM > 0.67 ? Math.round(car.lastLapMs * 0.347) : 0,
    gridPosition: car.index + 1,
    driverStatus: car.pitPhase ? 2 : 4,
    pitLaneTimerActive: !!car.pitPhase,
  };
}

function statusFor(car) {
  const c = COMPOUND[car.tyre];
  return {
    fuelMix: 1,
    pitLimiterStatus: !!car.pitPhase,
    fuelInTank: car.fuelKg,
    // Laps of fuel left at the game's nominal burn - the player's actual
    // burn runs hotter, so the margin to the flag shrinks lap by lap.
    fuelRemainingLaps: car.fuelKg / 1.75,
    drsAllowed: car.speedKmh > 250,
    actualTyreCompound: c.actual,
    visualTyreCompound: c.visual,
    tyresAgeLaps: car.age,
    ersStoreEnergy: car.player ? car.ersJ : 2.2e6 + Math.sin(car.totalDistance / 700) * 1.4e6,
    ersDeployMode: 1,
    frontBrakeBias: car.player ? PLAYER_SETUP.brakeBias : 56,
  };
}

function damageFor(car) {
  const w = Math.min(100, car.wear);
  return {
    tyresWear: [w * 1.04, w * 1.08, w * 0.94, w * 0.96],
    frontLeftWingDamage: car.player ? 12 : 0,
  };
}

module.exports = { generate, TICK_MS, REF_LAP_MS, PLAYER, TOTAL_LAPS };
