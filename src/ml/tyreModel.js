// Tyre degradation per compound, learned live from the whole field - 22
// cars' laps, not just yours - so the estimate firms up within a few laps.
//
// lapTime = carBase + deg x tyreAge - fuelEffect x lapNumber + noise
//
// Each car is compared only with itself (its laps minus its own average),
// so faster and slower cars share one degradation slope. Fuel can't be
// separated from tyre age from lap times alone when nobody has stopped
// (both rise one per lap), so the fuel effect is fixed from physics: the
// measured burn per lap x ~0.03s per kg - a widely used rule of thumb.
// Laps far off a car's own trend (traffic, a mistake) are trimmed with a
// robust MAD filter before the final fit.

const { withoutSlowLaps } = require('../lib/laps');
const { median } = require('../lib/stats');

const FUEL_MS_PER_KG = 30;
const MIN_LAPS_PER_CAR = 3;
const MIN_CARS = 3;
const NAMES = { 16: 'soft', 17: 'medium', 18: 'hard', 7: 'inter', 8: 'wet' };

function fitSlope(points) {
  // points: [{ car, x, y }] - within-car demeaned least squares through 0.
  const byCar = new Map();
  for (const p of points) {
    if (!byCar.has(p.car)) byCar.set(p.car, []);
    byCar.get(p.car).push(p);
  }
  const rows = [];
  for (const ps of byCar.values()) {
    if (ps.length < MIN_LAPS_PER_CAR) continue;
    const mx = ps.reduce((a, p) => a + p.x, 0) / ps.length;
    const my = ps.reduce((a, p) => a + p.y, 0) / ps.length;
    for (const p of ps) rows.push({ x: p.x - mx, y: p.y - my, car: p.car, point: p });
  }
  const cars = new Set(rows.map((r) => r.car)).size;
  const sxx = rows.reduce((a, r) => a + r.x * r.x, 0);
  if (cars < MIN_CARS || sxx === 0) return null;
  return { slope: rows.reduce((a, r) => a + r.x * r.y, 0) / sxx, rows, cars };
}

// Green racing laps with a known tyre: the laps that say something about wear.
const usableLaps = (car) => (car.lapHistory || []).filter((l) => !l.pit && !l.neutralised && l.lapNum > 1 && l.lapMs > 0 && l.compound != null && l.tyreAge != null);

// One compound's laps -> the robust fit, or null with too few cars or laps.
function fitCompound(points) {
  const first = fitSlope(points);
  if (!first) return null;
  // Robust pass: drop laps more than 3 MADs off the first fit. Each row
  // carries its lap, so a car left out of the fit (too few laps) can't shift
  // which laps are dropped.
  // shortcut: one pass - traffic late in a stint tilts the first fit and
  // mostly survives it (test/invariants.test.js, todo); re-trimming until
  // stable fixed that on synthetic laps but predicted held-out cars worse on
  // the Suzuka race, so it waits for more races to judge it on.
  const resid = first.rows.map((r) => r.y - first.slope * r.x);
  const med = [...resid].sort((a, b) => a - b)[resid.length >> 1];
  const mad = [...resid.map((v) => Math.abs(v - med))].sort((a, b) => a - b)[resid.length >> 1] || 1;
  const kept = first.rows.filter((_, i) => Math.abs(resid[i] - med) <= 3 * 1.4826 * mad).map((r) => r.point);
  return fitSlope(kept) || first;
}

// How sure the slope is: refit on the field resampled car by car (cars, not
// laps, are the independent units - one car's laps share its pace and its
// set). Seeded, so the same laps always give the same range.
function slopeInterval(points, samples) {
  const byCar = [...points.reduce((m, p) => m.set(p.car, [...(m.get(p.car) || []), p]), new Map()).values()];
  let seed = 0x5eed;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const slopes = [];
  for (let b = 0; b < samples; b++) {
    // Each draw is a car of its own, even if the same car is drawn twice.
    const resampled = byCar.flatMap((_, k) => byCar[Math.floor(rand() * byCar.length)].map((p) => ({ ...p, car: k })));
    const fit = fitCompound(resampled);
    if (fit) slopes.push(fit.slope);
  }
  if (slopes.length < samples / 2) return null;
  slopes.sort((a, b) => a - b);
  return [Math.round(slopes[Math.floor(slopes.length * 0.05)]), Math.round(slopes[Math.ceil(slopes.length * 0.95) - 1])];
}

// cars: FieldModel cars (lapHistory entries carry compound + tyreAge).
// burnKgPerLap: measured fuel use per lap (the player's), or a typical 1.6.
// bootstrap: resamples for a 90% range on each slope (ciMs); 0 = none.
function fitDegradation(cars, burnKgPerLap = 1.6, { bootstrap = 0 } = {}) {
  const fuelMsPerLap = burnKgPerLap * FUEL_MS_PER_KG;
  const byCompound = new Map();
  // By car, not track order: the bootstrap draws cars by index, so an overtake would move the range.
  for (const car of [...cars].sort((a, b) => a.carIndex - b.carIndex)) {
    const usable = usableLaps(car);
    for (const compound of new Set(usable.map((l) => l.compound))) {
      if (!byCompound.has(compound)) byCompound.set(compound, []);
      // A slow lap at a young tyre age (one spin) tilts the whole slope - the
      // MAD trim below can't catch it, the first fit already leans on it.
      for (const l of withoutSlowLaps(usable.filter((x) => x.compound === compound))) {
        // Add back the time the car gained from being lighter, so only tyre wear is left.
        byCompound.get(compound).push({ car: car.carIndex, x: l.tyreAge, y: l.lapMs + fuelMsPerLap * l.lapNum });
      }
    }
  }
  const out = {};
  for (const [compound, points] of byCompound) {
    const fit = fitCompound(points);
    if (!fit) continue;
    out[compound] = { name: NAMES[compound] || `compound ${compound}`, degMsPerLap: Math.round(fit.slope), laps: fit.rows.length, cars: fit.cars };
    if (bootstrap) {
      const ci = slopeInterval(points, bootstrap);
      // The estimate always sits inside its own range.
      if (ci) out[compound].ciMs = [Math.min(ci[0], out[compound].degMsPerLap), Math.max(ci[1], out[compound].degMsPerLap)];
    }
  }
  return { fuelMsPerLap: Math.round(fuelMsPerLap), compounds: out };
}

// "Would fresh tyres pay for a stop?" - each lap on new tyres gains back
// roughly deg x (current tyre age); the stop costs the pit loss.
function stopPayback({ degMsPerLap, tyreAge, pitLossMs, lapsLeft }) {
  if (!(degMsPerLap > 0) || !(tyreAge > 0) || !(pitLossMs > 0)) return null;
  const gainPerLap = degMsPerLap * tyreAge;
  const laps = pitLossMs / gainPerLap;
  return { gainPerLapMs: Math.round(gainPerLap), paybackLaps: Math.round(laps * 10) / 10, worthIt: lapsLeft != null ? laps < lapsLeft : null };
}

// Backtest: each car's laps predicted from a fit on every other car, against
// the naive "tyres don't wear" guess. A lap is predicted up to the car's own
// level (its median, fuel removed) - the slope is what's being tested.
// Returns median and mean absolute error per lap, in ms.
function holdOutScore(cars, burnKgPerLap = 1.6) {
  const fuelMsPerLap = burnKgPerLap * FUEL_MS_PER_KG;
  const model = [];
  const naive = [];
  const scored = new Set();
  for (const held of cars) {
    const fit = fitDegradation(cars.filter((c) => c !== held), burnKgPerLap).compounds;
    const usable = usableLaps(held);
    for (const compound of new Set(usable.map((l) => l.compound))) {
      const laps = withoutSlowLaps(usable.filter((l) => l.compound === compound));
      if (!fit[compound] || laps.length < MIN_LAPS_PER_CAR) continue;
      const y = laps.map((l) => l.lapMs + fuelMsPerLap * l.lapNum);
      const errs = (slope) => {
        const level = median(y.map((v, i) => v - slope * laps[i].tyreAge));
        return y.map((v, i) => Math.abs(v - slope * laps[i].tyreAge - level));
      };
      model.push(...errs(fit[compound].degMsPerLap));
      naive.push(...errs(0));
      scored.add(held.carIndex);
    }
  }
  const summary = (e) => ({ medianMs: e.length ? Math.round(median(e)) : null, meanMs: e.length ? Math.round(e.reduce((a, b) => a + b, 0) / e.length) : null });
  return { laps: model.length, cars: scored.size, model: summary(model), naive: summary(naive) };
}

module.exports = { fitDegradation, stopPayback, holdOutScore };
