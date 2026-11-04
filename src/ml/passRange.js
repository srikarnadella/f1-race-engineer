// The overtake model's pass chance with the range its noisy inputs allow (roadmap A3). The model is
// re-run with the closing rate and the pace difference each moved by 1.28 standard errors (an 80%
// range) in the direction that raises the chance, and in the one that lowers it. More closing and an
// attacker who is quicker both raise it, so those two corners bound the chance; the estimate itself is
// kept inside in case a tree isn't monotone.
const { predict } = require('./gbdt');

let MODEL = null;
try {
  MODEL = require('./models/overtake-gbdt.json');
} catch (_) {
  MODEL = null;
}

// Held out race by race the model is well calibrated up to 60% and a little overconfident above, so the
// dashboard gets a level plus a percentage capped there.
const PASS_CAP = 0.6;
const Z80 = 1.28;
const passLevel = (p) => (p >= 0.25 ? 'high' : p >= 0.1 ? 'medium' : 'low');

/** @param {Record<string, number>} f pairFeatures() @param {{ closingSE: number, paceSE: number }} spread */
function passRange(f, spread, model = MODEL) {
  if (!model) return null;
  const x = (dc, dp) => model.features.map((k) => (k === 'closingSPerS' ? f.closingSPerS + dc : k === 'paceDeltaS' ? f.paceDeltaS + dp : f[k]));
  const p = predict(model, x(0, 0));
  const dc = Z80 * spread.closingSE;
  const dp = Z80 * spread.paceSE;
  const lo = Math.min(p, predict(model, x(-dc, -dp)));
  const hi = Math.max(p, predict(model, x(dc, dp)));
  const shown = (v) => Math.min(PASS_CAP, Math.round(v * 100) / 100);
  return { p: shown(p), level: passLevel(p), lo: shown(lo), hi: shown(hi), levelLo: passLevel(lo), levelHi: passLevel(hi), horizonS: model.horizonS };
}

module.exports = { passRange };
