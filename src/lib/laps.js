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

module.exports = { withoutSlowLaps };
