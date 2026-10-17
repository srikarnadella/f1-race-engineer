const test = require('node:test');
const assert = require('node:assert');
const { racePlan, planOdds, planUncertainty } = require('../src/analysis/racePlan');

// One stop or two, as odds: the plan raced many times over with the wear rates
// and the pit loss drawn from what's known about them - a wear rate measured
// this session is tight, one from a default is a guess.
const set = (index, c, life, deltaMs, wear = 0) => ({ index, visualTyreCompound: c, usableLife: life, lifeSpan: life, lapDeltaTimeMs: deltaMs, wear, available: true });
const SETS = [set(0, 16, 15, -600), set(1, 16, 15, -600), set(2, 17, 20, 0), set(3, 18, 25, 400)];
const DEG = { 16: 150, 17: 90, 18: 60 };
const tight = { degSd: { 16: 5, 17: 5, 18: 5 }, pitLossSdMs: 300 };
const wide = { degSd: { 16: 60, 17: 40, 18: 30 }, pitLossSdMs: 3000 };

test('odds: a clear-cut plan wins nearly every simulated race', () => {
  const inputs = { totalLaps: 30, pitLossMs: 25000, sets: SETS, deg: DEG };
  assert.strictEqual(racePlan(inputs).best.stops, 1);
  const o = planOdds(inputs, tight);
  assert.ok(o.oneStopPct >= 95, JSON.stringify(o));
  assert.strictEqual(o.oneStopPct + o.twoStopPct, 100);
});

test('odds: at the pit loss where the two plans tie, it is close to a coin flip', () => {
  // Find the pit loss where one and two stops cost the same.
  let lo = 2000;
  let hi = 40000;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (racePlan({ totalLaps: 30, pitLossMs: mid, sets: SETS, deg: DEG }).best.stops === 2) lo = mid;
    else hi = mid;
  }
  const o = planOdds({ totalLaps: 30, pitLossMs: lo, sets: SETS, deg: DEG }, wide);
  assert.ok(o.oneStopPct >= 25 && o.oneStopPct <= 75, `${JSON.stringify(o)} at ${Math.round(lo)} ms`);
});

test('odds: knowing less makes a plan less certain, never more', () => {
  const inputs = { totalLaps: 30, pitLossMs: 18000, sets: SETS, deg: DEG };
  const sure = (o) => Math.max(o.oneStopPct, o.twoStopPct);
  assert.ok(sure(planOdds(inputs, tight)) >= sure(planOdds(inputs, wide)), JSON.stringify([planOdds(inputs, tight), planOdds(inputs, wide)]));
});

test('odds: the same inputs give the same odds, quickly', () => {
  const inputs = { totalLaps: 30, pitLossMs: 18000, sets: SETS, deg: DEG };
  const t = process.hrtime.bigint();
  const a = planOdds(inputs, wide);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.deepStrictEqual(planOdds(inputs, wide), a);
  assert.ok(ms < 150, `${ms.toFixed(0)} ms for ${a.samples} races`);
});

test('odds: the point plan is unchanged by the refactor - same plan as racePlan for each sample count', () => {
  const inputs = { totalLaps: 30, pitLossMs: 5000, sets: SETS, deg: { 16: 400, 17: 300, 18: 250 } };
  assert.strictEqual(racePlan(inputs).best.stops, 2);
  assert.ok(planOdds(inputs, tight).twoStopPct >= 95);
});

test('uncertainty: how well each input is known sets how widely it is drawn', () => {
  const u = planUncertainty({
    fitted: { 16: { degMsPerLap: 150, ciMs: [117, 183] } }, // this session: its 90% range
    remembered: { 17: [100, 120, 110], 18: [80] }, // earlier sessions here
    lossSource: 'measured',
  });
  assert.strictEqual(Math.round(u.degSd[16]), 20, '90% range of 66 ms = 3.29 sd');
  assert.strictEqual(Math.round(u.degSd[17]), 11, 'the spread of three sessions (sd 10), at least 10% of 110');
  assert.strictEqual(u.degSd[18], 20, 'one session: 25%');
  const guess = planUncertainty({ fitted: {}, remembered: {}, lossSource: 'generic estimate' });
  assert.strictEqual(guess.degSd[17], 36, 'a default rate is a guess: 40% of 90');
  assert.ok(guess.pitLossSdMs > u.pitLossSdMs, 'an estimated pit loss is drawn wider than a measured one');
});
