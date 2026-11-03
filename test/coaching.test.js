const test = require('node:test');
const assert = require('node:assert');
const { adviseCorners, liftAndCoast } = require('../src/llm/coaching');

// Advice from the engine's rules, each with the number it rests on; the model only explains it.
// Corners as lapCompare gives them for lap B against your best lap A (+ = B lost / later).
const corner = (over) => ({ corner: 1, atM: 700, timeS: 0.2, brakePointM: 0, apexKmh: 0, exitKmh: 0, throttleM: 0, coastM: 0, refCoastM: 0, refApexKmh: 147, ...over });

test('coaching: braking earlier than your best for nothing says brake later, by how much', () => {
  const [a] = adviseCorners([corner({ brakePointM: -12 })], { best: 14, lap: 22 });
  assert.match(a.text, /Corner 1.*brake 12 m later.*as on lap 14/);
  assert.strictEqual(a.lostS, 0.2);
});

test('coaching: slower at the apex says carry more speed, to your best lap\'s figure', () => {
  const [a] = adviseCorners([corner({ apexKmh: -9 })], { best: 14, lap: 22 });
  assert.match(a.text, /9 km\/h more.*apex.*147 km\/h on lap 14/);
});

test('coaching: late back on the throttle says get on it sooner', () => {
  const [a] = adviseCorners([corner({ throttleM: 30 })], { best: 14, lap: 22 });
  assert.match(a.text, /full throttle 30 m sooner/);
});

test('coaching: biggest loss first; corners that cost nothing get no advice', () => {
  const out = adviseCorners([corner({ corner: 1, timeS: 0.05, apexKmh: -6 }), corner({ corner: 2, timeS: 0.3, brakePointM: -15 }), corner({ corner: 3, timeS: -0.1, apexKmh: -8 })], { best: 14, lap: 22 });
  assert.deepStrictEqual(out.map((x) => x.corner), [2, 1]);
});

test('lift and coast: the braking zones after the longest flat-out runs, and what you do there now', () => {
  const zones = [
    { corner: 1, atM: 720, flatOutM: 720, coastM: 0, entryKmh: 319 },
    { corner: 2, atM: 1615, flatOutM: 635, coastM: 40, entryKmh: 273 },
    { corner: 3, atM: 2025, flatOutM: 215, coastM: 0, entryKmh: 242 },
    { corner: 4, atM: 3370, flatOutM: 460, coastM: 0, entryKmh: 294 },
  ];
  const out = liftAndCoast(zones, { lap: 14, fuelPerLapKg: 1.6 });
  assert.deepStrictEqual(out.candidates.map((c) => c.corner), [1, 2, 4]);
  assert.match(out.candidates[0].text, /Corner 1.*720 m flat out.*319 km\/h/);
  assert.match(out.candidates[1].text, /already coast 40 m/);
  assert.match(out.summary, /1\.6 kg a lap/);
  assert.strictEqual(liftAndCoast([], { lap: 1 }).candidates.length, 0);
});

const { balanceAdvice } = require('../src/llm/coaching');
// Issues as the race store keeps them (one row per corner, lap and kind), with the settings at the time.
const issue = (lap, kind, distM, over = {}) => ({ lap_num: lap, kind, distance_m: distM, wheel: kind === 'front_lock' ? 'FL' : null, brake_bias: 56, diff_on_throttle: 60, ...over });
const corners = [{ corner: 1, atM: 300 }, { corner: 2, atM: 1300 }, { corner: 3, atM: 2000 }];

test('balance: fronts locking into one corner most laps says bias rearward, from what you ran', () => {
  const out = balanceAdvice([2, 3, 4, 5, 6].map((l) => issue(l, 'front_lock', 1290)), { corners, racingLaps: 6, bias: 56, diff: 60 });
  assert.match(out.advice[0], /FL locks into corner 2 on 5 of 6 laps.*56%.*rearward.*56 to 54%/i);
});

test('balance: wheelspin out of a corner says lower the on-throttle diff; understeer says raise it', () => {
  const spin = balanceAdvice([3, 4, 5].map((l) => issue(l, 'wheelspin', 310)), { corners, racingLaps: 6, bias: 56, diff: 60 });
  assert.match(spin.advice[0], /wheelspin out of corner 1 on 3 of 6 laps.*on-throttle diff.*60 to 55%/i);
  const under = balanceAdvice([4, 5].map((l) => issue(l, 'understeer', 2010)), { corners, racingLaps: 6, bias: 56, diff: 60 });
  assert.match(under.advice[0], /understeer out of corner 3.*60 to 65%/i);
});

test('balance: locking at three corners or more is the base bias, not one corner', () => {
  const rows = [1290, 310, 2010].flatMap((d) => [3, 4].map((l) => issue(l, 'front_lock', d)));
  const out = balanceAdvice(rows, { corners, racingLaps: 6, bias: 56, diff: 60 });
  assert.match(out.advice[0], /fronts lock at 3 corners.*base brake bias.*56 to 54%/i);
});

test('balance: once is a mistake, not the car: no advice for one lap in many', () => {
  const out = balanceAdvice([issue(4, 'front_lock', 1290)], { corners, racingLaps: 10, bias: 56, diff: 60 });
  assert.deepStrictEqual(out.advice, []);
  assert.strictEqual(out.corners[0].issues[0].laps.length, 1, 'still listed as what happened');
});
