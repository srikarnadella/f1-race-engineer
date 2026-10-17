const test = require('node:test');
const assert = require('node:assert');
const PACKET_IDS = require('../src/udp/packetIds');
const { qualifying, cutPosition } = require('../src/analysis/qualifying');
const { createFieldModel } = require('../src/state/fieldModel');
const { createInsightEngine } = require('../src/state/insightEngine');
const { createRaceAnalysis } = require('../src/state/raceAnalysis');
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
