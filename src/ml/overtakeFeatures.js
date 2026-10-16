// Features for "will the car behind pass the car ahead in the next few
// seconds?" - computed from FieldModel state, and shared by the training
// script (on recorded races) and the live bridge, so the model sees exactly
// the same inputs in both places.

const FEATURES = [
  // Pass chance isn't linear in the gap - it climbs steeply inside half a
  // second - so the gap enters on a log scale plus an "alongside" flag.
  'logGap', // ln(gap + 0.05s)
  'within05', // gap under half a second (1/0)
  'closingSPerS', // how fast that gap is shrinking right now (+ = closing)
  'paceDeltaS', // defender's clean-lap pace minus attacker's (+ = attacker quicker)
  'tyreAgeDelta', // defender's tyre age minus attacker's, laps (+ = attacker fresher)
  'softerTyre', // attacker on a softer compound (+1) / harder (-1)
  'ersDelta', // attacker's battery minus defender's, fraction of a full store
  'overtakeMode', // attacker has 2026 Overtake mode available (1/0)
  'lapOne', // first lap: everyone's close and everything moves
];
const SOFTNESS = { 16: 2, 17: 1, 18: 0 }; // visual soft / medium / hard
const ERS_MAX_J = 4e6;
const CLOSING_WINDOW_S = 5;

// Gap shrink rate over the last few seconds of the attacker's 1Hz gap
// samples (FieldModel gapAheadHistory, which resets when the car ahead
// changes) - seconds of gap lost per second.
function closingRate(car) {
  const h = car.gapAheadHistory || [];
  if (h.length < 2) return 0;
  const now = h[h.length - 1];
  let then = h[0];
  for (let i = h.length - 2; i >= 0; i--) {
    then = h[i];
    if (now.t - h[i].t >= CLOSING_WINDOW_S) break;
  }
  const dt = now.t - then.t;
  return dt > 0 ? -((now.gapMs - then.gapMs) / 1000) / dt : 0;
}

function cleanPace(car) {
  const clean = (car.lapHistory || []).filter((l) => !l.pit && !l.neutralised).slice(-3);
  return clean.length ? clean.reduce((a, l) => a + l.lapMs, 0) / clean.length : null;
}

// attacker is directly behind defender. Returns null if the pair isn't a
// live battle (either in the pits, no interval yet).
function pairFeatures(attacker, defender) {
  const la = attacker.lapData;
  const ld = defender.lapData;
  if (!la || !ld || la.pitStatus || ld.pitStatus || !(la.deltaToCarInFrontInMS > 0)) return null;
  const sa = attacker.status || {};
  const sd = defender.status || {};
  const pa = cleanPace(attacker);
  const pd = cleanPace(defender);
  const soft = (s) => SOFTNESS[s.visualTyreCompound];
  const gapS = la.deltaToCarInFrontInMS / 1000;
  return {
    gapS, // kept for filtering, not a model input
    logGap: Math.log(gapS + 0.05),
    within05: gapS < 0.5 ? 1 : 0,
    closingSPerS: closingRate(attacker),
    paceDeltaS: pa != null && pd != null ? (pd - pa) / 1000 : 0,
    tyreAgeDelta: sa.tyresAgeLaps != null && sd.tyresAgeLaps != null ? sd.tyresAgeLaps - sa.tyresAgeLaps : 0,
    softerTyre: soft(sa) != null && soft(sd) != null ? Math.sign(soft(sa) - soft(sd)) : 0,
    ersDelta: Number.isFinite(sa.ersStoreEnergy) && Number.isFinite(sd.ersStoreEnergy) ? (sa.ersStoreEnergy - sd.ersStoreEnergy) / ERS_MAX_J : 0,
    overtakeMode: attacker.telemetry2 && attacker.telemetry2.overtakeAvailable ? 1 : 0,
    lapOne: la.currentLapNum <= 1 ? 1 : 0,
  };
}

const toVector = (f) => FEATURES.map((k) => f[k]);

module.exports = { FEATURES, pairFeatures, toVector };
