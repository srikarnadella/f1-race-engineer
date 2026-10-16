// Projected battery for a car in the fight: where its ERS store will be when
// it next crosses the line. "He's on 70% now" matters less than "he'll be on
// 40% at the line".
//
// Drivers spend and harvest in the same places every lap (straights /
// braking zones), so the rest of this lap is predicted from the same stretch
// of the last one: now + (last lap's store at the line - last lap's store at
// this point). Scored on real races (npm run accuracy, docs/accuracy.md):
// 7.4 points mean error vs 9.9 for "stays where it is" - and extrapolating
// this lap's use by distance did worse than both (12.3): deployment isn't
// spread evenly round a lap.
// With no clean last lap to copy (lap 1, after a pit or safety-car lap, a
// flashback) it falls back to the current value.

const ERS_MAX_J = 4e6;

const pct = (j) => Math.max(0, Math.min(100, (j / ERS_MAX_J) * 100));

// Store at a lap distance in last lap's profile: the sample for that slice,
// or the nearest earlier one.
function profileAt(binsJ, bin) {
  for (let k = bin; k >= 0; k--) if (binsJ[k] != null) return binsJ[k];
  return null;
}

function projectBattery(car, trackLength) {
  const st = car && car.status;
  const ld = car && car.lapData;
  if (!st || !ld || !Number.isFinite(st.ersStoreEnergy) || ld.pitStatus) return null;
  const now = st.ersStoreEnergy;
  const prev = car.ersPrevLap;
  const usable = prev && !prev.unusual && prev.lapNum === ld.currentLapNum - 1 && trackLength > 0;
  const bin = usable ? Math.min(prev.binsJ.length - 1, Math.floor((Math.max(0, ld.lapDistance) / trackLength) * prev.binsJ.length)) : null;
  const then = usable ? profileAt(prev.binsJ, bin) : null;
  const atLineJ = then != null ? now + (prev.lineJ - then) : now;
  return {
    nowPct: Math.round(pct(now)),
    atLinePct: Math.round(pct(atLineJ)),
    // Net use over the last lap: + charging, - spending.
    trendPctPerLap: usable && prev.binsJ[0] != null ? Math.round(((prev.lineJ - prev.binsJ[0]) / ERS_MAX_J) * 100) : null,
    basis: then != null ? 'last lap' : 'current',
  };
}

module.exports = { projectBattery, ERS_MAX_J };
