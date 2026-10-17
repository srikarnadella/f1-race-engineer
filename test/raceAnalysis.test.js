const test = require('node:test');
const assert = require('node:assert');
const PACKET_IDS = require('../src/udp/packetIds');
const { createFieldModel } = require('../src/state/fieldModel');
const { createInsightEngine } = require('../src/state/insightEngine');
const { createRaceAnalysis, predictRejoin } = require('../src/state/raceAnalysis');

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
  assert.strictEqual(leader.paceMs, Math.round((90000 + 91000) / 2));
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
