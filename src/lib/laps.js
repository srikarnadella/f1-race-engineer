// Lap-list helpers shared by the tyre model and race analysis.
const { median } = require('./stats');

// A lap this much slower than the car's own typical lap is a spin, a crash,
// or a safety-car lap the flags missed - not pace. The tyre model and the
// pace figures both drop them.
const SLOW_LAP_FACTOR = 1.07;
function withoutSlowLaps(laps) {
  const typical = median(laps.map((l) => l.lapMs));
  return typical == null ? laps : laps.filter((l) => l.lapMs <= typical * SLOW_LAP_FACTOR);
}

const WET_COMPOUNDS = new Set([7, 8]); // visual: inter, wet
const SLICK_COMPOUNDS = new Set([16, 17, 18]);
// Slick or wet: lap times on one say little about the other.
const groupOf = (compound) => (WET_COMPOUNDS.has(compound) ? 'wet' : SLICK_COMPOUNDS.has(compound) ? 'slick' : null);

module.exports = { withoutSlowLaps, groupOf, WET_COMPOUNDS, SLICK_COMPOUNDS };
