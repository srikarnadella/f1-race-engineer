const test = require('node:test');
const assert = require('node:assert');
const PACKET_IDS = require('../src/udp/packetIds');
const { createFieldModel } = require('../src/state/fieldModel');
const { createInsightEngine } = require('../src/engine/insightEngine');
const { createRaceAnalysis } = require('../src/engine/raceAnalysis');
const { buildSnapshot } = require('../src/server/snapshot');

const PLAYER = 2;
const header = (sessionTime, sessionUID = 1n) => ({ sessionUID, sessionTime, playerCarIndex: PLAYER });

// Five cars in carIndex order = position order, 1s apart unless overridden.
function lapCars(overrides = {}) {
  return Array.from({ length: 5 }, (_, i) => ({
    carPosition: i + 1,
    currentLapNum: 10,
    lastLapTimeInMS: 90000,
    deltaToCarInFrontInMS: i === 0 ? 0 : 1000,
    pitStatus: 0,
    lapDistance: 2000,
    ...(overrides[i] || {}),
  }));
}

test('snapshot nearby gaps are signed and summed across intervals', () => {
  const fm = createFieldModel();
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars({ 1: { deltaToCarInFrontInMS: 1500 }, 3: { deltaToCarInFrontInMS: 700 }, 4: { deltaToCarInFrontInMS: 2100 } }) });
  const snap = buildSnapshot(fm, createInsightEngine(fm), createRaceAnalysis(fm));
  const gaps = Object.fromEntries(snap.nearby.map((n) => [n.position, n.gapToPlayerMs]));
  // Player is P3 with a 1000ms interval to P2.
  assert.deepStrictEqual(gaps, { 1: -2500, 2: -1000, 4: 700, 5: 2800 });
});

test('disconnected snapshot still carries updatedAtMs', () => {
  const fm = createFieldModel();
  const snap = buildSnapshot(fm, createInsightEngine(fm), createRaceAnalysis(fm));
  assert.strictEqual(snap.connected, false);
  assert.strictEqual(typeof snap.updatedAtMs, 'number');
});

test('a new sessionUID resets per-car history', () => {
  const fm = createFieldModel();
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1, 1n), { cars: lapCars() });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(2, 1n), { cars: lapCars({ [PLAYER]: { currentLapNum: 11 } }) });
  assert.strictEqual(fm.getCar(PLAYER).lapHistory.length, 1);
  const gen = fm.getGeneration();
  fm.dispatch(PACKET_IDS.LAP_DATA, header(3, 2n), { cars: lapCars() });
  assert.strictEqual(fm.getCar(PLAYER).lapHistory.length, 0);
  assert.strictEqual(fm.getGeneration(), gen + 1);
});

// Seen on real F1 26 races: at the chequered flag the game sends every car's
// Session History with a session UID of 0 (same game time, same player), then
// carries on under the race's UID. Read as a new session, it wiped the field
// there - the final lap and the official result never reached the debrief.
test('a packet with session UID 0 is part of the current session, not a new one', () => {
  const fm = createFieldModel();
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1, 7n), { cars: lapCars() });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(2, 7n), { cars: lapCars({ [PLAYER]: { currentLapNum: 11 } }) });
  const gen = fm.getGeneration();
  fm.dispatch(PACKET_IDS.SESSION_HISTORY, header(2, 0n), { carIdx: PLAYER, laps: [{ lapMs: 90000, s1: 30000, s2: 30000, s3: 30000, valid: true }] });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(2.1, 7n), { cars: lapCars({ [PLAYER]: { currentLapNum: 11 } }) });
  assert.strictEqual(fm.getGeneration(), gen);
  assert.strictEqual(fm.getCar(PLAYER).lapHistory.length, 1);
  assert.strictEqual(fm.getCar(PLAYER).sessionHistory.laps.length, 1);
  assert.strictEqual(fm.getSessionUID(), 7n);
});

test('undercut threat survives LapData arriving faster than the insight tick', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars() });
  // Car behind (P4) enters the pits, then several more LapData packets land before evaluate().
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1.02), { cars: lapCars({ 3: { pitStatus: 1 } }) });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1.04), { cars: lapCars({ 3: { pitStatus: 1 } }) });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1.06), { cars: lapCars({ 3: { pitStatus: 1 } }) });
  const ids = ie.evaluate().map((i) => i.id);
  assert.ok(ids.includes('undercut-3'), `expected undercut-3 in ${ids}`);
});

test('closing-ahead fires on a realistic per-lap closing rate, measured on game time', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  // 60Hz packets for 40s, gap to the car ahead shrinking 0.5s per 90s lap.
  for (let t = 0; t <= 40; t += 1 / 60) {
    const gap = 2000 - (t / 90) * 500;
    fm.dispatch(PACKET_IDS.LAP_DATA, header(t), { cars: lapCars({ [PLAYER]: { deltaToCarInFrontInMS: gap } }) });
  }
  const insight = ie.evaluate().find((i) => i.id === 'closing-ahead');
  assert.ok(insight, 'closing-ahead should fire');
  assert.match(insight.message, /by 0\.5s\/lap/);
});

test('a flashback (game time going backwards) restarts the gap history', () => {
  const fm = createFieldModel();
  for (let t = 0; t <= 20; t += 1) fm.dispatch(PACKET_IDS.LAP_DATA, header(t), { cars: lapCars() });
  assert.ok(fm.getCar(PLAYER).gapAheadHistory.length > 10);
  fm.dispatch(PACKET_IDS.LAP_DATA, header(12), { cars: lapCars() }); // rewound 8s
  fm.dispatch(PACKET_IDS.LAP_DATA, header(13), { cars: lapCars() });
  assert.deepStrictEqual(fm.getCar(PLAYER).gapAheadHistory.map((s) => s.t), [12, 13]);
});

test('the tyre-cliff warning clears on fresh tyres after a stop', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  const step = (t, lapNum, wear, age) => {
    fm.dispatch(PACKET_IDS.CAR_STATUS, header(t), { cars: Array.from({ length: 5 }, () => ({ tyresAgeLaps: age, fuelRemainingLaps: 1 })) });
    fm.dispatch(PACKET_IDS.CAR_DAMAGE, header(t), { cars: Array.from({ length: 5 }, () => ({ tyresWear: [wear, wear, wear, wear] })) });
    fm.dispatch(PACKET_IDS.LAP_DATA, header(t), { cars: lapCars({ [PLAYER]: { currentLapNum: lapNum } }) });
    return ie.evaluate();
  };
  step(1, 10, 70, 18);
  assert.ok(step(2, 11, 80, 19).some((i) => i.id === 'tyre-cliff'));
  // New set: age back to 0, wear near zero.
  assert.ok(!step(3, 12, 2, 0).some((i) => i.id === 'tyre-cliff'));
});

test('events name the driver: one fastest-lap card, and only the player\'s penalties', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  fm.dispatch(PACKET_IDS.PARTICIPANTS, header(1), { participants: ['A', 'B', 'ME', 'D', 'E'].map((name) => ({ name })) });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars() });
  fm.dispatch(PACKET_IDS.EVENT, header(1.1), { code: 'FTLP', name: 'Fastest Lap', vehicleIdx: 0, lapTimeS: 91.427 });
  fm.dispatch(PACKET_IDS.EVENT, header(1.2), { code: 'FTLP', name: 'Fastest Lap', vehicleIdx: 1, lapTimeS: 91.088 });
  fm.dispatch(PACKET_IDS.EVENT, header(1.3), { code: 'PENA', name: 'Warning', penaltyType: 5, vehicleIdx: 4, lapNum: 3 });
  fm.dispatch(PACKET_IDS.EVENT, header(1.4), { code: 'PENA', name: 'Warning', penaltyType: 5, vehicleIdx: PLAYER, lapNum: 3 });
  // Type 16 ("Retired" in F1 25) arrived mid-race for a player still racing in F1 26 - kept off the radio.
  fm.dispatch(PACKET_IDS.EVENT, header(1.5), { code: 'PENA', name: 'Retired', penaltyType: 16, vehicleIdx: PLAYER, lapNum: 4 });
  // Type 6 ("Disqualified" in F1 25) arrived in a real F1 26 qualifying; the driver went on to set the fastest lap.
  fm.dispatch(PACKET_IDS.EVENT, header(1.6), { code: 'PENA', name: 'Disqualified', penaltyType: 6, vehicleIdx: PLAYER, lapNum: 4 });
  const msgs = ie.evaluate().filter((i) => i.category === 'flag').map((i) => i.message);
  assert.deepStrictEqual(msgs.sort(), ['Fastest lap: B 1:31.088', 'Warning for you, lap 3']);
});

test('the final lap is recorded at the chequered flag, when the lap counter does not move', () => {
  const fm = createFieldModel();
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars({ [PLAYER]: { currentLapNum: 5, lastLapTimeInMS: 95391, resultStatus: 2 } }) });
  // Crossing the line: status -> finished, then the last lap time updates.
  fm.dispatch(PACKET_IDS.LAP_DATA, header(2), { cars: lapCars({ [PLAYER]: { currentLapNum: 5, lastLapTimeInMS: 95391, resultStatus: 3 } }) });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(2.1), { cars: lapCars({ [PLAYER]: { currentLapNum: 5, lastLapTimeInMS: 94643, resultStatus: 3 } }) });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(2.2), { cars: lapCars({ [PLAYER]: { currentLapNum: 5, lastLapTimeInMS: 94643, resultStatus: 3 } }) });
  assert.deepStrictEqual(fm.getCar(PLAYER).lapHistory.map((l) => [l.lapNum, l.lapMs]), [[5, 94643]]);
});

test('a flashback back across the line undoes laps instead of recording fake ones', () => {
  const fm = createFieldModel();
  const lapTo = (t, n, ms) => fm.dispatch(PACKET_IDS.LAP_DATA, header(t), { cars: lapCars({ [PLAYER]: { currentLapNum: n, lastLapTimeInMS: ms } }) });
  lapTo(1, 3, 75000);
  lapTo(2, 4, 75500); // lap 3 done
  lapTo(3, 5, 76000); // lap 4 done
  lapTo(4, 4, 75500); // flashback to lap 4
  lapTo(5, 5, 75900); // lap 4 driven again
  assert.deepStrictEqual(fm.getCar(PLAYER).lapHistory.map((l) => [l.lapNum, l.lapMs]), [[3, 75500], [4, 75900]]);
});

test('a red flag is a stoppage: HOLD, no defend or ERS advice, laps flagged', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  fm.dispatch(PACKET_IDS.SESSION, header(1), { sessionType: 15, totalLaps: 30, trackLength: 5000, safetyCarStatus: 0 });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars({ 3: { deltaToCarInFrontInMS: 300 } }) });
  fm.dispatch(PACKET_IDS.EVENT, header(1.1), { code: 'RDFL', name: 'Red Flag' });
  const insights = ie.evaluate();
  assert.ok(!insights.some((i) => i.id === 'under-attack'));
  assert.deepStrictEqual(ie.getStrategy().call, { action: 'HOLD', kind: 'red-flag', reason: 'Red flag - race stopped' });
  fm.dispatch(PACKET_IDS.EVENT, header(2), { code: 'LGOT', name: 'Lights Out' });
  ie.evaluate();
  assert.notStrictEqual(ie.getStrategy().call.reason, 'Red flag - race stopped');
});

test('a retirement is announced once, however often the game re-sends it', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars() });
  for (const t of [1.1, 1.2, 1.3]) fm.dispatch(PACKET_IDS.EVENT, header(t), { code: 'RTMT', name: 'Retirement', vehicleIdx: 4 });
  assert.strictEqual(ie.evaluate().filter((i) => /has retired/.test(i.message)).length, 1);
});

test('closing-ahead is not called once already within a second', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  for (let t = 0; t <= 40; t += 1 / 20) {
    const gap = 900 - (t / 90) * 500; // closing fast, but already in DRS range
    fm.dispatch(PACKET_IDS.LAP_DATA, header(t), { cars: lapCars({ [PLAYER]: { deltaToCarInFrontInMS: gap } }) });
  }
  assert.ok(!ie.evaluate().some((i) => i.id === 'closing-ahead'));
});

test('closing-ahead stays quiet when the gap is stable', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  for (let t = 0; t <= 40; t += 1 / 20) fm.dispatch(PACKET_IDS.LAP_DATA, header(t), { cars: lapCars() });
  assert.ok(!ie.evaluate().some((i) => i.id === 'closing-ahead'));
});

const fuelStatus = (fuelRemainingLaps) => ({ cars: Array.from({ length: 5 }, () => ({ fuelRemainingLaps })) });

test('fuel: the MFD surplus reading is used as the margin directly', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  fm.dispatch(PACKET_IDS.SESSION, header(1), { totalLaps: 50, trackLength: 5000 });
  // Lap 10 of 50, the game says +0.5: 40 laps left would make laps-of-fuel nonsense.
  fm.dispatch(PACKET_IDS.LAP_DATA, header(2), { cars: lapCars({ [PLAYER]: { currentLapNum: 10 } }) });
  fm.dispatch(PACKET_IDS.CAR_STATUS, header(2), fuelStatus(0.5));
  assert.ok(!ie.evaluate().some((i) => i.id === 'fuel-risk'));
  assert.ok(Math.abs(ie.getStrategy().fuelMarginLaps - 0.5) < 1e-9);
  fm.dispatch(PACKET_IDS.CAR_STATUS, header(3), fuelStatus(-0.4));
  assert.strictEqual(ie.evaluate().find((i) => i.id === 'fuel-risk').severity, 'critical');
  // 0.4 laps short over ~41 laps: save ~1% of each lap's fuel.
  assert.strictEqual(ie.getStrategy().fuelSavePct, 1);
  fm.dispatch(PACKET_IDS.CAR_STATUS, header(4), fuelStatus(-2));
  ie.evaluate();
  assert.strictEqual(ie.getStrategy().fuelSavePct, 5);
  assert.match(ie.getStrategy().call.reason, /save ~5% a lap/);
});

test('fuel margin uses remaining race distance, so it does not jump at the line', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  fm.dispatch(PACKET_IDS.SESSION, header(1), { totalLaps: 20, trackLength: 5000 });
  const status = fuelStatus;
  // Early on, laps-of-fuel is unmistakable (15.6 laps of fuel, 15.98 laps to go).
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1.5), { cars: lapCars({ [PLAYER]: { currentLapNum: 5, lapDistance: 100 } }) });
  fm.dispatch(PACKET_IDS.CAR_STATUS, header(1.5), status(16.5));
  ie.evaluate();
  // Just before the line on lap 15: 5.02 laps of race left, 5.52 laps of fuel -> 0.5 margin, fine.
  fm.dispatch(PACKET_IDS.LAP_DATA, header(2), { cars: lapCars({ [PLAYER]: { currentLapNum: 15, lapDistance: 4900 } }) });
  fm.dispatch(PACKET_IDS.CAR_STATUS, header(2), status(5.52));
  assert.ok(!ie.evaluate().some((i) => i.id === 'fuel-risk'));
  // Just after the line, same fuel: still a 0.5 margin - the old whole-lap count saw a sudden swing here.
  fm.dispatch(PACKET_IDS.LAP_DATA, header(2.1), { cars: lapCars({ [PLAYER]: { currentLapNum: 16, lapDistance: 100 } }) });
  assert.ok(!ie.evaluate().some((i) => i.id === 'fuel-risk'));
  // Genuinely short.
  fm.dispatch(PACKET_IDS.CAR_STATUS, header(2.2), status(4.5));
  const fuel = ie.evaluate().find((i) => i.id === 'fuel-risk');
  assert.strictEqual(fuel.severity, 'critical');
});

test('insights are ordered most severe first', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  fm.dispatch(PACKET_IDS.SESSION, header(1), { totalLaps: 20, trackLength: 5000 });
  // P4 right behind the player (advisory defend), P2 just pitted (info
  // overcut), then a safety car deployment call (critical) - the event lands
  // before the Session packet says the safety car is out.
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars({ 3: { deltaToCarInFrontInMS: 300 } }) });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1.1), { cars: lapCars({ 1: { pitStatus: 1 }, 3: { deltaToCarInFrontInMS: 300 } }) });
  fm.dispatch(PACKET_IDS.EVENT, header(1.2), { code: 'SCAR', name: 'Safety Car' });
  const severities = ie.evaluate().map((i) => i.severity);
  assert.ok(severities.length >= 2, `expected several insights, got ${severities}`);
  assert.strictEqual(severities[0], 'critical');
  assert.deepStrictEqual([...severities].sort((a, b) => ['critical', 'advisory', 'info'].indexOf(a) - ['critical', 'advisory', 'info'].indexOf(b)), severities);
});

test('the car ahead pitting is an overcut opportunity, not an undercut threat', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars() });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1.1), { cars: lapCars({ 1: { pitStatus: 1 } }) });
  const insights = ie.evaluate();
  assert.ok(!insights.some((i) => i.id.startsWith('undercut')));
  assert.strictEqual(insights.find((i) => i.id === 'overcut-1').severity, 'info');
});

test('a safety car followed by another event in the same tick still raises the call', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars() });
  fm.dispatch(PACKET_IDS.EVENT, header(1.01), { code: 'SCAR', name: 'Safety Car deployed', safetyCarType: 1, safetyCarEventType: 0 });
  fm.dispatch(PACKET_IDS.EVENT, header(1.02), { code: 'BUTN', name: 'Button Status' });
  const sc = ie.evaluate().find((i) => i.category === 'flag');
  assert.ok(sc, 'safety car call should not be masked by the newer BUTN event');
  assert.strictEqual(sc.severity, 'critical');
});

test('race-only rules stay quiet outside a race and when the gap is unknown (0)', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  // Qualifying (sessionType 8) with almost no fuel and a car "right behind".
  fm.dispatch(PACKET_IDS.SESSION, header(1), { sessionType: 8, totalLaps: 20, trackLength: 5000 });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars({ 3: { deltaToCarInFrontInMS: 200 } }) });
  fm.dispatch(PACKET_IDS.CAR_STATUS, header(1), { cars: Array.from({ length: 5 }, () => ({ fuelRemainingLaps: 1 })) });
  assert.deepStrictEqual(ie.evaluate().map((i) => i.id), []);

  // A race, but the car behind reports 0 (no timing yet, e.g. on the grid).
  const fm2 = createFieldModel();
  const ie2 = createInsightEngine(fm2);
  fm2.dispatch(PACKET_IDS.SESSION, header(1), { sessionType: 15, totalLaps: 20, trackLength: 5000 });
  fm2.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars({ 3: { deltaToCarInFrontInMS: 0 } }) });
  assert.ok(!ie2.evaluate().some((i) => i.id === 'under-attack'));
});

// Player P3 on 10-lap-old tyres, car ahead (P2) on 12-lap-old ones.
function raceWithTyres(fm, { safetyCarStatus = 0, myAge = 10, theirAge = 12 } = {}) {
  fm.dispatch(PACKET_IDS.SESSION, header(1), { sessionType: 15, totalLaps: 30, trackLength: 5000, trackId: 17, safetyCarStatus });
  fm.dispatch(PACKET_IDS.CAR_STATUS, header(1), {
    cars: Array.from({ length: 5 }, (_, i) => ({ fuelRemainingLaps: 40, tyresAgeLaps: i === PLAYER ? myAge : theirAge })),
  });
}

test('defending is never a screen-interrupting critical call', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  raceWithTyres(fm);
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars({ 3: { deltaToCarInFrontInMS: 200 } }) });
  assert.strictEqual(ie.evaluate().find((i) => i.id === 'under-attack').severity, 'advisory');
});

test('under a safety car: no defend calls, HOLD instead of PUSH, and a cheap-stop BOX', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  const ra = createRaceAnalysis(fm);
  raceWithTyres(fm, { safetyCarStatus: 2 });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars({ 3: { deltaToCarInFrontInMS: 200 } }) });
  const insights = ie.evaluate(ra.compute());
  assert.ok(!insights.some((i) => i.id === 'under-attack'));
  const cheap = insights.find((i) => i.id === 'cheap-stop');
  // Track 17 (Austria) estimate is 20s; a VSC makes it ~13s.
  assert.match(cheap.message, /VSC: a stop costs ~13s, not ~20s/);
  assert.strictEqual(ie.getStrategy().call.action, 'BOX');

  // Fresh tyres: a stop isn't worth it, so just hold position.
  const fm2 = createFieldModel();
  const ie2 = createInsightEngine(fm2);
  raceWithTyres(fm2, { safetyCarStatus: 1, myAge: 2 });
  fm2.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars() });
  ie2.evaluate();
  assert.deepStrictEqual(ie2.getStrategy().call, { action: 'HOLD', kind: 'neutralised', reason: 'Safety car - hold position, keep the delta positive' });
});

test('undercut window on the car ahead needs a close gap, old tyres, clean air - and the car ahead due to stop', () => {
  const analysis = (inTraffic, theyStopIn) => ({ rejoin: { position: 4, positionsLost: 1, inTraffic, ahead: null, behind: null }, field: [{ carIndex: 1, stopInLaps: theyStopIn }], tyreModel: { mine: { compound: 17, degMsPerLap: 100 } } });
  const run = (opts, gapAhead, inTraffic = false, theyStopIn = 2) => {
    const fm = createFieldModel();
    const ie = createInsightEngine(fm);
    raceWithTyres(fm, opts);
    fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars({ [PLAYER]: { deltaToCarInFrontInMS: gapAhead } }) });
    return ie.evaluate(analysis(inTraffic, theyStopIn)).find((i) => i.id === 'undercut-window');
  };
  assert.match(run({}, 1200).message, /Undercut on P2 is on - they're due in ~2 laps: box now, ~1\.2s ahead after their stop/);
  assert.ok(!run({}, 1200, false, null), 'the car ahead has no stop left to make');
  assert.ok(!run({}, 1200, false, 6), 'the car ahead is not stopping for a while');
  assert.ok(!run({}, 2500), 'too far back to jump the car');
  assert.ok(!run({}, 1200, true), 'would rejoin in traffic');
  assert.ok(!run({ myAge: 3 }, 1200), 'own tyres too fresh to stop');
  assert.ok(!run({ theirAge: 2 }, 1200), 'car ahead already on fresher tyres');
});

test('the call says PIT, not BOX, once the player is in the pit lane', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  raceWithTyres(fm, { safetyCarStatus: 2 });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars({ [PLAYER]: { pitStatus: 1 } }) });
  ie.evaluate();
  assert.strictEqual(ie.getStrategy().call.action, 'PIT');
});


test('pit window: the simulator picking this lap by a clear margin is a BOX call; a near-tie is not', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars() });
  const timing = (marginS) => ({ pitTiming: { marginS, options: [{ id: 'box-0', inLaps: 0, best: true, rejoinPosition: 5, inTraffic: false, compoundName: 'Hard' }] } });
  const insights = ie.evaluate(timing(2.4));
  assert.match(insights.find((i) => i.id === 'pit-window').message, /^Pit window - box this lap, rejoin P5 on hards, 2\.4s better than waiting$/);
  assert.strictEqual(ie.getStrategy().call.action, 'BOX');
  assert.ok(!ie.evaluate(timing(0.6)).some((i) => i.id === 'pit-window'));
  assert.strictEqual(ie.getStrategy().call.action, 'PUSH');
});

test('the start: lap 1 against the grid, said once as lap 2 begins', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  fm.dispatch(PACKET_IDS.SESSION, header(1), { totalLaps: 20, trackLength: 5000, sessionType: 15 });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(2), { cars: lapCars({ [PLAYER]: { currentLapNum: 1, gridPosition: 5 } }) });
  assert.ok(!ie.evaluate().some((i) => i.id === 'start'));
  fm.dispatch(PACKET_IDS.LAP_DATA, header(3), { cars: lapCars({ [PLAYER]: { currentLapNum: 2, gridPosition: 5 } }) });
  const pos = fm.getCar(PLAYER).lapData.carPosition;
  assert.strictEqual(ie.evaluate().find((i) => i.id === 'start').message, `Lap 1: P${pos} from P5 on the grid - up ${5 - pos}`);
});

test('a card whose numbers tick keeps its text for a few seconds; a new word shows at once', () => {
  const realNow = Date.now;
  let now = 1e6;
  Date.now = () => now;
  try {
    const fm = createFieldModel();
    const ie = createInsightEngine(fm);
    fm.dispatch(PACKET_IDS.SESSION, header(1), { totalLaps: 50, trackLength: 5000 });
    fm.dispatch(PACKET_IDS.LAP_DATA, header(2), { cars: lapCars({ [PLAYER]: { currentLapNum: 10 } }) });
    const fuel = (v) => {
      fm.dispatch(PACKET_IDS.CAR_STATUS, header(3), fuelStatus(v));
      return ie.evaluate().find((i) => i.id === 'fuel-risk').message;
    };
    assert.match(fuel(0.2), /only 0\.2 laps/);
    now += 1000;
    assert.match(fuel(0.1), /only 0\.2 laps/); // held
    now += 5000;
    assert.match(fuel(0.1), /only 0\.1 laps/);
    now += 1000;
    assert.match(fuel(-0.1), /laps short/); // different words: at once
  } finally {
    Date.now = realNow;
  }
});

// Barcelona, 17 Oct: the call flipped "undercut on" <-> "Tyres and fuel OK" 7
// times in 3.5 minutes, and the undercut said "rejoin P21 in clean air" from P8.
const undercutAnalysis = ({ deg = 100, theyStopIn = 2 } = {}) => ({
  rejoin: { position: 21, positionsLost: 13, inTraffic: false, ahead: null, behind: null },
  field: [{ carIndex: 1, stopInLaps: theyStopIn }],
  tyreModel: deg == null ? null : { mine: { compound: 17, degMsPerLap: deg } },
});

test('undercut: only when fresh tyres gain more before they stop than the gap to them', () => {
  const run = (gapAhead, a) => {
    const fm = createFieldModel();
    const ie = createInsightEngine(fm);
    raceWithTyres(fm);
    fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars({ [PLAYER]: { deltaToCarInFrontInMS: gapAhead } }) });
    return ie.evaluate(a).find((i) => i.id === 'undercut-window');
  };
  // 100 ms/lap on 12-lap-old tyres: 1.2 s a lap for the 2 laps until they stop = 2.4 s > 1.2 s.
  const on = run(1200, undercutAnalysis());
  assert.match(on.message, /^Undercut on P2 is on - they're due in ~2 laps: box now, ~1\.2s ahead after their stop$/);
  assert.doesNotMatch(on.message, /clean air|rejoin P21/, 'everyone yet to stop passes you for a while - that is the undercut, not news');
  assert.ok(!run(1200, undercutAnalysis({ deg: 40 })), '0.48 s a lap x 2 laps = 0.96 s: not enough to jump a 1.2 s gap');
  assert.ok(!run(1200, undercutAnalysis({ deg: null })), 'no tyre model yet: no evidence the undercut works');
});

test('the call: a calm call has to hold 5 s before it replaces another calm one; urgent calls come at once', () => {
  let t = 0;
  const fm = createFieldModel({ clock: () => t });
  const ie = createInsightEngine(fm);
  raceWithTyres(fm);
  const at = (ms, gapAhead, { sc = 0 } = {}) => {
    t = ms;
    if (sc) fm.dispatch(PACKET_IDS.SESSION, header(ms / 1000), { sessionType: 15, totalLaps: 30, trackLength: 5000, trackId: 17, safetyCarStatus: sc });
    fm.dispatch(PACKET_IDS.LAP_DATA, header(ms / 1000), { cars: lapCars({ [PLAYER]: { deltaToCarInFrontInMS: gapAhead } }) });
    ie.evaluate(undercutAnalysis());
    return ie.getStrategy().call.kind;
  };
  assert.strictEqual(at(0, 2500), 'ok');
  assert.strictEqual(at(1000, 1200), 'ok', 'the undercut has to hold first');
  assert.strictEqual(at(6500, 1200), 'undercut');
  assert.strictEqual(at(7000, 2500), 'undercut', 'a 1-2 s dip out of the window does not flip it back');
  assert.strictEqual(at(8000, 1200), 'undercut');
  assert.strictEqual(at(9000, 2500), 'undercut');
  assert.strictEqual(at(14500, 2500), 'ok', 'out of the window for 5 s: it is over');
  assert.strictEqual(at(15000, 2500, { sc: 1 }), 'cheap-stop', 'a safety car (a cheap stop on 10-lap-old tyres) is said at once');
});

test('defending: one card for the car behind - the battle call speaks on it, not on a second one', () => {
  let t = 0;
  const fm = createFieldModel({ clock: () => t });
  const ie = createInsightEngine(fm);
  raceWithTyres(fm);
  const battle = { battle: { call: { mode: 'DEFEND', target: 'HADJAR', reason: 'watch into corner 11' } } };
  const at = (ms) => {
    t = ms;
    fm.dispatch(PACKET_IDS.LAP_DATA, header(ms / 1000), { cars: lapCars({ 3: { deltaToCarInFrontInMS: 400 } }) });
    return ie.evaluate(battle).filter((i) => /defend/i.test(i.message) || i.id === 'battle-call');
  };
  for (const ms of [0, 3000, 6000, 9000]) {
    const cards = at(ms);
    assert.deepStrictEqual(cards.map((c) => c.id), ['under-attack'], `at ${ms} ms: ${cards.map((c) => c.message)}`);
  }
  assert.match(at(12000)[0].message, /^Defend from HADJAR - watch into corner 11/, 'the settled battle call replaces the text');
});

test('the call: a calm call that drops out has to hold 5 s again from the start', () => {
  let t = 0;
  const fm = createFieldModel({ clock: () => t });
  const ie = createInsightEngine(fm);
  raceWithTyres(fm);
  const at = (ms, gapAhead) => {
    t = ms;
    fm.dispatch(PACKET_IDS.LAP_DATA, header(ms / 1000), { cars: lapCars({ [PLAYER]: { deltaToCarInFrontInMS: gapAhead } }) });
    ie.evaluate(undercutAnalysis());
    return ie.getStrategy().call.kind;
  };
  at(0, 2500);
  at(1000, 1200);
  at(2000, 2500); // gone again
  assert.strictEqual(at(6500, 1200), 'ok', 'back for a moment - not 5 s since it first showed');
});

test('defending: the battle call on the defend card holds its text while only the numbers change', () => {
  let t = 0;
  const fm = createFieldModel({ clock: () => t });
  const ie = createInsightEngine(fm);
  raceWithTyres(fm);
  const at = (ms, reason) => {
    t = ms;
    fm.dispatch(PACKET_IDS.LAP_DATA, header(ms / 1000), { cars: lapCars({ 3: { deltaToCarInFrontInMS: 400 } }) });
    return ie.evaluate({ battle: { call: { mode: 'DEFEND', target: 'HADJAR', reason } } }).find((i) => i.id === 'under-attack').message;
  };
  for (const ms of [0, 3000, 6000]) at(ms, '0.4s behind');
  assert.strictEqual(at(7000, '0.3s behind'), 'Defend from HADJAR - 0.4s behind', 'radio text must not tick');
});

test('closing-ahead does not measure across a VSC: the gap shrinks while the field bunches up', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  const vsc = (status) => fm.dispatch(PACKET_IDS.SESSION, header(0), { sessionType: 15, totalLaps: 20, trackLength: 5000, safetyCarStatus: status });
  vsc(2);
  // 30s of VSC: the gap ahead comes down from 5s to 2s.
  for (let t = 0; t <= 30; t += 1) fm.dispatch(PACKET_IDS.LAP_DATA, header(t), { cars: lapCars({ [PLAYER]: { deltaToCarInFrontInMS: 5000 - t * 100 } }) });
  vsc(0);
  // Green again, the gap holding at 2s: nobody is closing.
  for (let t = 31; t <= 50; t += 1) fm.dispatch(PACKET_IDS.LAP_DATA, header(t), { cars: lapCars({ [PLAYER]: { deltaToCarInFrontInMS: 2000 } }) });
  assert.ok(!ie.evaluate().some((i) => i.id === 'closing-ahead'));
});

test('closing-ahead is not called on lap 1 - the start scrambles every gap (Montreal: "Closing on P21 by 3.2s/lap")', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  for (let t = 0; t <= 40; t += 1) {
    fm.dispatch(PACKET_IDS.LAP_DATA, header(t), { cars: lapCars({ [PLAYER]: { currentLapNum: 1, lastLapTimeInMS: 0, deltaToCarInFrontInMS: 9000 - t * 30 } }) });
  }
  assert.ok(!ie.evaluate().some((i) => i.id === 'closing-ahead'));
});

test('a cheap stop under a safety car is not a BOX call when the options say stay out (Monaco, 15 Oct 2026)', () => {
  let now = 0;
  const fm = createFieldModel({ clock: () => now });
  const ie = createInsightEngine(fm);
  fm.dispatch(PACKET_IDS.SESSION, header(0), { sessionType: 15, totalLaps: 27, trackLength: 3337, safetyCarStatus: 1 });
  fm.dispatch(PACKET_IDS.CAR_STATUS, header(1), { cars: Array.from({ length: 5 }, () => ({ visualTyreCompound: 17, tyresAgeLaps: 12, fuelRemainingLaps: 2 })) });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: lapCars() });
  const analysis = (recommendedId) => ({ pitLoss: { ms: 10000, normalMs: 19000 }, options: { situation: 'Safety car', recommendedId, headline: 'Safety car: best is stay out' }, field: [] });
  const call = (rec) => { ie.evaluate(analysis(rec)); return ie.getStrategy().call.action; };
  for (let k = 0; k < 10; k++, now += 1000) assert.notStrictEqual(call('stay'), 'BOX');
  // A one-second flicker to "box" (Austria, 19:39) is not a call: it has to hold, like the card.
  assert.notStrictEqual(call('box-17'), 'BOX');
  now += 1000;
  assert.notStrictEqual(call('stay'), 'BOX');
  for (let k = 0; k < 6; k++, now += 1000) call('box-17');
  assert.strictEqual(call('box-17'), 'BOX');
});
