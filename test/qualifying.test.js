const test = require('node:test');
const assert = require('node:assert');
const PACKET_IDS = require('../src/udp/packetIds');
const { qualifying, cutPosition } = require('../src/analysis/qualifying');
const { createFieldModel } = require('../src/state/fieldModel');
const { createInsightEngine } = require('../src/engine/insightEngine');
const { createRaceAnalysis } = require('../src/engine/raceAnalysis');
const { ask } = require('../public/ask');

// 20 cars: car i's best is 75.000 + i x 0.1s; the player (car 19) has 76.500.
function field({ status = 1, lapDistance = 1000, playerBest = 76500, invalid = 0 } = {}) {
  return Array.from({ length: 20 }, (_, i) => ({
    carIndex: i,
    participant: { name: `D${i}` },
    telemetry: { speed: 180 },
    lapData: { carPosition: i + 1, pitStatus: 0, driverStatus: i === 19 ? status : 4, lapDistance: i === 19 ? lapDistance : 3000, lastLapTimeInMS: 0, currentLapInvalid: i === 19 ? invalid : 0 },
    sessionHistory: { bestLapNum: 1, laps: [{ lapMs: i === 19 ? playerBest : 75000 + i * 100, valid: true }] },
  }));
}
const session = { sessionType: 5, trackLength: 5000, sessionTimeLeft: 400 };

test('qualifying: the knockout line, and where this lap would put you', () => {
  assert.strictEqual(cutPosition(5, 20), 15);
  assert.strictEqual(cutPosition(5, 22), 16);
  assert.strictEqual(cutPosition(6, 22), 10);
  assert.strictEqual(cutPosition(8, 22), null);
  const cars = field();
  // 0.2s up on your best: 76.300 beats cars 14-18 -> P14.
  const q = qualifying({ session, cars, player: cars[19], delta: { bestLapTimeInMS: 76500, deltaToBestMs: -200 } });
  assert.strictEqual(q.name, 'Q1');
  assert.strictEqual(q.status, 'flying');
  assert.strictEqual(q.position, 16);
  assert.deepStrictEqual(q.projected, { lapMs: 76300, position: 14, improves: true });
  // P15 among the others is car 14 at 76.400: you're 0.100 short.
  assert.deepStrictEqual(q.cut, { position: 15, lineMs: 76400, marginMs: 100 });
  assert.strictEqual(q.gapToPoleMs, 1500);
  // Not a race, not a session the game has named yet.
  assert.strictEqual(qualifying({ session: { ...session, sessionType: 15 }, cars, player: cars[19], delta: {} }), null);
});

test('qualifying: time to the line on an out lap, runs left from the garage, traffic on the road', () => {
  const out = field({ status: 3, lapDistance: 4000 });
  // A fifth of a 76.5s lap at out-lap pace (x1.25): 19s to the line.
  const q = qualifying({ session, cars: out, player: out[19], delta: {} });
  assert.deepStrictEqual(q.toLine, { startsInS: 19, spareS: 381, makesIt: true });
  assert.strictEqual(qualifying({ session: { ...session, sessionTimeLeft: 10 }, cars: out, player: out[19], delta: {} }).toLine.makesIt, false);

  const garage = field({ status: 0 });
  garage[19].lapData.pitStatus = 1;
  // 400s: an out lap (95.6s), then a whole run (76.5 + 2 x 95.6 = 267.8s) each.
  assert.strictEqual(qualifying({ session, cars: garage, player: garage[19], delta: {} }).runs, 2);
  // Spa, short qualifying: the game puts the car on track 1.9 km from the line, so the garage to a
  // push lap took 33 s, not a full out lap. With 90 s left there's time for one more run.
  const late = { ...session, sessionTimeLeft: 90 };
  assert.strictEqual(qualifying({ session: late, cars: garage, player: garage[19], delta: {} }).runs, 0, 'guessed out lap: 95.6 s');
  assert.strictEqual(qualifying({ session: late, cars: garage, player: garage[19], delta: {}, outLapMs: 33000 }).runs, 1, 'measured out lap');

  // On a push lap, a car on an out lap 200m up the road is traffic; one alongside isn't.
  const push = field({ lapDistance: 2800 });
  for (const c of push.slice(0, 19)) c.lapData.lapDistance = 4500;
  Object.assign(push[3].lapData, { driverStatus: 3, lapDistance: 3000 });
  assert.deepStrictEqual(qualifying({ session, cars: push, player: push[19], delta: {} }).traffic, { ahead: { name: 'D3', gapS: 4, status: 'out' }, behind: null });
  push[19].lapData.lapDistance = 2990;
  assert.strictEqual(qualifying({ session, cars: push, player: push[19], delta: {} }).traffic.ahead, null);
});

test('qualifying: the call is about the lap, and the race calls stay quiet', () => {
  const PLAYER = 1;
  const header = (t) => ({ sessionUID: 7n, sessionTime: t, playerCarIndex: PLAYER });
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  const ra = createRaceAnalysis(fm);
  fm.dispatch(PACKET_IDS.SESSION, header(1), { sessionType: 8, trackLength: 5000, sessionTimeLeft: 300, safetyCarStatus: 0, forecast: [] });
  const lap = (driverStatus) => ({ cars: [0, 1].map((i) => ({ carPosition: i + 1, currentLapNum: 3, lastLapTimeInMS: 80000, deltaToCarInFrontInMS: i ? 300 : 0, deltaToRaceLeaderInMS: i ? 300 : 0, pitStatus: 0, lapDistance: 2500, driverStatus: i === PLAYER ? driverStatus : 1, resultStatus: 2 })) });
  const call = (driverStatus) => {
    fm.dispatch(PACKET_IDS.LAP_DATA, header(2), lap(driverStatus));
    const insights = ie.evaluate(ra.compute());
    return { call: ie.getStrategy().call, ids: insights.map((i) => i.id) };
  };
  const out = call(3);
  assert.strictEqual(out.call.action, 'PREP');
  assert.match(out.call.reason, /^Out lap - push lap starts in \d:\d\d, \d:\d\d to spare$/);
  const push = call(1);
  assert.strictEqual(push.call.action, 'PUSH');
  // A car 0.3s behind on track is not a car to defend from in qualifying.
  assert.ok(!push.ids.includes('under-attack'));
  assert.strictEqual(call(2).call.action, 'BOX');
});

test('qualifying: the garage-to-push-lap time is measured, and runs left use it (Spa, 20 Oct 2026)', () => {
  // The call said "no time for another run" with 2:15 left; the last trip from the garage had taken 33 s.
  const PLAYER = 1;
  const header = (t) => ({ sessionUID: 9n, sessionTime: t, playerCarIndex: PLAYER });
  const fm = createFieldModel();
  const ra = createRaceAnalysis(fm);
  const at = (t, driverStatus, pitStatus, left) => {
    fm.dispatch(PACKET_IDS.SESSION, header(t), { sessionType: 8, trackLength: 7004, sessionTimeLeft: left, safetyCarStatus: 0, forecast: [] });
    fm.dispatch(PACKET_IDS.LAP_DATA, header(t), { cars: [0, 1].map((i) => ({ carPosition: i + 1, currentLapNum: 1, lastLapTimeInMS: 0, pitStatus: i === PLAYER ? pitStatus : 0, lapDistance: 100, driverStatus: i === PLAYER ? driverStatus : 1, resultStatus: 2 })) });
    return ra.compute().quali;
  };
  at(800, 0, 1, 280);
  assert.strictEqual(at(818, 0, 1, 262).runs, 1, 'before it is measured: the guess (112.5 s out lap, 90 s lap)');
  at(819, 3, 0, 261);
  at(852, 1, 0, 228);
  assert.strictEqual(at(1123, 0, 1, 100).runs, 1, '100 s left, 33 s from the garage: one more run');
});

test('ask: damage, and qualifying answers', () => {
  const s = {
    player: { position: 5 },
    analysis: { damage: { parts: [{ label: 'Front-left wing', pct: 40, fixable: true }], lossPerLapMs: 800, toFlagMs: 12000, fix: { costMs: 26000, pays: false, stopAnyway: false } } },
  };
  assert.strictEqual(ask('how bad is the front wing', s).reply, 'front-left wing 40%: costing 0.8s a lap, about 12s to the flag. A new nose costs about 26s - not worth a stop.');
  assert.strictEqual(ask('damage', { player: {}, analysis: {} }).reply, 'No damage.');
  const q = { player: { position: 5 }, analysis: { quali: { name: 'Q1', position: 14, gapToPoleMs: 1200, cut: { position: 15, marginMs: -80 }, timeLeftS: 125, traffic: { ahead: { name: 'STROLL', gapS: 1.3, status: 'out' }, behind: null } } } };
  assert.strictEqual(ask('am I through', q).reply, 'Q1: P14, 0.080 clear of the cut, 2 minutes 5 left.');
  assert.strictEqual(ask('gap ahead', q).reply, 'STROLL on an out lap, 1.3s up the road.');
  assert.match(ask('when do I box', q).reply, /^No pit strategy outside a race\./);
});

test('a flashback into a safety-car lap keeps the lap marked as under the safety car', () => {
  const header = (t) => ({ sessionUID: 9n, sessionTime: t, playerCarIndex: 0 });
  const fm = createFieldModel();
  const lapData = (lapNum, lastLapTimeInMS) => ({ cars: [{ carPosition: 1, currentLapNum: lapNum, lastLapTimeInMS, pitStatus: 0, lapDistance: 100 }] });
  const sc = (status) => fm.dispatch(PACKET_IDS.SESSION, header(1), { sessionType: 15, trackLength: 5000, safetyCarStatus: status, forecast: [] });
  sc(1);
  fm.dispatch(PACKET_IDS.LAP_DATA, header(10), lapData(7, 80000)); // lap 7 under the safety car
  sc(0);
  fm.dispatch(PACKET_IDS.LAP_DATA, header(20), lapData(8, 115000)); // green from lap 8
  fm.dispatch(PACKET_IDS.LAP_DATA, header(15), lapData(7, 80000)); // flashback into lap 7
  fm.dispatch(PACKET_IDS.LAP_DATA, header(25), lapData(8, 115400)); // lap 7 again, re-run
  const lap7 = fm.getCar(0).lapHistory.find((l) => l.lapNum === 7);
  assert.strictEqual(lap7.neutralised, true);
});

test('review fixes: time trial has no clock, an in lap has no countdown, damage seen from the start has no baseline', () => {
  const tt = field({ status: 3, lapDistance: 4000 });
  const q = qualifying({ session: { ...session, sessionType: 18, sessionTimeLeft: 0 }, cars: tt, player: tt[19], delta: {} });
  assert.strictEqual(q.timeLeftS, null);
  assert.deepStrictEqual(q.toLine, { startsInS: 19, spareS: null, makesIt: true });
  const inLap = field({ status: 2, lapDistance: 4000 });
  assert.strictEqual(qualifying({ session, cars: inLap, player: inLap[19], delta: {} }).toLine, null);

  // The dashboard joins with the front wing already broken: no clean lap it knows of.
  const header = (t) => ({ sessionUID: 11n, sessionTime: t, playerCarIndex: 0 });
  const fm = createFieldModel();
  fm.dispatch(PACKET_IDS.SESSION, header(1), { sessionType: 15, totalLaps: 30, trackLength: 5000, safetyCarStatus: 0, forecast: [] });
  fm.dispatch(PACKET_IDS.CAR_DAMAGE, header(1), { cars: [{ tyresWear: [0, 0, 0, 0], frontLeftWingDamage: 40, frontRightWingDamage: 0, rearWingDamage: 0, floorDamage: 0, diffuserDamage: 0, sidepodDamage: 0 }] });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(2), { cars: [{ carPosition: 1, currentLapNum: 14, lastLapTimeInMS: 80000, pitStatus: 0, lapDistance: 100, resultStatus: 2 }] });
  assert.strictEqual(createRaceAnalysis(fm).compute().damage.basis, 'no-baseline');
});

test('qualifying: 2 s down mid-lap, the lap is gone - not "PUSH, on for P22" (Silverstone cool-down lap, 19 Oct 2026)', () => {
  const { qualiCall } = require('../src/engine/calls');
  const cars = field();
  const q = (deltaToBestMs) => qualiCall(qualifying({ session, cars, player: cars[19], delta: { bestLapTimeInMS: 76500, deltaToBestMs } }));
  assert.strictEqual(q(1900).action, 'PUSH');
  // No figure: it grows every tick and would rewrite the call ten times a second.
  assert.deepStrictEqual(q(2100), { action: 'PREP', reason: 'Lap gone - set up the next one' });
});

test('qualifying: on a lap that is gone, a push lap behind is the traffic to watch - let them by', () => {
  const cars = field({ lapDistance: 2800 });
  for (const c of cars.slice(0, 19)) c.lapData.lapDistance = 4500;
  Object.assign(cars[3].lapData, { driverStatus: 1, lapDistance: 2600 }); // on a push lap, 200 m back
  const tr = (deltaToBestMs) => qualifying({ session, cars, player: cars[19], delta: { bestLapTimeInMS: 76500, deltaToBestMs } }).traffic;
  assert.strictEqual(tr(-100).behind, null, 'on a push lap of your own, they are not in your way');
  assert.strictEqual(tr(2500).behind.name, 'D3');
});

test('qualifying in the wet: a dry best is no yardstick - "lap gone" is judged against your best on the same tyre', () => {
  const { qualiCall } = require('../src/engine/calls');
  // Your best (76.500) was set on softs; it's raining now and you're on inters.
  const wet = (history) => {
    const cars = field();
    cars[19].status = { visualTyreCompound: 7 };
    cars[19].lapHistory = history;
    return cars;
  };
  const dryOnly = wet([{ lapNum: 1, lapMs: 76500, compound: 16 }]);
  // 8 s down on the dry best is a decent wet lap, not a lost one - and nothing to judge it by yet.
  const first = qualifying({ session, cars: dryOnly, player: dryOnly[19], delta: { bestLapTimeInMS: 76500, deltaToBestMs: 8000 } });
  assert.strictEqual(first.lapGone, false);
  assert.notDeepStrictEqual(qualiCall(first), { action: 'PREP', reason: 'Lap gone - set up the next one' });
  // With an inters lap of 84.000 behind you, 87.000 projected is 3 s down on it: gone.
  const withWet = wet([{ lapNum: 1, lapMs: 76500, compound: 16 }, { lapNum: 3, lapMs: 84000, compound: 7 }]);
  const later = qualifying({ session, cars: withWet, player: withWet[19], delta: { bestLapTimeInMS: 76500, deltaToBestMs: 10500 } });
  assert.strictEqual(later.lapGone, true);
  // ...and 85.500 is 1.5 s down on it: still on.
  const close = qualifying({ session, cars: withWet, player: withWet[19], delta: { bestLapTimeInMS: 76500, deltaToBestMs: 9000 } });
  assert.strictEqual(close.lapGone, false);
  // Dry, it's unchanged: 2.1 s down on the slick best is gone.
  const dry = field();
  dry[19].status = { visualTyreCompound: 16 };
  assert.strictEqual(qualifying({ session, cars: dry, player: dry[19], delta: { bestLapTimeInMS: 76500, deltaToBestMs: 2100 } }).lapGone, true);
});
