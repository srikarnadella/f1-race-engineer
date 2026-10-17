const test = require('node:test');
const assert = require('node:assert');
const { compareLaps, consistency } = require('../src/analysis/lapCompare');
const { rivalAnalysis } = require('../src/analysis/rivals');
const { fitDegradation, stopPayback } = require('../src/ml/tyreModel');
const { train, predict, evaluate, auc } = require('../src/ml/logistic');
const { pairFeatures, FEATURES } = require('../src/ml/overtakeFeatures');

// A 2 km lap with one corner at 1000 m: braking from `brakeAt`, slowest at
// `apexKmh`. Rows are [d, tMs, speed, throttle, brake, steer, gear].
function lap(lapNum, { brakeAt = 900, apexKmh = 90, slowAfter = null } = {}) {
  const points = [];
  let t = 0;
  for (let d = 0; d <= 2000; d += 2) {
    let speed = 280;
    let brake = 0;
    let throttle = 1;
    if (d >= brakeAt && d < 1000) {
      speed = 280 - ((d - brakeAt) / (1000 - brakeAt)) * (280 - apexKmh);
      brake = 0.9;
      throttle = 0;
    } else if (d >= 1000 && d < 1200) {
      speed = apexKmh + ((d - 1000) / 200) * (280 - apexKmh);
    }
    if (slowAfter && d >= slowAfter[0] && d < slowAfter[1]) speed *= 0.7;
    if (d > 0) t += (2 / (speed / 3.6)) * 1000;
    points.push([d, Math.round(t), Math.round(speed), throttle, brake, 0, 5]);
  }
  return { lapNum, lapMs: Math.round(t), startedAtLine: true, points };
}

test('lap compare: explains a corner - earlier braking and a slower apex', () => {
  const best = lap(2);
  const worse = lap(3, { brakeAt: 860, apexKmh: 80 });
  const c = compareLaps(best, worse);
  assert.ok(c.totalS > 0, 'the worse lap is slower overall');
  assert.strictEqual(c.corners.length, 1);
  const k = c.corners[0];
  assert.strictEqual(k.brakePointM, -40); // braked 40 m earlier
  assert.strictEqual(k.apexKmh, -10);
  assert.ok(k.timeS > 0);
  assert.match(c.headline[0], /^Corner 1 \(0\.9 km\): lost \d\.\d\ds - braked 40 m earlier, 10 km\/h slower at the apex/);
  assert.strictEqual(c.miniSectors.length, 25);
});

test('lap compare: a loss away from any braking zone is still named', () => {
  const c = compareLaps(lap(2), lap(3, { slowAfter: [1500, 1700] }));
  assert.match(c.headline[0], /km: lost \d\.\d\ds away from a braking zone/);
});

test('consistency: braking-point spread per corner across laps', () => {
  const laps = [lap(2, { brakeAt: 900 }), lap(3, { brakeAt: 880 }), lap(4, { brakeAt: 920 })];
  const [corner] = consistency(laps);
  assert.strictEqual(corner.laps, 3);
  assert.ok(corner.brakePointSdM > 10 && corner.brakePointSdM < 25, `sd ${corner.brakePointSdM}`);
});

test('rivals: where the player loses time, ignoring glitched laps', () => {
  const splits = (base, slowAt = -1) => Array.from({ length: 25 }, (_, k) => base + (k === slowAt ? 300 : 0));
  const cars = [
    { name: 'YOU', isPlayer: true, miniSectors: [{ lapNum: 2, splits: splits(3700, 10) }, { lapNum: 3, splits: splits(3710, 10) }] },
    { name: 'NORRIS', isPlayer: false, miniSectors: [{ lapNum: 2, splits: splits(3700) }] },
    // A flashback-glitched lap: an impossible 0.3s slice.
    { name: 'GLITCH', isPlayer: false, miniSectors: [{ lapNum: 2, splits: [300, ...splits(3700).slice(1)] }] },
  ];
  const r = rivalAnalysis(cars, 5000);
  assert.strictEqual(r.rival.name, 'NORRIS');
  assert.ok(Math.abs(r.gapToRivalS - 0.3) < 1e-9);
  assert.strictEqual(r.biggestLosses[0].from, 11);
  assert.match(r.biggestLosses[0].text, /^2\.0-2\.2 km: 0\.30s slower than NORRIS/);
  assert.ok(r.fieldIdealLapMs > 25 * 3000, 'glitched split excluded from the field ideal');
});

test('tyre model: recovers the wear rate from the field, net of fuel', () => {
  // 4 cars, true wear 120 ms per lap of age, getting 40 ms/lap lighter.
  const cars = [0, 1, 2, 3].map((i) => ({
    carIndex: i,
    lapHistory: [2, 3, 4, 5, 6].map((n) => ({ lapNum: n, lapMs: 90000 + i * 300 + 120 * n - 40 * n + (n === 4 && i === 2 ? 3000 : 0), compound: 16, tyreAge: n, pit: false, neutralised: false })),
  }));
  const m = fitDegradation(cars, 40 / 30); // burn chosen so the fuel effect is 40 ms/lap
  assert.ok(Math.abs(m.compounds[16].degMsPerLap - 120) <= 2, `deg ${m.compounds[16].degMsPerLap}`);
  const pay = stopPayback({ degMsPerLap: 120, tyreAge: 15, pitLossMs: 18000, lapsLeft: 20 });
  assert.deepStrictEqual(pay, { gainPerLapMs: 1800, paybackLaps: 10, worthIt: true });
});

test('logistic regression: learns a clear signal, and the metrics are sane', () => {
  const X = [];
  const y = [];
  for (let i = 0; i < 400; i++) {
    const gap = (i % 40) / 10; // 0..3.9 s
    X.push([gap]);
    y.push(gap < 0.6 && i % 3 !== 0 ? 1 : 0);
  }
  const m = train(X, y, { epochs: 400 });
  assert.ok(predict(m, [0.2]) > predict(m, [3]), 'closer = more likely');
  const ev = evaluate(X.map((x) => predict(m, x)), y);
  assert.ok(ev.auc > 0.9, `auc ${ev.auc}`);
  assert.strictEqual(auc([0.1, 0.9], [0, 1]), 1);
  assert.strictEqual(auc([0.9, 0.1], [0, 1]), 0);
});

const { forecastAttack } = require('../src/analysis/attackForecast');

test('attack forecast: when (closing rate) and where (passing spots, your own losses first)', () => {
  const corners = [{ corner: 1, startM: 700 }, { corner: 2, startM: 2800 }, { corner: 3, startM: 5300 }];
  const car = (splits) => ({ miniSectors: [{ lapNum: 3, splits }] });
  const even = Array(25).fill(3700);
  const base = { attacker: car(even), defender: car(even), corners, trackLength: 5800 };

  // Approaching from 2.0s at 0.5s/lap: in range in ~2 laps. The field passes
  // mostly into corner 2.
  const f = forecastAttack({ ...base, gapS: 2.0, closingSPerLap: 0.5, passesAtM: [2900, 2950, 3000, 800] });
  assert.deepStrictEqual(f.when, { laps: 2, text: 'in ~2 laps' });
  assert.strictEqual(f.where.corner, 2);

  // But this driver keeps losing places into corner 3: that outweighs the field.
  const mine = forecastAttack({ ...base, gapS: 0.6, closingSPerLap: 0, passesAtM: [2900, 2950, 3000, 800], personalPassesAtM: [5400, 5450] });
  assert.strictEqual(mine.when.text, 'now');
  assert.strictEqual(mine.where.corner, 3);
  assert.match(mine.where.why.join(' '), /you've been passed there 2 times/);

  // Not closing and out of range: no forecast at all.
  assert.strictEqual(forecastAttack({ ...base, gapS: 3, closingSPerLap: -0.2, passesAtM: [2900] }), null);

  // Between two equally busy corners, the one the chaser gains into wins.
  const quickerInto3 = even.map((v, k) => (k >= 19 && k <= 22 ? v - 100 : v));
  const tie = forecastAttack({ ...base, attacker: car(quickerInto3), gapS: 0.8, closingSPerLap: 0, passesAtM: [2900, 5400] });
  assert.strictEqual(tie.where.corner, 3);
});

const { strategyOptions } = require('../src/analysis/strategyOptions');
const { battleCall } = require('../src/analysis/battleCall');
const { createLapDeltaTracker } = require('../src/state/lapDelta');

const set = (visual, { wear = 0, life, fitted = false, delta = 0, available = true } = {}) => ({ visualTyreCompound: visual, wear, available, lifeSpan: life, usableLife: life, lapDeltaTimeMs: delta, fitted });

test('strategy options: a free tyre change under a red flag takes the faster set that lasts', () => {
  const player = { status: { visualTyreCompound: 17, tyresAgeLaps: 2 }, lapData: { carPosition: 7 } };
  const o = strategyOptions({
    situation: 'Red flag', lapsLeft: 12, player, rejoin: null, stopLossMs: 19000, normalLossMs: 19000,
    tyreSets: [set(17, { life: 19, fitted: true }), set(16, { life: 13, delta: -736 }), set(18, { life: 25, delta: 736 }), set(7, { life: 38, delta: 3000 })],
  });
  assert.deepStrictEqual(o.options.map((x) => x.id), ['stay', 'box-16', 'box-18']); // no inters in the dry
  assert.strictEqual(o.recommendedId, 'box-16');
  assert.strictEqual(o.options.find((x) => x.id === 'box-16').position, 7); // free: keeps the place
  assert.match(o.headline, /^Red flag: best is box: soft - keep P7, lasts to the flag, 0\.7s\/lap faster/);
});

test('strategy options: under a safety car, losing 15 places to stop is worse than staying out', () => {
  const player = { status: { visualTyreCompound: 17, tyresAgeLaps: 2 }, lapData: { carPosition: 3 } };
  const o = strategyOptions({
    situation: 'Safety car', lapsLeft: 12, player, rejoin: { position: 18 }, stopLossMs: 10000, normalLossMs: 19000,
    tyreSets: [set(17, { life: 18, fitted: true }), set(16, { life: 13, delta: -800 })],
  });
  assert.strictEqual(o.recommendedId, 'stay');
  assert.strictEqual(o.options.find((x) => x.id === 'box-16').positionsLost, 15);
});

test('battle call: attack, defend, the sandwich, close in, clear', () => {
  const row = (name, trend = 0, extra = {}) => ({ name, gapTrendMsPerLap: trend, pitStatus: 0, ...extra });
  const med = (p) => ({ p, level: p >= 0.25 ? 'high' : p >= 0.1 ? 'medium' : 'low' });
  assert.strictEqual(battleCall({ ahead: row('NORRIS'), gapAheadS: 0.6, battle: { attack: med(0.15) }, batteryPct: 70 }).mode, 'ATTACK');
  assert.strictEqual(battleCall({ ahead: row('NORRIS'), gapAheadS: 0.6, battle: { attack: med(0.15) }, batteryPct: 10 }).mode, 'HOLD', 'no battery, no attack');
  assert.strictEqual(battleCall({ behind: row('SAINZ', -300), gapBehindS: 0.7, battle: {} }).mode, 'DEFEND');
  // Sandwiched, bigger threat behind: defend first.
  const both = battleCall({ ahead: row('NORRIS'), behind: row('SAINZ', 0, { overtakeAvailable: true }), gapAheadS: 0.5, gapBehindS: 0.4, battle: { attack: med(0.1), defend: med(0.3) }, batteryPct: 80 });
  assert.deepStrictEqual([both.mode, both.target], ['DEFEND', 'SAINZ']);
  assert.strictEqual(battleCall({ ahead: row('NORRIS', -400), gapAheadS: 1.8, battle: { attackForecast: { when: { laps: 2, text: 'in ~2 laps' } } } }).mode, 'CLOSE IN');
  assert.strictEqual(battleCall({ ahead: row('NORRIS'), gapAheadS: 4, behind: row('SAINZ'), gapBehindS: 5, battle: {} }).mode, 'CLEAR');
  assert.strictEqual(battleCall({ ahead: row('NORRIS'), gapAheadS: 0.5, battle: {}, neutralised: true }), null);
  // On the gearbox with no trend yet and a low model chance: still a fight, never HOLD.
  const tight = battleCall({ behind: row('SAINZ', null), gapBehindS: 0.4, battle: { defend: med(0.05) } });
  assert.deepStrictEqual([tight.mode, tight.reason], ['DEFEND', '0.4s behind']);
  assert.match(battleCall({ ahead: row('NORRIS'), gapAheadS: 1.5, behind: row('SAINZ'), gapBehindS: 1.4, battle: {} }).reason, /1\.5s to NORRIS, 1\.4s to SAINZ/);
});

test('lap delta: to best and to last lap, and live mini-sectors rated', () => {
  const t = createLapDeltaTracker();
  const L = 2500;
  const drive = (lapNum, lapMs, slowFactor = 1) => {
    for (let d = 0; d <= L; d += 10) t.update({ currentLapNum: lapNum, lapDistance: d, currentLapTimeInMS: (d / L) * lapMs * slowFactor, pitStatus: 0, currentLapInvalid: 0, lastLapTimeInMS: 0 }, L);
  };
  drive(1, 60000);
  t.update({ currentLapNum: 2, lapDistance: 0, currentLapTimeInMS: 0, pitStatus: 0, lastLapTimeInMS: 60000 }, L);
  drive(2, 62000);
  t.update({ currentLapNum: 3, lapDistance: 0, currentLapTimeInMS: 0, pitStatus: 0, lastLapTimeInMS: 62000 }, L);
  // Lap 3, halfway, 0.5s up on the best lap's pace.
  const now = t.current({ currentLapNum: 3, lapDistance: 1250, currentLapTimeInMS: 29500, pitStatus: 0 });
  assert.strictEqual(now.bestLapTimeInMS, 60000);
  assert.strictEqual(now.previousLapTimeInMS, 62000);
  assert.strictEqual(now.deltaToBestMs, -500);
  assert.strictEqual(now.deltaToLastMs, -1500);
  assert.strictEqual(now.miniSectors.length, 25);
  assert.strictEqual(now.miniSectors[12].state, 'current');
});

test('overtake features: the same inputs live and in training', () => {
  const car = (pos, gapMs, extra = {}) => ({
    lapData: { carPosition: pos, deltaToCarInFrontInMS: gapMs, pitStatus: 0, currentLapNum: 5 },
    status: { tyresAgeLaps: extra.age || 10, visualTyreCompound: extra.compound || 17, ersStoreEnergy: extra.ers || 2e6 },
    lapHistory: [],
    gapAheadHistory: [{ t: 0, gapMs: gapMs + 500 }, { t: 5, gapMs }],
    telemetry2: { overtakeAvailable: !!extra.ot },
  });
  const f = pairFeatures(car(5, 400, { age: 3, compound: 16, ers: 3e6, ot: true }), car(4, 0));
  assert.deepStrictEqual(FEATURES.filter((k) => !(k in f)), []);
  assert.strictEqual(f.within05, 1);
  assert.strictEqual(f.softerTyre, 1);
  assert.strictEqual(f.tyreAgeDelta, 7);
  assert.strictEqual(f.overtakeMode, 1);
  assert.ok(Math.abs(f.closingSPerS - 0.1) < 1e-9); // 0.5 s closed over 5 s
  assert.strictEqual(pairFeatures(car(5, 0), car(4, 0)), null, 'no interval yet = no battle');
});

const { projectBattery } = require('../src/analysis/batteryProjection');

test('battery projection: the rest of this lap follows the same stretch of the last one', () => {
  const L = 5000;
  // Last lap (2): started at 3.0 MJ, dipped to 1.0 MJ by half-distance
  // (the long straight), recharged to 2.6 MJ at the line.
  const bins = Array.from({ length: 20 }, (_, k) => (k < 10 ? 3.0e6 - k * 0.2e6 : 1.0e6 + (k - 10) * 0.16e6));
  const prev = { lapNum: 2, binsJ: bins, lineJ: 2.6e6, unusual: false };
  const car = (lapDistance, nowJ, ersPrevLap = prev) => ({ status: { ersStoreEnergy: nowJ }, lapData: { currentLapNum: 3, lapDistance, pitStatus: 0 }, ersPrevLap });
  // Half-way on 0.8 MJ (20%): last lap gained 1.6 MJ from here -> 2.4 MJ (60%).
  assert.deepStrictEqual(projectBattery(car(L / 2, 0.8e6), L), { nowPct: 20, atLinePct: 60, trendPctPerLap: -10, basis: 'last lap' });
  // Clamped to a full store.
  assert.strictEqual(projectBattery(car(L / 2, 3.5e6), L).atLinePct, 100);
  // Last lap was a pit / safety-car lap, or isn't the previous lap: current value only.
  assert.strictEqual(projectBattery(car(L / 2, 0.8e6, { ...prev, unusual: true }), L).atLinePct, 20);
  assert.strictEqual(projectBattery(car(L / 2, 0.8e6, { ...prev, lapNum: 1 }), L).basis, 'current');
  // In the pits: nothing to project.
  assert.strictEqual(projectBattery({ ...car(0, 2e6), lapData: { pitStatus: 1 } }, L), null);
});

const { pitTiming } = require('../src/analysis/pitTiming');

test('pit timing: waits for the tyres to wear, then boxes; a set that cannot reach the flag costs a stop', () => {
  // You lead by 30s on worn tyres; nobody close. New set 1.0s/lap quicker.
  const me = { t: 0, position: 1, tyreAge: 10, compound: 17, degMs: 100, lifeLeft: null, stopped: false };
  const rivals = [{ name: 'B', position: 2, t: 30000, paceDeltaMs: 0, degMs: 100, age: 10, stopIn: 9 }];
  const sets = [{ compound: 18, gainMs: 1000, degMs: 100, life: 40 }];
  const r = pitTiming({ me, sets, rivals, laps: 20, pitLossMs: 20000 });
  // Each lap later swaps the last lap on the new set (worn by then) for one
  // more on the old set: worth it until the old lap is the slower one, at +4.
  assert.strictEqual(r.bestId, 'box-4');
  assert.deepStrictEqual(r.options.map((o) => o.id), ['box-0', 'box-1', 'box-2', 'box-4']);
  assert.strictEqual(r.options[0].rejoinPosition, 1);
  assert.strictEqual(r.options[0].finishPosition, 1);
  assert.ok(r.marginS > 0);
  assert.match(r.headline, /^Best: box in 4 laps onto hards - finish ~P1, 0\.4s better than box in 2 laps$/);

  // A near-tie keeps the last pick (no flicker); a clearly better lap replaces it.
  assert.strictEqual(pitTiming({ me, sets, rivals, laps: 20, pitLossMs: 20000, prefer: 3 }).bestId, 'box-3');
  assert.strictEqual(pitTiming({ me, sets, rivals, laps: 20, pitLossMs: 20000, prefer: 0 }).bestId, 'box-4');

  // The only set left lasts 5 laps: boxing early means a second stop, so later is better.
  const short = pitTiming({ me, sets: [{ ...sets[0], life: 5 }], rivals, laps: 20, pitLossMs: 20000 });
  assert.ok(short.bestInLaps >= 14, `boxed at +${short.bestInLaps}`);
});

test('pit timing: rejoining behind a train costs track position; staying out is only offered after a stop', () => {
  const rivals = [2000, 4000, 6000, 8000].map((t, i) => ({ name: `R${i}`, position: i + 2, t, paceDeltaMs: 0, degMs: 0, age: 5, stopIn: null }));
  const me = { t: 0, position: 1, tyreAge: 5, compound: 17, degMs: 50, lifeLeft: null, stopped: true };
  const r = pitTiming({ me, sets: [{ compound: 16, gainMs: 300, degMs: 50, life: 30 }], rivals, laps: 10, pitLossMs: 20000 });
  assert.strictEqual(r.bestId, 'stay');
  assert.strictEqual(r.options.find((o) => o.id === 'box-0').rejoinPosition, 5);
  assert.strictEqual(pitTiming({ me: { ...me, stopped: false }, sets: [{ compound: 16, gainMs: 300, degMs: 50, life: 30 }], rivals, laps: 10, pitLossMs: 20000 }).options.some((o) => o.id === 'stay'), false);
  assert.strictEqual(pitTiming({ me, sets: [], rivals, laps: 10, pitLossMs: 20000 }), null);
  assert.strictEqual(pitTiming({ me, sets: [{ compound: 16, gainMs: 300, degMs: 50, life: 30 }], rivals, laps: 1, pitLossMs: 20000 }), null);
});

test('pit timing: a rival due to stop is not a car you rejoin behind for good', () => {
  // A leads by 10s; B is 5s behind you. A stop costs 20s.
  const me = { t: 10000, position: 2, compound: 17, degMs: 100, lifeLeft: null, stopped: false };
  const sets = [{ compound: 18, gainMs: 1000, degMs: 100, life: 40 }];
  const run = (bStopIn) => pitTiming({ me, sets, rivals: [
    { name: 'A', position: 1, t: 0, paceDeltaMs: 0, degMs: 100, age: 10, stopIn: null },
    { name: 'B', position: 3, t: 15000, paceDeltaMs: 0, degMs: 100, age: 10, stopIn: bStopIn },
  ], laps: 20, pitLossMs: 20000 });
  // B staying out: boxing now drops you behind it.
  assert.strictEqual(run(null).options.find((o) => o.id === 'box-0').rejoinPosition, 3);
  // B boxing this lap too: you come out still ahead of it.
  const both = run(0);
  assert.strictEqual(both.options.find((o) => o.id === 'box-0').rejoinPosition, 2);
  assert.deepStrictEqual(both.stops, [{ name: 'B', position: 3, inLaps: 0 }]);
});

const { expectedStopIn, learned } = require('../src/analysis/rivalStops');

test('rival stops: owed stops at a share of the rated tyre life, never after the second-last lap', () => {
  // Medium rated 20 laps, 5 laps old, 20 laps left: due at 0.6 x 20 = 12 laps old.
  assert.strictEqual(expectedStopIn({ compound: 17, age: 5, usableLife: 20, owesStop: true, lapsLeft: 20 }), 7);
  // Due now.
  assert.strictEqual(expectedStopIn({ compound: 17, age: 12, usableLife: 20, owesStop: true, lapsLeft: 20 }), 0);
  // Running long past it: at the end of the set's rated life, not "this lap" every lap...
  assert.strictEqual(expectedStopIn({ compound: 17, age: 15, usableLife: 20, owesStop: true, lapsLeft: 20 }), 5);
  // ...and past that, the last chance.
  assert.strictEqual(expectedStopIn({ compound: 17, age: 22, usableLife: 20, owesStop: true, lapsLeft: 20 }), 18);
  // Late in the race it still has to stop - by the end of the second-last lap.
  assert.strictEqual(expectedStopIn({ compound: 18, age: 2, usableLife: 25, owesStop: true, lapsLeft: 5 }), 3);
  // This race's own stops override the prior.
  assert.strictEqual(expectedStopIn({ compound: 17, age: 5, usableLife: 20, owesStop: true, lapsLeft: 20, stopShare: 0.8 }), 11);
  // Already stopped: only again if the set can't reach the flag.
  assert.strictEqual(expectedStopIn({ compound: 18, age: 5, usableLife: 25, owesStop: false, lapsLeft: 15 }), null);
  assert.strictEqual(expectedStopIn({ compound: 16, age: 5, usableLife: 15, owesStop: false, lapsLeft: 15 }), 10);
  // No Tyre Sets packet yet: the compound's typical rated life.
  assert.strictEqual(expectedStopIn({ compound: 16, age: 3, usableLife: null, owesStop: true, lapsLeft: 30 }), 6);
  assert.strictEqual(learned([0.6]), null);
  assert.strictEqual(learned([0.5, 0.7, 0.6]), 0.6);
});

test('rival stops: once the stop wear is known, each car is timed by its own wear rate', () => {
  const base = { compound: 17, usableLife: 20, owesStop: true, lapsLeft: 25, stopWear: 36 };
  // 3% a lap, 18% at 6 laps old: 36% at 12 - the same as the age rule.
  assert.strictEqual(expectedStopIn({ ...base, age: 6, wear: 18 }), 6);
  // Eating its tyres (4.5% a lap): 36% at 8 laps old, well before 0.6 x 20.
  assert.strictEqual(expectedStopIn({ ...base, age: 6, wear: 27 }), 2);
  // Past it already: the running-long rule, not "this lap" every lap.
  assert.strictEqual(expectedStopIn({ ...base, age: 10, wear: 40 }), 10);
  // A set 1 lap old has no steady rate yet: the age rule.
  assert.strictEqual(expectedStopIn({ ...base, age: 1, wear: 8 }), 11);
  // A used set that went on at 12%: 18% at 6 laps is 1% a lap, not 3% - due much later.
  assert.strictEqual(expectedStopIn({ ...base, age: 6, wear: 18, startWear: 12 }), 18);
});

const { damageLoss } = require('../src/analysis/damageLoss');

test('damage loss: mini-sectors after the hit against clean laps before it, projected and set against a new nose', () => {
  const lap = (extra = {}) => Array.from({ length: 25 }, (_, k) => 3000 + (extra[k] || 0));
  const corners = [{ corner: 1, startM: 300 }, { corner: 2, startM: 1100 }, { corner: 3, startM: 2900 }];
  const base = { baseline: [lap(), lap(), lap()], corners, trackLength: 5000, pitLossMs: 20000, fixable: true };
  // Slices 5 and 6 (1.0-1.4 km) lose 0.2s each: 0.4s a lap, at corner 2.
  const r = damageLoss({ ...base, damaged: [lap({ 5: 200, 6: 200 })], lapsLeft: 10 });
  assert.strictEqual(r.lossPerLapMs, 400);
  assert.strictEqual(r.basis, 'laps');
  assert.deepStrictEqual(r.where, [2]);
  assert.strictEqual(r.toFlagMs, 4000);
  assert.deepStrictEqual(r.fix, { costMs: 26000, savedMs: 3600, stopAnyway: false, pays: false });
  // Fuel burnt since makes the car quicker anyway: that drift is part of the loss.
  assert.strictEqual(damageLoss({ ...base, damaged: [lap({ 5: 200, 6: 200 })], driftMs: -300, lapsLeft: 10 }).lossPerLapMs, 700);
  // 3s a lap with 15 to go: a new nose pays - and costs only the change if you stop anyway.
  const big = damageLoss({ ...base, damaged: [lap({ 3: 1500, 4: 1500 })], lapsLeft: 15 });
  assert.strictEqual(big.fix.pays, true);
  assert.strictEqual(damageLoss({ ...base, damaged: [lap({ 3: 1500, 4: 1500 })], lapsLeft: 15, stopAnyway: true }).fix.costMs, 6000);
  // Part of a lap since the hit: the slices run so far, scaled up to a whole lap.
  const splits = lap({ 10: 100, 11: 100, 12: 100, 13: 100, 14: 100, 15: 100, 16: 100 }).map((v, k) => (k >= 10 && k <= 16 ? v : null));
  const early = damageLoss({ ...base, damaged: [], partial: { splits, fromSector: 10 }, lapsLeft: 10 });
  assert.strictEqual(early.basis, 'partial');
  assert.strictEqual(early.lossPerLapMs, 2500); // 0.7s over 7 of 25 slices
  assert.strictEqual(damageLoss({ ...base, damaged: [], partial: { splits: splits.map((v, k) => (k <= 12 ? v : null)), fromSector: 10 } }).basis, 'measuring');
  // Nothing clean before the hit to compare with.
  assert.strictEqual(damageLoss({ ...base, baseline: [], damaged: [lap()] }), null);
});


test('tyre model: one slow lap at a young tyre age does not flip the slope', () => {
  // Five cars, 0.1s/lap of wear on hards - and every car's first lap on the
  // set ran half behind the safety car (115s) with nothing flagging it.
  const cars = Array.from({ length: 5 }, (_, c) => ({
    carIndex: c,
    lapHistory: Array.from({ length: 8 }, (_, k) => ({ lapNum: 7 + k, compound: 18, tyreAge: 1 + k, pit: false, neutralised: false, lapMs: k === 0 ? 115000 : 78000 + 100 * k })),
  }));
  const deg = fitDegradation(cars, 0).compounds[18].degMsPerLap;
  assert.ok(deg > 80 && deg < 120, `deg ${deg}`);
});

test('damage loss: a new nose only gets back the wing\'s share of the loss', () => {
  const lap = (extra = {}) => Array.from({ length: 25 }, (_, k) => 3000 + (extra[k] || 0));
  const r = damageLoss({ baseline: [lap()], damaged: [lap({ 3: 600, 4: 600 })], trackLength: 5000, lapsLeft: 21, pitLossMs: 20000, fixable: true, fixableShare: 0.2 });
  // 1.2s a lap, but the wing is a fifth of it: 0.24s x 20 laps = 4.8s back for ~26s.
  assert.strictEqual(r.fix.savedMs, 4800);
  assert.strictEqual(r.fix.pays, false);
});

const { createTyreTempTracker } = require('../src/analysis/tyreTemps');

test('tyre temps: hotter than this stint started, colder than racing laps - stretch for stretch', () => {
  const tr = createTyreTempTracker();
  const L = 5000;
  // Surface follows the track (hot after slow corners), +rearExtra on the rears.
  const temp = (d, rearExtra = 0) => 70 + 20 * Math.sin((d / L) * 2 * Math.PI);
  let out = null;
  const lap = (lapNum, age, { rearExtra = 0, green = true, all = 0 } = {}) => {
    for (let k = 0; k < 200; k++) {
      const d = (k / 200) * L;
      const f = temp(d) + all;
      const r = temp(d) + rearExtra + all;
      out = tr.update({
        telemetry: { speed: 200, tyresSurfaceTemperature: [r, r, f, f] },
        lapData: { currentLapNum: lapNum, lapDistance: d },
        status: { visualTyreCompound: 17, tyresAgeLaps: age },
      }, green, L);
    }
  };
  for (let n = 1; n <= 7; n++) lap(n, n);
  // The same temperatures all stint: nothing, though the window passes hot and cold stretches.
  assert.deepStrictEqual(out, { coldByC: null, hot: null });
  lap(8, 8, { rearExtra: 10 });
  assert.deepStrictEqual(out.hot, { axle: 'rear', byC: 10 });
  // Behind the safety car, 15 degrees down everywhere.
  lap(9, 9, { green: false, all: -15 });
  assert.strictEqual(out.coldByC, 15);
  assert.strictEqual(out.hot, null);
});

const { racePlan, planText } = require('../src/analysis/racePlan');

test('race plan: one stop or two from the sets, the pit loss and the wear', () => {
  const set = (index, c, life, deltaMs, wear = 0) => ({ index, visualTyreCompound: c, usableLife: life, lifeSpan: life, lapDeltaTimeMs: deltaMs, wear, available: true });
  const sets = [set(0, 16, 15, -600), set(1, 16, 15, -600), set(2, 17, 20, 0), set(3, 18, 25, 400)];
  // A dear stop: one, softs then mediums, inside each set's rated life.
  const p = racePlan({ totalLaps: 30, pitLossMs: 20000, sets });
  assert.strictEqual(planText(p.best), '1 stop: Soft 14 laps, Medium 16 - box end of lap 14');
  assert.strictEqual(p.other.stops, 2);
  assert.ok(p.other.slowerMs > 0);
  // Cheap stops and softs that fall away: two stops wins.
  const two = racePlan({ totalLaps: 30, pitLossMs: 5000, sets, deg: { 16: 400, 17: 300, 18: 250 } });
  assert.strictEqual(two.best.stops, 2);
  // Never one compound only, never a set past its life: 30 laps on two softs can't be done.
  assert.strictEqual(racePlan({ totalLaps: 40, pitLossMs: 20000, sets: [set(0, 16, 15, 0), set(1, 16, 15, 0)] }), null);
});
