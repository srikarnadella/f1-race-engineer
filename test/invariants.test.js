const test = require('node:test');
const assert = require('node:assert');
const { rng, gauss, int } = require('./helpers/rng');
const { predictRejoin } = require('../src/state/raceAnalysis');
const { expectedStopIn } = require('../src/analysis/rivalStops');
const { fitDegradation, stopPayback, holdOutScore } = require('../src/ml/tyreModel');
const { auc, evaluate } = require('../src/ml/logistic');

// Properties that must hold for any input, each checked on a few hundred
// seeded random cases rather than one hand-picked example.
const CASES = 300;

// A running order: the leader, then cars at growing gaps (some pairs nose to tail).
function randomField(r) {
  const n = int(r, 2, 22);
  let gap = 0;
  return Array.from({ length: n }, (_, i) => {
    if (i) gap += r() < 0.2 ? 1 + int(r, 0, 300) : int(r, 300, 6000);
    return { carIndex: i, lapData: { carPosition: i + 1, deltaToRaceLeaderInMS: gap, pitStatus: 0, resultStatus: 2 }, status: { visualTyreCompound: 17, tyresAgeLaps: int(r, 0, 30) } };
  });
}

test('rejoin: inside the field, never better with a longer stop, gaps never negative', () => {
  const r = rng(1);
  for (let c = 0; c < CASES; c++) {
    const field = randomField(r);
    const player = field[int(r, 0, field.length - 1)];
    let prev = 0;
    for (const loss of [0, 5000, 15000, 22000, 30000, 60000, 200000]) {
      const p = predictRejoin(field, player, loss);
      assert.ok(p, `case ${c}: a full field with known gaps has a prediction`);
      assert.ok(p.position >= 1 && p.position <= field.length, `case ${c}: P${p.position} of ${field.length}`);
      assert.ok(p.position >= prev, `case ${c}: ${loss} ms of pit loss rejoins ahead of a shorter stop`);
      assert.strictEqual(p.positionsLost, p.position - player.lapData.carPosition);
      if (p.ahead) assert.ok(p.ahead.gapMs >= 0);
      if (p.behind) assert.ok(p.behind.gapMs >= 0);
      prev = p.position;
    }
  }
});

test('rejoin: a free stop loses no places', () => {
  const r = rng(2);
  for (let c = 0; c < CASES; c++) {
    const field = randomField(r);
    const player = field[int(r, 0, field.length - 1)];
    assert.strictEqual(predictRejoin(field, player, 0).positionsLost, 0, `case ${c}`);
  }
});

test('rival stops: never negative, never on the last lap, and a car owing its stop always gets one', () => {
  const r = rng(3);
  for (let c = 0; c < CASES * 3; c++) {
    const lapsLeft = int(r, 1, 60);
    const life = int(r, 8, 35);
    const startWear = r() < 0.3 ? int(r, 1, 20) : 0;
    const age = int(r, 0, 45);
    const args = {
      compound: [16, 17, 18][int(r, 0, 2)],
      age,
      usableLife: r() < 0.8 ? life : null,
      owesStop: r() < 0.6,
      lapsLeft,
      stopShare: r() < 0.5 ? 0.3 + r() * 0.6 : null,
      wear: startWear + age * (0.5 + r() * 4),
      startWear,
      stopWear: r() < 0.5 ? 20 + r() * 50 : null,
    };
    const k = expectedStopIn(args);
    const lapsAfterThis = Math.ceil(lapsLeft) - 1;
    const label = `case ${c}: ${JSON.stringify(args)} -> ${k}`;
    if (k !== null) {
      assert.ok(Number.isInteger(k) && k >= 0, label);
      assert.ok(k <= lapsAfterThis - 1, `${label}: a stop on the last lap`);
    }
    if (args.owesStop && lapsAfterThis >= 1) assert.notStrictEqual(k, null, `${label}: owes a stop but none expected`);
  }
});

test('rival stops: more worn tyres never mean a later stop', () => {
  const r = rng(4);
  for (let c = 0; c < CASES; c++) {
    const base = { compound: 17, age: int(r, 2, 20), usableLife: 25, owesStop: true, lapsLeft: 40, startWear: 0, stopWear: 40 };
    const w = 1 + r() * 30;
    const a = expectedStopIn({ ...base, wear: w });
    const b = expectedStopIn({ ...base, wear: w + 1 + r() * 10 });
    assert.ok(b <= a, `case ${c}: ${w.toFixed(1)}% wear stops in ${a}, more wear in ${b}`);
  }
});

// A field whose lap times are generated from a known wear slope.
function syntheticField(r, { degMs, cars = 12, laps = 18, noiseMs = 150, burnKg = 1.6, slowLapRate = 0.05 }) {
  return Array.from({ length: cars }, (_, i) => {
    const base = 80000 + gauss(r, 800);
    const startAge = int(r, 0, 6);
    return {
      carIndex: i,
      lapHistory: Array.from({ length: laps }, (_, k) => {
        const lapNum = k + 2;
        const tyreAge = startAge + k;
        let lapMs = base + degMs * tyreAge - burnKg * 30 * lapNum + gauss(r, noiseMs);
        if (r() < slowLapRate) lapMs += 4000 + r() * 20000; // a spin or traffic
        return { lapNum, lapMs: Math.round(lapMs), compound: 17, tyreAge };
      }),
    };
  });
}

test('tyre model: recovers a known wear slope through noise, spins and car-to-car pace', () => {
  const r = rng(5);
  const errors = [];
  for (let c = 0; c < 60; c++) {
    const degMs = 20 + r() * 200;
    const fit = fitDegradation(syntheticField(r, { degMs }), 1.6).compounds[17];
    assert.ok(fit, `case ${c}: no fit`);
    errors.push(Math.abs(fit.degMsPerLap - degMs));
  }
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  assert.ok(mean < 12, `mean error ${mean.toFixed(1)} ms/lap`);
  assert.ok(Math.max(...errors) < 40, `worst error ${Math.max(...errors).toFixed(1)} ms/lap`);
});

// Known weakness, kept as the spec: an iterated trim passes this but predicted
// held-out cars worse on a real race (src/ml/tyreModel.js).
test('tyre model: traffic laps too small for the slow-lap filter, late in the stint, do not tilt the slope', { todo: 'one trim pass; see tyreModel.js' }, () => {
  // Stuck behind a slower car near the end of a stint: 1-3 s slow, under the
  // 7% spin filter. Left in, they read as tyre wear.
  const r = rng(11);
  for (let c = 0; c < 30; c++) {
    const degMs = 40 + r() * 100;
    const field = syntheticField(r, { degMs, noiseMs: 80, slowLapRate: 0 });
    for (const car of field) for (const l of car.lapHistory.slice(-6)) if (r() < 0.35) l.lapMs += 1000 + r() * 2000;
    const fit = fitDegradation(field).compounds[17].degMsPerLap;
    assert.ok(Math.abs(fit - degMs) < 25, `case ${c}: true ${degMs.toFixed(0)} ms/lap, fitted ${fit}`);
  }
});

test('tyre model: a car with only two laps on the compound (just switched) does not change the fit', () => {
  // Too few laps to fit, so it is left out - and must not shift which laps the trim drops.
  const r = rng(12);
  for (let c = 0; c < 20; c++) {
    const field = syntheticField(r, { degMs: 90, noiseMs: 80, slowLapRate: 0 });
    for (const car of field) for (const l of car.lapHistory.slice(-6)) if (r() < 0.35) l.lapMs += 1000 + r() * 2000;
    const without = fitDegradation(field).compounds[17].degMsPerLap;
    const switched = { carIndex: 99, lapHistory: [{ lapNum: 18, lapMs: 81000, compound: 17, tyreAge: 0 }, { lapNum: 19, lapMs: 81100, compound: 17, tyreAge: 1 }] };
    assert.strictEqual(fitDegradation([switched, ...field]).compounds[17].degMsPerLap, without, `case ${c}`);
  }
});

test('stop payback: a stop that only pays back exactly at the flag is not worth it', () => {
  // 20 s lost, 100 ms x 20 laps = 2 s a lap back: even after 10 laps.
  assert.strictEqual(stopPayback({ degMsPerLap: 100, tyreAge: 20, pitLossMs: 20000, lapsLeft: 10 }).worthIt, false);
  assert.strictEqual(stopPayback({ degMsPerLap: 100, tyreAge: 20, pitLossMs: 20000, lapsLeft: 11 }).worthIt, true);
});

test('tyre model: a car being a second a lap faster does not change the slope', () => {
  const field = syntheticField(rng(6), { degMs: 80, noiseMs: 0, slowLapRate: 0 });
  const before = fitDegradation(field).compounds[17].degMsPerLap;
  for (const l of field[0].lapHistory) l.lapMs -= 1000;
  assert.strictEqual(fitDegradation(field).compounds[17].degMsPerLap, before);
});

test('tyre model: too few cars or laps is no fit, not a guess', () => {
  const r = rng(7);
  assert.strictEqual(fitDegradation(syntheticField(r, { degMs: 80, cars: 2 })).compounds[17], undefined);
  assert.strictEqual(fitDegradation(syntheticField(r, { degMs: 80, laps: 2 })).compounds[17], undefined);
});

test('tyre model backtest: each car predicted from the others beats "no tyre wear" when tyres do wear', () => {
  const worn = holdOutScore(syntheticField(rng(13), { degMs: 120, noiseMs: 100, slowLapRate: 0 }));
  assert.ok(worn.laps > 150 && worn.cars === 12);
  assert.ok(worn.model.medianMs < worn.naive.medianMs / 3, JSON.stringify(worn));
  assert.ok(Math.abs(worn.model.medianMs - 100 * 0.6745) < 25, 'noise-level error: the median |N(0, 100)| is 67 ms');
  // No wear at all: the model has nothing to add, and must not do worse than the baseline by much.
  const flat = holdOutScore(syntheticField(rng(14), { degMs: 0, noiseMs: 100, slowLapRate: 0 }));
  assert.ok(flat.model.medianMs < flat.naive.medianMs * 1.1, JSON.stringify(flat));
});

test('stop payback: older tyres, more wear and a cheaper stop all pay back sooner', () => {
  const r = rng(8);
  for (let c = 0; c < CASES; c++) {
    const base = { degMsPerLap: 10 + r() * 200, tyreAge: int(r, 1, 30), pitLossMs: 15000 + r() * 15000, lapsLeft: int(r, 1, 50) };
    const p = stopPayback(base).paybackLaps;
    assert.ok(stopPayback({ ...base, tyreAge: base.tyreAge + 3 }).paybackLaps <= p);
    assert.ok(stopPayback({ ...base, degMsPerLap: base.degMsPerLap * 1.5 }).paybackLaps <= p);
    assert.ok(stopPayback({ ...base, pitLossMs: base.pitLossMs * 0.7 }).paybackLaps <= p);
    assert.strictEqual(stopPayback(base).worthIt, base.pitLossMs / (base.degMsPerLap * base.tyreAge) < base.lapsLeft);
  }
  assert.strictEqual(stopPayback({ degMsPerLap: 0, tyreAge: 5, pitLossMs: 20000, lapsLeft: 10 }), null);
});

test('AUC: rank-only - any increasing rescale gives the same AUC; flipping labels gives 1 - AUC', () => {
  const r = rng(9);
  for (let c = 0; c < CASES; c++) {
    const n = int(r, 4, 200);
    const y = Array.from({ length: n }, () => (r() < 0.3 ? 1 : 0));
    if (!y.includes(1) || !y.includes(0)) continue;
    // Rounded so ties happen.
    const s = y.map((yi) => Math.round((r() + yi * r()) * 20) / 20);
    const a = auc(s, y);
    assert.ok(a >= 0 && a <= 1);
    assert.ok(Math.abs(auc(s.map((v) => Math.exp(3 * v) - 7), y) - a) < 1e-12);
    assert.ok(Math.abs(auc(s, y.map((v) => 1 - v)) - (1 - a)) < 1e-12);
  }
  assert.strictEqual(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.strictEqual(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5);
  assert.strictEqual(auc([0.1, 0.2], [1, 1]), null);
});

test('evaluate: Brier and log loss reward the truth; the calibration buckets hold every sample', () => {
  const r = rng(10);
  const y = Array.from({ length: 500 }, () => (r() < 0.2 ? 1 : 0));
  const truth = evaluate(y.map((v) => (v ? 0.95 : 0.05)), y);
  const coin = evaluate(y.map(() => 0.5), y);
  const base = evaluate(y.map(() => truth.baseRate), y);
  assert.ok(truth.brier < base.brier && base.brier < coin.brier);
  assert.ok(truth.logLoss < coin.logLoss);
  assert.ok(Math.abs(base.brierSkill) < 1e-3, 'the base rate has no skill over itself');
  assert.strictEqual(truth.calibration.reduce((a, b) => a + b.n, 0), y.length);
  assert.strictEqual(evaluate([1, 0], [1, 0]).calibration.reduce((a, b) => a + b.n, 0), 2, 'a score of exactly 1 is in a bucket');
});
