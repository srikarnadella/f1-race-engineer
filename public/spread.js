// Uncertainty bands (roadmap U2): the range a typical lap difference, or the trend of a gap, could
// really be, from the scatter of the laps it came from. One file for the page (Race analysis) and the
// engine (Ask the race's charts) so the two can never disagree: loaded as a script it sets
// window.Spread, required by node it exports the same functions.
(function () {
  // Student's t for an 80% two-sided range, by degrees of freedom; 1.282 (the normal) beyond 30.
  const T80 = [NaN, 3.078, 1.886, 1.638, 1.533, 1.476, 1.44, 1.415, 1.397, 1.383, 1.372, 1.363, 1.356, 1.35, 1.345, 1.341, 1.337, 1.333, 1.33, 1.328, 1.325, 1.323, 1.321, 1.319, 1.318, 1.316, 1.315, 1.314, 1.313, 1.311, 1.31];
  const t80 = (df) => (df >= 1 && df <= 30 ? T80[df] : 1.282);
  // The median of a sample is about 25% less sure than its mean (1.2533 standard errors of the mean).
  const MEDIAN_FACTOR = 1.2533;

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  // The typical value and the 80% range it could be, from the scatter. null under three values.
  function medianRange(values) {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    const n = v.length;
    if (n < 3) return null;
    const mid = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
    const m = mean(v);
    const sd = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1));
    const half = (t80(n - 1) * MEDIAN_FACTOR * sd) / Math.sqrt(n);
    return { mid, lo: mid - half, hi: mid + half, n };
  }

  // A least-squares line through [x, y] points with the 80% range of its slope and, at every x, the range
  // the line itself could be. null under four points, or when every x is the same.
  function trendBand(points) {
    const p = points.filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]));
    const n = p.length;
    if (n < 4) return null;
    const mx = mean(p.map((q) => q[0]));
    const my = mean(p.map((q) => q[1]));
    let sxx = 0;
    let sxy = 0;
    for (const [x, y] of p) {
      sxx += (x - mx) ** 2;
      sxy += (x - mx) * (y - my);
    }
    if (!(sxx > 0)) return null;
    const slope = sxy / sxx;
    const intercept = my - slope * mx;
    let ss = 0;
    for (const [x, y] of p) ss += (y - (intercept + slope * x)) ** 2;
    const s = Math.sqrt(ss / (n - 2));
    const t = t80(n - 2);
    const half = (x) => t * s * Math.sqrt(1 / n + (x - mx) ** 2 / sxx);
    return {
      n,
      slope,
      intercept,
      slopeLo: slope - (t * s) / Math.sqrt(sxx),
      slopeHi: slope + (t * s) / Math.sqrt(sxx),
      band: p.map(([x]) => x).sort((a, b) => a - b).map((x) => [x, intercept + slope * x, intercept + slope * x - half(x), intercept + slope * x + half(x)]),
    };
  }

  const api = { medianRange, trendBand };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else /** @type {any} */ (window).Spread = api;
})();
