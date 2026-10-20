const test = require('node:test');
const assert = require('node:assert');
const PACKET_IDS = require('../src/udp/packetIds');
const { createFieldModel } = require('../src/state/fieldModel');
const { createInsightEngine } = require('../src/engine/insightEngine');
const { createRaceAnalysis, predictRejoin } = require('../src/engine/raceAnalysis');

const PLAYER = 2;
const header = (sessionTime) => ({ sessionUID: 1n, sessionTime, playerCarIndex: PLAYER });

// Five cars, 2s apart, carIndex order = position order.
function lapCars(lapNum, overrides = {}) {
  return Array.from({ length: 5 }, (_, i) => ({
    carPosition: i + 1,
    currentLapNum: lapNum,
    lastLapTimeInMS: 90000,
    deltaToCarInFrontInMS: i === 0 ? 0 : 2000,
    deltaToRaceLeaderInMS: i * 2000,
    pitStatus: 0,
    lapDistance: 100,
    resultStatus: 2,
    ...(overrides[i] || {}),
  }));
}

// Drives N lap completions; `perLap(lap)` returns per-car overrides for that lap.
function runLaps(fm, laps, perLap = () => ({})) {
  let t = 0;
  for (let lap = 1; lap <= laps; lap++) {
    fm.dispatch(PACKET_IDS.LAP_DATA, header((t += 1)), { cars: lapCars(lap, perLap(lap)) });
  }
}

test('pace averages the last clean laps, ignoring pit laps and the standing-start lap 1', () => {
  const fm = createFieldModel();
  let t = 0;
  const send = (lap, o) => fm.dispatch(PACKET_IDS.LAP_DATA, header((t += 1)), { cars: lapCars(lap, o) });
  // Car 0: 90s laps 1-2, a 110s in-lap (3) and 105s out-lap (4), then 91s (5).
  send(1, {});
  send(2, {});
  send(3, {});
  send(3, { 0: { pitStatus: 1 } });
  send(4, { 0: { pitStatus: 1, lastLapTimeInMS: 110000 } });
  send(4, {});
  send(5, { 0: { lastLapTimeInMS: 105000 } });
  send(6, { 0: { lastLapTimeInMS: 91000 } });
  const leader = createRaceAnalysis(fm).compute().field.find((c) => c.carIndex === 0);
  // Only the stint since the stop (19 Oct 2026: the laps before it were on the old set).
  assert.strictEqual(leader.paceMs, 91000);
});

test('pit loss is measured from a rival stop: in-lap + out-lap - 2 x clean pace', () => {
  const fm = createFieldModel();
  let t = 0;
  const send = (lap, o) => fm.dispatch(PACKET_IDS.LAP_DATA, header((t += 1)), { cars: lapCars(lap, o) });
  // Car 4 runs clean 90s laps 1-3, pits on lap 4 (in-lap 100s) and lap 5 (out-lap 100s), clean after.
  for (let lap = 1; lap <= 4; lap++) send(lap, {});
  send(4, { 4: { pitStatus: 1 } }); // enters pit lane late on lap 4
  send(5, { 4: { pitStatus: 2, lastLapTimeInMS: 100000 } }); // in-lap done
  send(5, { 4: { pitStatus: 1 } });
  send(6, { 4: { pitStatus: 0, lastLapTimeInMS: 100000 } }); // out-lap done
  send(7, {});
  const ra = createRaceAnalysis(fm);
  const { pitLoss } = ra.compute();
  assert.strictEqual(pitLoss.source, 'measured');
  assert.strictEqual(pitLoss.ms, 20000);
});

test('a race remembers its pit loss for the next race at the track; practice does not', () => {
  const { createTrackMemory } = require('../src/state/trackMemory');
  const run = (sessionType, memory) => {
    const fm = createFieldModel();
    let t = 0;
    fm.dispatch(PACKET_IDS.SESSION, header(0), { trackId: 17, totalLaps: 20, trackLength: 4318, sessionType });
    const send = (lap, o) => fm.dispatch(PACKET_IDS.LAP_DATA, header((t += 1)), { cars: lapCars(lap, o) });
    for (let lap = 1; lap <= 4; lap++) send(lap, {});
    send(4, { 4: { pitStatus: 1 } });
    send(5, { 4: { pitStatus: 2, lastLapTimeInMS: 100000 } });
    send(5, { 4: { pitStatus: 1 } });
    send(6, { 4: { pitStatus: 0, lastLapTimeInMS: 100000 } });
    send(7, {});
    createRaceAnalysis(fm, { memory }).compute();
  };
  const memory = createTrackMemory();
  run(1, memory); // practice
  assert.deepStrictEqual(memory.get(17, 'pitLossMs'), []);
  run(15, memory); // race
  assert.deepStrictEqual(memory.get(17, 'pitLossMs'), [20000]);
  // The next race at the track, before anyone stops: the remembered figure, not the table.
  const fm = createFieldModel();
  fm.dispatch(PACKET_IDS.SESSION, header(0), { trackId: 17, totalLaps: 20, trackLength: 4318, sessionType: 15 });
  memory.add(17, 'pitLossMs', 22000);
  runLaps(fm, 2);
  const { pitLoss } = createRaceAnalysis(fm, { memory }).compute();
  assert.strictEqual(pitLoss.source, 'earlier races here');
  assert.strictEqual(pitLoss.normalMs, 21000);
});

test('track memory survives a restart and ignores a corrupt file', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createTrackMemory } = require('../src/state/trackMemory');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-')), 'tracks.json');
  createTrackMemory(file).add(5, 'stopShare', 0.6);
  assert.deepStrictEqual(createTrackMemory(file).get(5, 'stopShare'), [0.6]);
  fs.writeFileSync(file, '{oops');
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepStrictEqual(createTrackMemory(file).get(5, 'stopShare'), []);
    // The unreadable file is kept aside, not overwritten.
    assert.ok(fs.readdirSync(path.dirname(file)).some((n) => n.startsWith('tracks.json.unreadable-')));
  } finally {
    console.warn = warn;
  }
});

test('pit loss falls back to a per-track estimate before anyone stops', () => {
  const fm = createFieldModel();
  fm.dispatch(PACKET_IDS.SESSION, header(0), { trackId: 17, totalLaps: 20, trackLength: 4318 });
  runLaps(fm, 2);
  const { pitLoss } = createRaceAnalysis(fm).compute();
  assert.strictEqual(pitLoss.source, 'track estimate');
  assert.strictEqual(pitLoss.ms, 20000);
});

test('pit loss shrinks under a safety car or VSC, keeping the green-flag figure', () => {
  const fm = createFieldModel();
  fm.dispatch(PACKET_IDS.SESSION, header(0), { trackId: 17, totalLaps: 20, trackLength: 4318, safetyCarStatus: 1 });
  runLaps(fm, 2);
  const { pitLoss } = createRaceAnalysis(fm).compute();
  assert.deepStrictEqual([pitLoss.ms, pitLoss.normalMs, pitLoss.neutralised], [11000, 20000, 'SC']);
});

test('rejoin prediction slots the player in by time behind the leader + pit loss', () => {
  const fm = createFieldModel();
  fm.dispatch(PACKET_IDS.SESSION, header(0), { trackId: 17 }); // 20s estimate
  // Leader gaps: 0, 2, 4 (player), 15, 30.
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), {
    cars: lapCars(5, { 3: { deltaToRaceLeaderInMS: 15000 }, 4: { deltaToRaceLeaderInMS: 30000 } }),
  });
  const { rejoin } = createRaceAnalysis(fm).compute();
  // Player at 4s + 20s = 24s: behind car 3 (15s) by 9s, ahead of car 4 (30s) by 6s.
  assert.strictEqual(rejoin.position, 4);
  assert.strictEqual(rejoin.positionsLost, 1);
  assert.strictEqual(rejoin.ahead.carIndex, 3);
  assert.strictEqual(rejoin.ahead.gapMs, 9000);
  assert.strictEqual(rejoin.behind.carIndex, 4);
  assert.strictEqual(rejoin.behind.gapMs, 6000);
});

test('gap trend and laps-to-DRS come from the pace difference', () => {
  const fm = createFieldModel();
  // Car ahead (index 1) laps 0.5s slower than the player: gap of 2s shrinks 0.5s/lap.
  runLaps(fm, 4, (lap) => (lap > 1 ? { 1: { lastLapTimeInMS: 90500 } } : {}));
  const ahead = createRaceAnalysis(fm).compute().field.find((c) => c.carIndex === 1);
  assert.strictEqual(ahead.gapTrendMsPerLap, -500);
  assert.strictEqual(ahead.lapsToDrs, 2); // (2000 - 1000) / 500
  assert.strictEqual(ahead.lapsToCatch, 4);
});

test('a car in the pit lane behind the player does not trigger "defend"', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars(3, { 3: { deltaToCarInFrontInMS: 200, pitStatus: 1 } }) });
  assert.ok(!ie.evaluate().some((i) => i.id === 'under-attack'));
});

test('rejoin: a car mid-stop (gap reported as 0) is not counted as leading the race', () => {
  // Leader, then cars 1.5s apart; car 3 is in the pit lane, its gap reads 0.
  const car = (i, pos, gap, pit = 0) => ({ carIndex: i, lapData: { carPosition: pos, deltaToRaceLeaderInMS: gap, pitStatus: pit, resultStatus: 2 } });
  const ordered = [car(0, 1, 0), car(1, 2, 1500), car(2, 3, 3000), car(3, 4, 0, 1), car(4, 5, 6000), car(5, 6, 7500)];
  // Car 1 losing 1s lands at 2.5s: still P2. Read literally, car 3's 0 gap
  // would put it ahead (P3) - it takes car 2's 3.0s instead, behind us.
  const r = predictRejoin(ordered, ordered[1], 1000);
  assert.strictEqual(r.position, 2);
  assert.strictEqual(r.ahead.carIndex, 0);
});

test('rejoin: no prediction while the gaps are unknown (just out of the pits, red flag)', () => {
  const car = (i, pos, gap) => ({ carIndex: i, lapData: { carPosition: pos, deltaToRaceLeaderInMS: gap, pitStatus: 0, resultStatus: 2 } });
  const justOut = [car(0, 1, 0), car(1, 2, 0), car(2, 3, 3000)];
  assert.strictEqual(predictRejoin(justOut, justOut[1], 20000), null);
  const redFlag = [car(0, 1, 0), car(1, 2, 0), car(2, 3, 0), car(3, 4, 0)];
  assert.strictEqual(predictRejoin(redFlag, redFlag[0], 20000), null);
});

test('penalties: track limits named once each, a time penalty at the flag against the car behind, a stop-go to serve', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  const ra = createRaceAnalysis(fm);
  fm.dispatch(PACKET_IDS.SESSION, header(0), { trackId: 17, totalLaps: 20, trackLength: 4318, sessionType: 15 });
  let t = 0;
  const tick = (o) => {
    fm.dispatch(PACKET_IDS.LAP_DATA, header((t += 1)), { cars: lapCars(5, o) });
    return ie.evaluate(ra.compute());
  };
  tick({});
  let cards = tick({ [PLAYER]: { cornerCuttingWarnings: 1, lapDistance: 2100 } });
  assert.match(cards.find((c) => c.id === 'track-limits:1').message, /warning 1 at 2\.1 km/);
  // Said once, not every tick.
  assert.ok(tick({ [PLAYER]: { cornerCuttingWarnings: 1 } }).some((c) => c.id === 'track-limits:1'));
  // A 5s penalty after the stop: added at the flag, the car behind is 2s back.
  cards = tick({ [PLAYER]: { cornerCuttingWarnings: 1, penalties: 5, numPitStops: 1 } });
  assert.match(cards.find((c) => c.id === 'penalty-time').message, /5s penalty at the flag - .* 2s behind: not covered/);
  // A stop-go to serve: the call is BOX.
  tick({ [PLAYER]: { numUnservedStopGoPens: 1 } });
  assert.strictEqual(ie.getStrategy().call.action, 'BOX');
  assert.match(ie.getStrategy().call.reason, /stop-go/);
});

test('flags: a yellow within 800 m is called once, a blue names the car lapping you', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  const ra = createRaceAnalysis(fm);
  fm.dispatch(PACKET_IDS.SESSION, header(0), { trackId: 17, totalLaps: 20, trackLength: 4000, sessionType: 15, marshalZones: [{ zoneStart: 0.5, zoneFlag: 3 }] });
  fm.dispatch(PACKET_IDS.PARTICIPANTS, header(0), { participants: Array.from({ length: 5 }, (_, i) => ({ name: `CAR${i}` })) });
  let t = 0;
  const tick = (o, flag = 0) => {
    fm.dispatch(PACKET_IDS.LAP_DATA, header((t += 1)), { cars: lapCars(5, o) });
    fm.dispatch(PACKET_IDS.CAR_STATUS, header(t), { cars: Array.from({ length: 5 }, (_, i) => ({ vehicleFiaFlags: i === PLAYER ? flag : 0 })) });
    return ie.evaluate(ra.compute());
  };
  assert.ok(!tick({ [PLAYER]: { lapDistance: 100 } }).some((c) => c.id === 'yellow')); // 1.9 km away
  assert.strictEqual(tick({ [PLAYER]: { lapDistance: 1500 } }).find((c) => c.id === 'yellow').message, 'Yellow ahead - careful, no overtaking');
  // In it: the HUD shows it.
  assert.ok(!tick({ [PLAYER]: { lapDistance: 2100 } }, 3).some((c) => c.id === 'yellow'));
  // Car 4 is a lap up and 200 m behind on the road.
  const cards = tick({ [PLAYER]: { lapDistance: 2100 }, 4: { currentLapNum: 6, lapDistance: 1900 } }, 2);
  assert.strictEqual(cards.find((c) => c.id === 'blue').message, 'Blue flag - let CAR4 by');
});

test('race plan on the grid uses wear rates remembered from practice at the track', () => {
  const { createTrackMemory } = require('../src/state/trackMemory');
  const memory = createTrackMemory();
  memory.add(17, 'deg16', 300);
  const fm = createFieldModel();
  fm.dispatch(PACKET_IDS.SESSION, header(0), { trackId: 17, totalLaps: 20, trackLength: 4318, sessionType: 15 });
  const set = (index, c, life, lapDeltaTimeMs) => ({ index, visualTyreCompound: c, usableLife: life, lifeSpan: life, lapDeltaTimeMs, wear: 0, available: true, fitted: index === 0 });
  fm.dispatch(PACKET_IDS.TYRE_SETS, header(0), { carIdx: PLAYER, sets: [set(0, 16, 12, 0), set(1, 17, 18, 500), set(2, 18, 25, 900)] });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars(1) });
  const { racePlan } = createRaceAnalysis(fm, { memory }).compute();
  assert.deepStrictEqual(racePlan.degSource, { 16: 'earlier sessions here', 17: 'estimate', 18: 'estimate' });
  assert.strictEqual(racePlan.best.stops, 1);
});

test('race plan on the grid comes with odds: how often each plan wins across what is known', () => {
  const fm = createFieldModel();
  fm.dispatch(PACKET_IDS.SESSION, header(0), { trackId: 17, totalLaps: 20, trackLength: 4318, sessionType: 15 });
  const set = (index, c, life, lapDeltaTimeMs) => ({ index, visualTyreCompound: c, usableLife: life, lifeSpan: life, lapDeltaTimeMs, wear: 0, available: true, fitted: index === 0 });
  fm.dispatch(PACKET_IDS.TYRE_SETS, header(0), { carIdx: PLAYER, sets: [set(0, 16, 12, 0), set(1, 17, 18, 500), set(2, 18, 25, 900)] });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars(1) });
  const { racePlan } = createRaceAnalysis(fm).compute();
  const { oneStopPct, twoStopPct, samples } = racePlan.odds;
  assert.strictEqual(oneStopPct + twoStopPct, 100);
  assert.strictEqual(samples, 1000);
  // 20 laps and a ~22 s stop: one stop wins whatever the (still default) wear rates turn out to be.
  assert.strictEqual(racePlan.best.stops, 1);
  assert.ok(oneStopPct >= 50, JSON.stringify(racePlan.odds));
});

test('a rival first stop is learned once, even when a flashback brings it round again', () => {
  const { createTrackMemory } = require('../src/state/trackMemory');
  const memory = createTrackMemory();
  const realNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const fm = createFieldModel();
    const ra = createRaceAnalysis(fm, { memory });
    fm.dispatch(PACKET_IDS.SESSION, header(0), { trackId: 17, totalLaps: 20, trackLength: 4318, sessionType: 15 });
    fm.dispatch(PACKET_IDS.TYRE_SETS, header(0), { carIdx: 4, sets: [{ index: 0, visualTyreCompound: 17, usableLife: 20, fitted: true }] });
    fm.dispatch(PACKET_IDS.CAR_STATUS, header(0), { cars: Array.from({ length: 5 }, () => ({ visualTyreCompound: 17, tyresAgeLaps: 12 })) });
    const tick = (t, o) => {
      now += 100;
      fm.dispatch(PACKET_IDS.LAP_DATA, header(t), { cars: lapCars(12, o) });
      ra.compute();
    };
    tick(10, {});
    tick(11, { 4: { pitStatus: 1 } }); // into the pit lane
    tick(5, {}); // flashback to before it
    tick(6, { 4: { pitStatus: 1 } }); // the same stop again
    assert.deepStrictEqual(memory.get(17, 'stopShare'), [0.6]);
  } finally {
    Date.now = realNow;
  }
});

test('a stop that leaves a time penalty in place teaches that penalties are added at the flag', () => {
  const { createTrackMemory } = require('../src/state/trackMemory');
  const memory = createTrackMemory();
  const race = () => {
    const fm = createFieldModel();
    fm.dispatch(PACKET_IDS.SESSION, header(0), { trackId: 17, totalLaps: 20, trackLength: 4318, sessionType: 15 });
    return { fm, ra: createRaceAnalysis(fm, { memory }) };
  };
  let t = 0;
  const tick = ({ fm, ra }, o) => {
    fm.dispatch(PACKET_IDS.LAP_DATA, header((t += 1)), { cars: lapCars(8, { [PLAYER]: { penalties: 5, ...o } }) });
    return ra.compute();
  };
  const r1 = race();
  assert.strictEqual(tick(r1, {}).penalties.servedAt, 'stop'); // the assumption until seen
  tick(r1, { pitStatus: 1 });
  tick(r1, { pitStatus: 2, numPitStops: 1 });
  tick(r1, { pitStatus: 0, numPitStops: 1 }); // out again, still 5s
  assert.deepStrictEqual(memory.get('game', 'penaltyServedAtStop'), [0]);
  // The next race: a penalty before the stop is added at the flag.
  assert.strictEqual(tick(race(), {}).penalties.servedAt, 'flag');
});

test('pace after a switch to inters counts only the laps on wet tyres', () => {
  // Austria, 19 Oct 2026: a dry 70s slick lap averaged with two 78s laps on
  // inters in the rain had PIASTRI "catching 8.7s/lap" - he was 0.8s quicker.
  const fm = createFieldModel();
  let t = 0;
  const status = (wetCars) => fm.dispatch(PACKET_IDS.CAR_STATUS, header((t += 1)), {
    cars: Array.from({ length: 5 }, (_, i) => ({ visualTyreCompound: wetCars.includes(i) ? 7 : 17, tyresAgeLaps: 3 })),
  });
  const send = (lap, o) => fm.dispatch(PACKET_IDS.LAP_DATA, header((t += 1)), { cars: lapCars(lap, o) });
  status([]);
  for (let lap = 1; lap <= 5; lap++) send(lap, { 2: { lastLapTimeInMS: 70000 }, 3: { lastLapTimeInMS: 70000 } });
  status([2, 3]);
  for (let lap = 6; lap <= 7; lap++) send(lap, { 2: { lastLapTimeInMS: 78600 }, 3: { lastLapTimeInMS: 77800 } });
  const behind = createRaceAnalysis(fm).compute().field.find((c) => c.carIndex === 3);
  assert.strictEqual(behind.paceMs, 77800);
  assert.strictEqual(behind.gapTrendMsPerLap, -800);
});

test('no battle call once the player has taken the flag', () => {
  // Austria: "Defend from PIASTRI" 20 seconds after the chequered flag.
  const fm = createFieldModel();
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars(3, { 3: { deltaToCarInFrontInMS: 400 } }) });
  assert.strictEqual(createRaceAnalysis(fm).compute().battle.call.mode, 'DEFEND');
  fm.dispatch(PACKET_IDS.LAP_DATA, header(2), { cars: lapCars(3, { 2: { resultStatus: 3 }, 3: { deltaToCarInFrontInMS: 400 } }) });
  assert.strictEqual(createRaceAnalysis(fm).compute().battle.call, null);
});

test('a sprint has no compulsory stop: no stop plan, no rival due to box (Silverstone sprint, 19 Oct 2026)', () => {
  // The game names the sprint "Race" and the main race "Race 2"; what marks a
  // sprint is the sprint shootout earlier in the same weekend.
  const SILVERSTONE_WEEKEND = 2227884873;
  const h = (uid, t) => ({ sessionUID: uid, sessionTime: t, playerCarIndex: PLAYER });
  const set = (index, c, life, lapDeltaTimeMs) => ({ index, visualTyreCompound: c, usableLife: life, lifeSpan: life, lapDeltaTimeMs, wear: 0, available: true, fitted: index === 0 });
  // A 6-lap race, everyone on softs rated 12 laps.
  const race = (fm, ra, uid, weekendLinkIdentifier) => {
    fm.dispatch(PACKET_IDS.SESSION, h(uid, 0), { trackId: 7, totalLaps: 6, trackLength: 5891, sessionType: 15, weekendLinkIdentifier });
    for (let c = 0; c < 5; c++) fm.dispatch(PACKET_IDS.TYRE_SETS, h(uid, 0), { carIdx: c, sets: [set(0, 16, 12, 0), set(1, 17, 18, 500), set(2, 18, 25, 900)] });
    fm.dispatch(PACKET_IDS.CAR_STATUS, h(uid, 0), { cars: Array.from({ length: 5 }, () => ({ visualTyreCompound: 16, tyresAgeLaps: 0 })) });
    fm.dispatch(PACKET_IDS.LAP_DATA, h(uid, 1), { cars: lapCars(1) });
    const grid = ra.compute();
    fm.dispatch(PACKET_IDS.CAR_STATUS, h(uid, 2), { cars: Array.from({ length: 5 }, () => ({ visualTyreCompound: 16, tyresAgeLaps: 3 })) });
    fm.dispatch(PACKET_IDS.LAP_DATA, h(uid, 3), { cars: lapCars(4) });
    return { plan: grid.racePlan, stops: ra.compute().field.map((c) => c.stopInLaps) };
  };

  const fm = createFieldModel();
  const ra = createRaceAnalysis(fm);
  fm.dispatch(PACKET_IDS.SESSION, h(1n, 0), { trackId: 7, totalLaps: 1, trackLength: 5891, sessionType: 13, weekendLinkIdentifier: SILVERSTONE_WEEKEND });
  fm.dispatch(PACKET_IDS.LAP_DATA, h(1n, 1), { cars: lapCars(1) });
  ra.compute();
  const sprint = race(fm, ra, 2n, SILVERSTONE_WEEKEND);
  assert.strictEqual(sprint.plan, null, 'no "Soft 5 laps, Medium 1"');
  assert.deepStrictEqual(sprint.stops, [null, null, null, null, null], 'softs rated 12 laps reach the flag of a 6-lap sprint');

  // The same race on a weekend without a sprint owes the two-compound stop.
  const fm2 = createFieldModel();
  const full = race(fm2, createRaceAnalysis(fm2), 3n, 12345);
  assert.ok(full.plan, 'a race plan');
  assert.ok(full.stops.some((k) => k != null), JSON.stringify(full.stops));
});

test('pace after a stop is the new set\'s, not an average across the stop', () => {
  // Austria's "catching 8.7s/lap" was slick laps averaged with inter laps; a
  // stop onto fresh slicks mixes the same way: old 92s laps with new 90s ones.
  const fm = createFieldModel();
  let t = 0;
  const send = (lap, o) => fm.dispatch(PACKET_IDS.LAP_DATA, header((t += 1)), { cars: lapCars(lap, o) });
  send(1, {});
  for (let lap = 2; lap <= 4; lap++) send(lap, { 0: { lastLapTimeInMS: 92000 } });
  send(4, { 0: { pitStatus: 1 } });
  send(5, { 0: { pitStatus: 1, lastLapTimeInMS: 110000 } }); // in-lap
  send(6, { 0: { lastLapTimeInMS: 105000 } }); // out-lap
  send(7, { 0: { lastLapTimeInMS: 90000 } }); // first lap on the new set
  const car0 = createRaceAnalysis(fm).compute().field.find((c) => c.carIndex === 0);
  assert.strictEqual(car0.paceMs, 90000);
});

test('pit loss is not measured against the standing-start lap 1', () => {
  const fm = createFieldModel();
  let t = 0;
  const send = (lap, o) => fm.dispatch(PACKET_IDS.LAP_DATA, header((t += 1)), { cars: lapCars(lap, o) });
  // Car 4: a 99s standing-start lap 1, in on lap 2 (110s), out on lap 3 (100s), 90s laps after.
  send(1, {});
  send(2, { 4: { lastLapTimeInMS: 99000 } });
  send(2, { 4: { pitStatus: 1 } });
  send(3, { 4: { pitStatus: 2, lastLapTimeInMS: 110000 } });
  send(3, { 4: { pitStatus: 1 } });
  send(4, { 4: { pitStatus: 0, lastLapTimeInMS: 100000 } });
  send(5, {});
  assert.strictEqual(createRaceAnalysis(fm).compute().pitLoss.ms, 30000, '110 + 100 - 2 x 90');
});

test('a stop in a sprint is not learned as when the AI boxes (it is damage, not strategy)', () => {
  const { createTrackMemory } = require('../src/state/trackMemory');
  const memory = createTrackMemory();
  const realNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const fm = createFieldModel();
    const ra = createRaceAnalysis(fm, { memory });
    const h = (uid, t) => ({ sessionUID: uid, sessionTime: t, playerCarIndex: PLAYER });
    fm.dispatch(PACKET_IDS.SESSION, h(1n, 0), { trackId: 7, totalLaps: 1, trackLength: 5891, sessionType: 13, weekendLinkIdentifier: 99 });
    fm.dispatch(PACKET_IDS.LAP_DATA, h(1n, 1), { cars: lapCars(1) });
    ra.compute();
    fm.dispatch(PACKET_IDS.SESSION, h(2n, 0), { trackId: 7, totalLaps: 6, trackLength: 5891, sessionType: 15, weekendLinkIdentifier: 99 });
    fm.dispatch(PACKET_IDS.TYRE_SETS, h(2n, 0), { carIdx: 4, sets: [{ index: 0, visualTyreCompound: 16, usableLife: 12, fitted: true }] });
    fm.dispatch(PACKET_IDS.CAR_STATUS, h(2n, 0), { cars: Array.from({ length: 5 }, () => ({ visualTyreCompound: 16, tyresAgeLaps: 3 })) });
    for (const [t, o] of [[10, {}], [11, { 4: { pitStatus: 1 } }]]) {
      now += 100;
      fm.dispatch(PACKET_IDS.LAP_DATA, h(2n, t), { cars: lapCars(4, o) });
      ra.compute();
    }
    assert.deepStrictEqual(memory.get(7, 'stopShare'), []);
  } finally {
    Date.now = realNow;
  }
});

test('a tyre change under a red flag starts a new stint too - no pit lap marks it (Monaco, 15 Oct 2026: "catching 3.2s/lap")', () => {
  const fm = createFieldModel();
  let t = 0;
  const lap = (n, age, ms) => {
    fm.dispatch(PACKET_IDS.CAR_STATUS, header((t += 1)), { cars: Array.from({ length: 5 }, () => ({ visualTyreCompound: 17, tyresAgeLaps: age })) });
    fm.dispatch(PACKET_IDS.LAP_DATA, header((t += 1)), { cars: lapCars(n, { 0: { lastLapTimeInMS: ms } }) });
  };
  lap(1, 0, 90000);
  for (let n = 2; n <= 5; n++) lap(n, n - 1, 93000); // laps 1-4 on one set, worn
  lap(6, 0, 89000); // new set fitted during the stoppage, then a 89s lap
  const car0 = createRaceAnalysis(fm).compute().field.find((c) => c.carIndex === 0);
  assert.strictEqual(car0.paceMs, 89000);
});

test('a 5-lap race has no compulsory stop either: no stop plan (15 Oct 2026: none of 63 AI cars stopped in three 5-lap races)', () => {
  const fm = createFieldModel();
  fm.dispatch(PACKET_IDS.SESSION, header(0), { trackId: 7, totalLaps: 5, trackLength: 5891, sessionType: 15 });
  const set = (index, c, life, lapDeltaTimeMs) => ({ index, visualTyreCompound: c, usableLife: life, lifeSpan: life, lapDeltaTimeMs, wear: 0, available: true, fitted: index === 0 });
  fm.dispatch(PACKET_IDS.TYRE_SETS, header(0), { carIdx: PLAYER, sets: [set(0, 16, 12, 0), set(1, 17, 18, 500), set(2, 18, 25, 900)] });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars(1) });
  assert.strictEqual(createRaceAnalysis(fm).compute().racePlan, null, 'not "Soft 4 laps, Medium 1"');
});

test('a time penalty is not judged against the car behind under a safety car or red flag (Barcelona, 16 Oct 2026)', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  const ra = createRaceAnalysis(fm);
  const sc = (safetyCarStatus) => fm.dispatch(PACKET_IDS.SESSION, header(0), { trackId: 4, totalLaps: 23, trackLength: 4664, sessionType: 15, safetyCarStatus });
  // Already stopped once, so the 5s is added at the flag; the car behind 0.3s back.
  const tick = (t) => {
    fm.dispatch(PACKET_IDS.LAP_DATA, header(t), { cars: lapCars(15, { [PLAYER]: { penalties: 5, numPitStops: 1 }, [PLAYER + 1]: { deltaToCarInFrontInMS: 300 } }) });
    return ie.evaluate(ra.compute()).find((c) => c.id === 'penalty-time').message;
  };
  sc(0);
  assert.match(tick(1), /not covered, push/);
  sc(1);
  // The field is bunched behind the safety car: the gap behind says nothing about the flag.
  assert.strictEqual(tick(2), '5s penalty - added at the flag');
});
