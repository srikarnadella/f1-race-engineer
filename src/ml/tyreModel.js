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

const { withoutSlowLaps } = require('../state/race');

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

// cars: FieldModel cars (lapHistory entries carry compound + tyreAge).
// burnKgPerLap: measured fuel use per lap (the player's), or a typical 1.6.
function fitDegradation(cars, burnKgPerLap = 1.6) {
  const fuelMsPerLap = burnKgPerLap * FUEL_MS_PER_KG;
  const byCompound = new Map();
  for (const car of cars) {
    const usable = (car.lapHistory || []).filter((l) => !l.pit && !l.neutralised && l.lapNum > 1 && l.lapMs > 0 && l.compound != null && l.tyreAge != null);
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
    const first = fitSlope(points);
    if (!first) continue;
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
    const fit = fitSlope(kept) || first;
    out[compound] = { name: NAMES[compound] || `compound ${compound}`, degMsPerLap: Math.round(fit.slope), laps: fit.rows.length, cars: fit.cars };
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

module.exports = { fitDegradation, stopPayback };
