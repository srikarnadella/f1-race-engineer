const PACKET_IDS = require('../udp/packetIds');
const { createLapDeltaTracker } = require('./lapDelta');
const { createCarBalanceTracker } = require('./carBalance');
const { createLapTraceRecorder, createMiniSectorTracker } = require('./lapTrace');

const GAP_SAMPLE_INTERVAL_S = 1;
const GAP_HISTORY_SAMPLES = 120; // two minutes - comfortably more than one lap
const LAP_HISTORY_SIZE = 12;
const SLOW_VICTIM_KMH = 80;
// Battery sampled in this many slices of a lap, per car: last lap's shape is
// the best guess at how the rest of this lap goes (see batteryProjection.js).
const ERS_BINS = 20;

// Tracks every car on track, keyed by car index - not just the player's.
// This is the join point for "relative to the field": gaps, pace trends,
// and undercut threats all need the rest of the grid, not just your own car.
function createFieldModel() {
  // carIndex -> { telemetry, status, damage, lapData, participant,
  //               lapHistory: [{ lapNum, lapMs, pit, neutralised }], gapAheadHistory }
  const cars = new Map();
  let playerCarIndex = null;
  let session = null;
  let sessionUID = null;
  let sessionTime = 0; // seconds, from the packet header
  let lastPacketAtMs = null;
  const recentEvents = [];
  const passLog = []; // { atM, lapNum, overtakerIdx, overtakenIdx, sessionTime } this session
  let classification = null; // the official result, once the results screen is up
  let lapPositions = null; // { lapStart, laps[k][carIdx] = position }
  let eventSeq = 0; // monotonic across resets
  // Bumped on every reset so derived state elsewhere (InsightEngine's wear
  // history) knows to drop its own per-session memory too.
  let generation = 0;
  // Red flag: set by the RDFL event, cleared at the restart (lights out / a new
  // session start). Laps run under it are no more representative than
  // safety-car laps, and nothing should be advised while the cars are stopped.
  let redFlag = false;
  const isNeutralised = () => redFlag || !!(session && session.safetyCarStatus);
  let playerDelta = createLapDeltaTracker();
  let playerBalance = createCarBalanceTracker();
  let playerTrace = createLapTraceRecorder();
  // Offline the game sends every car's speed, throttle and brake, not just
  // yours (seen on real F1 26 races), so rivals' laps can be traced too.
  let rivalTraces = new Map(); // carIndex -> recorder
  const miniSectors = createMiniSectorTracker();

  // A new session in-game, or a demo replay looping back to its start, must
  // not inherit lap/gap/pit history from the previous one - otherwise trend
  // rules see a lap counter jump backwards and fire nonsense insights.
  function reset() {
    cars.clear();
    playerCarIndex = null;
    session = null;
    sessionUID = null;
    sessionTime = 0;
    recentEvents.length = 0;
    passLog.length = 0;
    classification = null;
    lapPositions = null;
    redFlag = false;
    playerDelta = createLapDeltaTracker();
    playerBalance = createCarBalanceTracker();
    playerTrace = createLapTraceRecorder();
    rivalTraces = new Map();
    miniSectors.reset();
    generation++;
  }

  // Tyre on the car as a lap completes - for the field-wide wear model.
  function tyreOf(car) {
    return car.status ? { compound: car.status.visualTyreCompound, tyreAge: car.status.tyresAgeLaps, fuelKg: car.status.fuelInTank } : {};
  }

  function getCar(i) {
    if (!cars.has(i)) {
      cars.set(i, { lapHistory: [], gapAheadHistory: [], ersHistory: [], lastPitStatus: null, lapFlags: new Map() });
    }
    return cars.get(i);
  }

  function handlePacket(packetId, header) {
    if (sessionUID !== null && header.sessionUID !== sessionUID) reset();
    // A flashback rewinds game time: passes after the new time never
    // happened (on a real race they repeated and skewed the pass map).
    if (header.sessionTime < sessionTime - 0.5) {
      for (let i = passLog.length - 1; i >= 0; i--) if (passLog[i].sessionTime > header.sessionTime) passLog.splice(i, 1);
    }
    sessionUID = header.sessionUID;
    sessionTime = header.sessionTime;
    lastPacketAtMs = Date.now();
    playerCarIndex = header.playerCarIndex;
  }

  function onCarTelemetry(data) {
    data.cars.forEach((c, i) => {
      getCar(i).telemetry = c;
    });
  }

  function onCarStatus(data) {
    data.cars.forEach((c, i) => {
      const car = getCar(i);
      // Bias moved: lockup history from before the change is stale.
      if (i === playerCarIndex && car.status && car.status.frontBrakeBias !== c.frontBrakeBias) playerBalance.forget(['frontLock', 'rearLock']);
      car.status = c;
    });
  }

  function onCarDamage(data) {
    data.cars.forEach((c, i) => {
      getCar(i).damage = c;
    });
  }

  function onLapData(data) {
    data.cars.forEach((c, i) => {
      const car = getCar(i);
      const prevLapNum = car.lapData ? car.lapData.currentLapNum : null;

      // Flags for the lap in progress: a lap that touched the pit lane or ran
      // under a safety car isn't representative pace, but the in/out laps
      // are exactly what's needed to measure the time a pit stop costs.
      if (c.pitStatus !== 0) car.lapTouchedPit = true;
      if (isNeutralised()) car.lapNeutralised = true;

      // The chequered flag: the lap counter doesn't move on at the finish
      // (it stays on the last lap and only resultStatus becomes 3 =
      // finished, seen on a real F1 26 race), so the final lap is recorded
      // when its time lands rather than on a lap change.
      // The status and the time may land in different packets, so the lap is
      // taken when its time is new: changed since the previous packet, or (on
      // the packet the status flips) different from the last recorded lap.
      const lastRecorded = car.lapHistory[car.lapHistory.length - 1];
      const prevLap = car.lapData;
      const timeIsNew = prevLap && (c.lastLapTimeInMS !== prevLap.lastLapTimeInMS
        || (prevLap.resultStatus !== 3 && lastRecorded && c.lastLapTimeInMS !== lastRecorded.lapMs));
      if (c.resultStatus === 3 && c.lastLapTimeInMS > 0 && timeIsNew && (!lastRecorded || lastRecorded.lapNum < c.currentLapNum)) {
        car.lapHistory.push({ lapNum: c.currentLapNum, lapMs: c.lastLapTimeInMS, pit: !!car.lapTouchedPit, neutralised: !!car.lapNeutralised, ...tyreOf(car) });
        if (car.lapHistory.length > LAP_HISTORY_SIZE) car.lapHistory.shift();
        miniSectors.close(i, car, c.lastLapTimeInMS);
        if (i === playerCarIndex) playerTrace.finish(c);
      }

      // A flashback back across the line: the lap counter goes *down*. The
      // laps from there on never happened - drop them rather than record a
      // bogus "completed lap" (a real Monaco race with 20 flashbacks had laps
      // 3, 4, 3, 4... and polluted pace, tyre-wear and pit-loss figures).
      if (prevLapNum != null && c.currentLapNum < prevLapNum) {
        car.lapHistory = car.lapHistory.filter((l) => l.lapNum < c.currentLapNum);
        car.ersHistory = car.ersHistory.filter((h) => h.lapNum <= c.currentLapNum);
        if (car.miniSectors) car.miniSectors = car.miniSectors.filter((m) => m.lapNum < c.currentLapNum);
        // The lap rewound into keeps what it already had: a flashback from
        // just after a safety car into its last lap otherwise recorded that
        // 1:55 lap as clean for every car, and the tyre model read it as
        // tyres getting 18s a lap faster with age.
        const flags = car.lapFlags.get(c.currentLapNum);
        car.lapTouchedPit = c.pitStatus !== 0 || !!(flags && flags.pit);
        car.lapNeutralised = isNeutralised() || !!(flags && flags.neutralised);
        for (const n of car.lapFlags.keys()) if (n > c.currentLapNum) car.lapFlags.delete(n);
        car.ersLap = null;
        car.ersPrevLap = null;
      }
      // One entry per completed lap: pace trends, stint pace, pit loss.
      // Forwards - usually +1, but a red-flag restart can jump the counter (13 -> 16 at Monaco).
      if (prevLapNum != null && c.currentLapNum > prevLapNum) {
        if (c.lastLapTimeInMS > 0) {
          car.lapHistory.push({
            lapNum: prevLapNum,
            lapMs: c.lastLapTimeInMS,
            pit: !!car.lapTouchedPit,
            neutralised: !!car.lapNeutralised,
            ...tyreOf(car),
          });
          if (car.lapHistory.length > LAP_HISTORY_SIZE) car.lapHistory.shift();
        }
        // Battery at the line, for the per-lap ERS trend (charging or draining).
        if (car.status) {
          car.ersHistory.push({ lapNum: c.currentLapNum, energyJ: car.status.ersStoreEnergy, neutralised: !!car.lapNeutralised });
          if (car.ersHistory.length > LAP_HISTORY_SIZE) car.ersHistory.shift();
        }
        car.ersPrevLap = car.ersLap && car.status && car.ersLap.lapNum === prevLapNum
          ? { ...car.ersLap, lineJ: car.status.ersStoreEnergy, unusual: !!(car.lapNeutralised || car.lapTouchedPit) }
          : null;
        car.ersLap = null;
        car.lapTouchedPit = c.pitStatus !== 0; // out-lap starts in the pit lane
        car.lapNeutralised = isNeutralised();
      }

      // Gap-ahead trend, sampled on game time (not per packet) so the closing
      // rate means the same thing at 20Hz or 60Hz and pauses don't skew it.
      // A position change means "the car ahead" is now a different car, so
      // the old samples no longer describe the same gap.
      if (car.lapData && car.lapData.carPosition !== c.carPosition) car.gapAheadHistory.length = 0;
      // A flashback rewinds game time: samples "from the future" would stop
      // sampling until time caught up, then measure across the jump.
      const newest = car.gapAheadHistory[car.gapAheadHistory.length - 1];
      if (newest && sessionTime < newest.t) car.gapAheadHistory.length = 0;
      const lastSample = car.gapAheadHistory[car.gapAheadHistory.length - 1];
      if (!lastSample || sessionTime - lastSample.t >= GAP_SAMPLE_INTERVAL_S) {
        car.gapAheadHistory.push({ t: sessionTime, gapMs: c.deltaToCarInFrontInMS });
        if (car.gapAheadHistory.length > GAP_HISTORY_SAMPLES) car.gapAheadHistory.shift();
      }

      // Latched as a wall-clock timestamp rather than a one-packet boolean:
      // LapData arrives faster than the 10Hz insight tick, so a flag that is
      // only true for a single packet would usually be missed entirely.
      // The position is kept from *before* entry: a car drops places while it
      // drives down the pit lane, and whether it was ahead of or behind the
      // player when it stopped is what makes it an undercut or an overcut.
      if (car.lastPitStatus === 0 && c.pitStatus !== 0) {
        car.pitEntryAtMs = Date.now();
        car.pitEntryPosition = car.lapData ? car.lapData.carPosition : c.carPosition;
        car.pitEntryPlayerPosition = playerCarIndex != null && cars.get(playerCarIndex) && cars.get(playerCarIndex).lapData
          ? cars.get(playerCarIndex).lapData.carPosition
          : null;
      }
      car.lastPitStatus = c.pitStatus;

      const L = session && session.trackLength;
      if (L && car.status && Number.isFinite(car.status.ersStoreEnergy) && c.lapDistance >= 0) {
        if (!car.ersLap || car.ersLap.lapNum !== c.currentLapNum) car.ersLap = { lapNum: c.currentLapNum, binsJ: new Array(ERS_BINS).fill(null) };
        const bin = Math.min(ERS_BINS - 1, Math.floor((c.lapDistance / L) * ERS_BINS));
        if (car.ersLap.binsJ[bin] == null) car.ersLap.binsJ[bin] = car.status.ersStoreEnergy;
      }

      if (i === playerCarIndex) {
        playerDelta.update(c, session && session.trackLength);
        playerTrace.update(c, car.telemetry);
      } else if (car.telemetry) {
        if (!rivalTraces.has(i)) rivalTraces.set(i, createLapTraceRecorder());
        rivalTraces.get(i).update(c, car.telemetry);
      }
      miniSectors.update(i, car, c, session && session.trackLength);
      car.lapData = c;
      car.lapFlags.set(c.currentLapNum, { pit: !!car.lapTouchedPit, neutralised: !!car.lapNeutralised });
      if (car.lapFlags.size > LAP_HISTORY_SIZE) car.lapFlags.delete(car.lapFlags.keys().next().value);
    });
  }

  function onParticipants(data) {
    data.participants.forEach((p, i) => {
      getCar(i).participant = p;
    });
  }

  // One car's tyre sets per packet (they cycle through the field).
  function onTyreSets(data) {
    if (data) getCar(data.carIdx).tyreSets = data.sets;
  }

  // F1 26: active aero + Overtake mode, for every car.
  function onCarTelemetry2(data) {
    data.cars.forEach((c, i) => {
      getCar(i).telemetry2 = c;
    });
  }

  function onCarSetups(data) {
    data.cars.forEach((c, i) => {
      const car = getCar(i);
      // Diff moved: wheelspin/understeer history from before it is stale.
      if (i === playerCarIndex && car.setup && car.setup.onThrottle !== c.onThrottle) playerBalance.forget(['spin', 'understeer']);
      car.setup = c;
    });
  }

  // Player's car only - feeds the corner-by-corner balance tracker.
  function onMotionEx(data) {
    if (!data || playerCarIndex == null) return;
    const player = getCar(playerCarIndex);
    player.motionEx = data;
    playerBalance.update({
      motionEx: data,
      telemetry: player.telemetry,
      lapData: player.lapData,
      trackLengthM: session && session.trackLength,
      neutralised: !!(session && session.safetyCarStatus),
    });
  }

  function onSession(data) {
    session = data;
  }

  function onEvent(data) {
    if (data.code === 'RDFL') redFlag = true;
    else if (data.code === 'LGOT' || data.code === 'SSTA') redFlag = false;
    // seq: two events can share a millisecond, so consumers track this instead.
    recentEvents.push({ ...data, atMs: Date.now(), seq: ++eventSeq });
    if (recentEvents.length > 30) recentEvents.shift();
    // Where on the lap each pass happened - the "where do they attack"
    // forecast learns this track's passing spots from it. Lap 1 is skipped:
    // the opening scramble passes everywhere.
    if (data.code === 'OVTK' && data.overtakerIdx != null) {
      const lap = cars.get(data.overtakerIdx) && cars.get(data.overtakerIdx).lapData;
      // A car going by one that's stopped or spinning isn't an attack.
      const victim = cars.get(data.overtakenIdx);
      const victimSlow = victim && victim.telemetry && victim.telemetry.speed < SLOW_VICTIM_KMH;
      if (lap && lap.currentLapNum > 1 && lap.lapDistance >= 0 && !victimSlow) {
        passLog.push({ atM: Math.round(lap.lapDistance), lapNum: lap.currentLapNum, overtakerIdx: data.overtakerIdx, overtakenIdx: data.overtakenIdx, sessionTime });
        if (passLog.length > 500) passLog.shift();
      }
    }
  }

  function dispatch(packetId, header, data) {
    handlePacket(packetId, header);
    switch (packetId) {
      case PACKET_IDS.CAR_TELEMETRY: return onCarTelemetry(data);
      case PACKET_IDS.CAR_STATUS: return onCarStatus(data);
      case PACKET_IDS.CAR_DAMAGE: return onCarDamage(data);
      case PACKET_IDS.LAP_DATA: return onLapData(data);
      case PACKET_IDS.PARTICIPANTS: return onParticipants(data);
      case PACKET_IDS.SESSION: return onSession(data);
      case PACKET_IDS.EVENT: return onEvent(data);
      case PACKET_IDS.CAR_SETUPS: return onCarSetups(data);
      case PACKET_IDS.MOTION_EX: return onMotionEx(data);
      case PACKET_IDS.CAR_TELEMETRY_2: return onCarTelemetry2(data);
      case PACKET_IDS.TYRE_SETS: return onTyreSets(data);
      case PACKET_IDS.FINAL_CLASSIFICATION: classification = data; return undefined;
      case PACKET_IDS.LAP_POSITIONS: lapPositions = data; return undefined;
      case PACKET_IDS.SESSION_HISTORY: if (data) getCar(data.carIdx).sessionHistory = data; return undefined;
      default: return;
    }
  }

  // Cars ordered by track position, with the player's relative neighbours
  // easy to pick out - this is what both the dashboard and the insight
  // engine actually want, rather than the raw carIndex-keyed map.
  function orderedByPosition() {
    return [...cars.entries()]
      .filter(([, car]) => car.lapData && car.lapData.carPosition > 0)
      .sort((a, b) => a[1].lapData.carPosition - b[1].lapData.carPosition)
      .map(([carIndex, car]) => ({ carIndex, ...car }));
  }

  function playerIndex() {
    return playerCarIndex;
  }

  function getSession() {
    return session;
  }

  function getRecentEvents() {
    return recentEvents;
  }

  // { bestLapTimeInMS, deltaToBestMs } for the player's current position on track.
  function getPlayerDelta() {
    const player = playerCarIndex == null ? null : cars.get(playerCarIndex);
    return playerDelta.current(player && player.lapData);
  }

  function getLastPacketAtMs() {
    return lastPacketAtMs;
  }

  function getGeneration() {
    return generation;
  }

  // Seconds of game time - stops while the game is paused, unlike Date.now().
  function getSessionTime() {
    return sessionTime;
  }

  // Repeated lockups / wheelspin / understeer by corner (see carBalance.js).
  function getPlayerBalanceIssues() {
    return playerBalance.issues();
  }

  // The player's braking zones, numbered from the line - the "corners" every
  // corner-level call (Adjust, attack forecast) refers to.
  function getPlayerCorners() {
    return playerBalance.corners();
  }

  // The player's mini-sectors on the lap in progress (see lapTrace.js).
  function getPlayerPartialSectors() {
    return playerCarIndex == null ? null : miniSectors.partial(playerCarIndex);
  }

  function getPassLog() {
    return passLog;
  }

  function isRedFlag() {
    return redFlag;
  }

  // Completed lap traces since the last call (the debrief collects them).
  function takePlayerLapTraces() {
    return playerTrace.take();
  }

  // The same for every other car: [{ carIndex, ...trace }].
  function takeRivalLapTraces() {
    return [...rivalTraces].flatMap(([carIndex, r]) => r.take().map((t) => ({ carIndex, ...t })));
  }

  const getClassification = () => classification;
  const getLapPositions = () => lapPositions;

  return { dispatch, reset, getCar, getClassification, getLapPositions, orderedByPosition, playerIndex, getSession, getRecentEvents, getGeneration, getPlayerDelta, getLastPacketAtMs, getSessionTime, getPlayerBalanceIssues, takePlayerLapTraces, takeRivalLapTraces, getPlayerCorners, getPlayerPartialSectors, getPassLog, isRedFlag };
}

module.exports = { createFieldModel };
