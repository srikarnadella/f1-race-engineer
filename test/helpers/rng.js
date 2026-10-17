// Seeded PRNG (mulberry32), so a randomised test that fails reproduces.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Normal(0, sd) by Box-Muller.
const gauss = (r, sd = 1) => sd * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

module.exports = { rng, gauss, int };
