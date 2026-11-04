const test = require('node:test');
const assert = require('node:assert');
const { medianRange, trendBand } = require('../public/spread');

// U2: uncertainty bands. A band that doesn't hold its promise is worse than none, so besides the
// arithmetic each is checked for coverage: on many noisy samples drawn around a known truth, the 80%
// band must contain the truth about 80% of the time.

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

test('trend band: a straight line has its slope exactly and no width', () => {
  const t = trendBand([[1, 10], [2, 10.5], [3, 11], [4, 11.5], [5, 12]]);
  assert.ok(Math.abs(t.slope - 0.5) < 1e-9);
  assert.ok(t.slopeHi - t.slopeLo < 1e-9);
  for (const [, mid, lo, hi] of t.band) assert.ok(hi - lo < 1e-9 && Math.abs(hi - mid) < 1e-9);
});

test('trend band: too few points to say anything is no band', () => {
  assert.strictEqual(trendBand([[1, 1], [2, 2], [3, 3]]), null);
  assert.strictEqual(trendBand([]), null);
  assert.strictEqual(trendBand([[1, 5], [1, 6], [1, 7], [1, 8]]), null, 'all at one x has no slope');
});

test('trend band: narrowest in the middle of the laps, widest at the ends', () => {
  const r = rng(7);
  const pts = Array.from({ length: 12 }, (_, i) => [i + 1, 0.3 * (i + 1) + 0.4 * gauss(r)]);
  const t = trendBand(pts);
  const width = (b) => b[3] - b[2];
  const mid = t.band.reduce((a, b) => (width(b) < width(a) ? b : a));
  assert.ok(mid[0] >= 5 && mid[0] <= 8, `narrowest at lap ${mid[0]}`);
  assert.ok(width(t.band[0]) > width(mid) && width(t.band[t.band.length - 1]) > width(mid));
});

test('trend band: the 80% range of the slope holds the true slope about 80% of the time', () => {
  const r = rng(2026);
  let inside = 0;
  const trials = 1000;
  for (let k = 0; k < trials; k++) {
    const pts = Array.from({ length: 10 }, (_, i) => [i + 1, 0.3 * (i + 1) + 0.5 * gauss(r)]);
    const t = trendBand(pts);
    if (t.slopeLo <= 0.3 && 0.3 <= t.slopeHi) inside++;
  }
  const share = inside / trials;
  assert.ok(share > 0.75 && share < 0.85, `held the true slope ${Math.round(share * 100)}% of the time`);
});

test('trend band: the band around the line holds the true line about 80% of the time, at any lap', () => {
  const r = rng(99);
  let inside = 0;
  let total = 0;
  for (let k = 0; k < 600; k++) {
    const pts = Array.from({ length: 12 }, (_, i) => [i + 1, 1 + 0.2 * (i + 1) + 0.6 * gauss(r)]);
    const t = trendBand(pts);
    const [x, , lo, hi] = t.band[3 + (k % 5)];
    total++;
    if (lo <= 1 + 0.2 * x && 1 + 0.2 * x <= hi) inside++;
  }
  const share = inside / total;
  assert.ok(share > 0.75 && share < 0.85, `${Math.round(share * 100)}%`);
});

test('median range: the range of the typical value, a point for identical laps, nothing for too few', () => {
  assert.strictEqual(medianRange([1, 2]), null);
  const same = medianRange([300, 300, 300, 300]);
  assert.deepStrictEqual([same.mid, same.lo, same.hi, same.n], [300, 300, 300, 4]);
  const spread = medianRange([100, 300, 200, 500, 250, 150, 350]);
  assert.strictEqual(spread.mid, 250);
  assert.ok(spread.lo < 250 && 250 < spread.hi);
});

test('median range: holds the true median about 80% of the time, on a dozen laps', () => {
  const r = rng(31337);
  let inside = 0;
  const trials = 1000;
  for (let k = 0; k < trials; k++) {
    const laps = Array.from({ length: 12 }, () => 0.3 + 0.25 * gauss(r));
    const m = medianRange(laps);
    if (m.lo <= 0.3 && 0.3 <= m.hi) inside++;
  }
  const share = inside / trials;
  assert.ok(share > 0.74 && share < 0.86, `${Math.round(share * 100)}%`);
});
