// "When and where will the car behind attack?" - and the mirror image,
// "where is my best chance on the car ahead?".
//
// Where: each corner (one of the player's braking zones) is scored on two
// things -
//   - how much time the attacker gains on the defender on the run into it,
//     from both cars' recent mini-sector times (Lap Data times every car);
//   - how often passes actually happen there at this track: this session's
//     overtakes plus a map learned from recorded races
//     (src/ml/models/pass-hotspots.json, built by `npm run train:overtake`).
// When: from the closing rate - "now" once inside attack range, otherwise
// the laps until the gap is down to it.

const { median } = require('../lib/stats');

const ATTACK_RANGE_S = 1.0;
const MIN_CLOSING_S_PER_LAP = 0.05;
const APPROACH_M = 800; // how far back from a corner its run-up is counted, at most
const HOT_BEFORE_M = 150; // a pass is credited to a corner if it registers this
const HOT_AFTER_M = 450; //   far before / after the brake point (passes complete past the apex)
const RECENT_LAPS = 3;
const GAIN_WEIGHT = Number(process.env.F1RE_GAIN_WEIGHT || 0.2);

// Median mini-sector splits over a car's last few racing laps. Pit and
// neutralised laps are left out, and the median drops one bad lap: the pit
// lane on the run to corner 1 read as a 5.46 s "gain" in a real race.
function recentSplits(car) {
  const skip = new Set((car.lapHistory || []).filter((l) => l.pit || l.neutralised).map((l) => l.lapNum));
  const laps = (car.miniSectors || []).filter((l) => !skip.has(l.lapNum)).slice(-RECENT_LAPS);
  if (!laps.length) return null;
  const n = laps[0].splits.length;
  return Array.from({ length: n }, (_, k) => median(laps.map((l) => l.splits[k])));
}

// Seconds the attacker gains over [fromM, toM] (wrapping the line if needed).
function gainOver(att, def, fromM, toM, trackLength) {
  const n = att.length;
  const slice = trackLength / n;
  const ranges = fromM < 0 ? [[fromM + trackLength, trackLength], [0, toM]] : [[fromM, toM]];
  let gain = 0;
  for (let k = 0; k < n; k++) {
    const a = k * slice;
    const b = a + slice;
    for (const [lo, hi] of ranges) {
      const overlap = Math.max(0, Math.min(b, hi) - Math.max(a, lo));
      if (overlap > 0) gain += ((def[k] - att[k]) / 1000) * (overlap / slice);
    }
  }
  return gain;
}

// Share of known passes that happen around each corner.
function hotShare(passesAtM, corners, trackLength) {
  if (!passesAtM.length) return corners.map(() => 0);
  const near = (d, c) => {
    let diff = d - c.startM;
    if (diff < -trackLength / 2) diff += trackLength;
    if (diff > trackLength / 2) diff -= trackLength;
    return diff >= -HOT_BEFORE_M && diff <= HOT_AFTER_M;
  };
  return corners.map((c) => passesAtM.filter((d) => near(d, c)).length / passesAtM.length);
}

// attacker / defender: FieldModel cars. corners: [{ corner, startM }].
// passesAtM: lap distances of known passes at this track. gapS: current
// gap; closingSPerLap: + = the attacker is catching.
// personalPassesAtM: where *this* driver has been passed (defending) or has
// passed (attacking) - weighted above the field's passing map, because on a
// real race the field's busiest spot wasn't where the player kept losing places.
const PERSONAL_WEIGHT = 2;
function forecastAttack({ attacker, defender, corners, trackLength, passesAtM = [], personalPassesAtM = [], gapS, closingSPerLap, role = 'defend' }) {
  if (!attacker || !defender || !trackLength || !(gapS > 0)) return null;
  // When - only a forecast if they're in range or actually catching.
  let when;
  if (gapS <= ATTACK_RANGE_S) when = { laps: 0, text: 'now' };
  else if (closingSPerLap >= MIN_CLOSING_S_PER_LAP) {
    const laps = (gapS - ATTACK_RANGE_S) / closingSPerLap;
    if (laps > 10) return null; // too far off to be useful
    when = { laps: Math.round(laps * 10) / 10, text: `in ~${Math.max(1, Math.round(laps))} lap${Math.round(laps) <= 1 ? '' : 's'}` };
  } else {
    return null;
  }

  const att = recentSplits(attacker);
  const def = recentSplits(defender);
  const haveSplits = att && def && att.length === def.length;
  const list = corners.length ? corners : [];
  if (!list.length) return { when, where: null, closingSPerLap };

  const gains = list.map((c, i) => {
    if (!haveSplits) return 0;
    const prev = i > 0 ? list[i - 1].startM : list[list.length - 1].startM - trackLength;
    const from = Math.max(prev, c.startM - APPROACH_M);
    return gainOver(att, def, from, c.startM + 50, trackLength);
  });
  const field = hotShare(passesAtM, list, trackLength);
  const mine = hotShare(personalPassesAtM, list, trackLength);
  const hot = personalPassesAtM.length
    ? field.map((f, i) => (f + PERSONAL_WEIGHT * mine[i]) / (1 + PERSONAL_WEIGHT))
    : field;
  const maxGain = Math.max(0.02, ...gains);
  const maxHot = Math.max(1e-9, ...hot);
  const scored = list.map((c, i) => ({
    corner: c.corner,
    atM: c.startM,
    gainS: Math.round(gains[i] * 1000) / 1000,
    passShare: Math.round(hot[i] * 100) / 100,
    // "People pass there" leads, "they're quicker into it" breaks ties. On
    // two real races an equal mix put the corner right 3 times in 29 passes
    // - worse than just naming the most common passing corner (17/29) -
    // because mini-sector gains in a train of cars are mostly slipstream
    // noise. The gain term is floored at zero: a corner where they're slower
    // can still be a passing spot.
    score: (haveSplits ? GAIN_WEIGHT * Math.max(0, gains[i]) / maxGain : 0) + (passesAtM.length ? (1 - GAIN_WEIGHT) * hot[i] / maxHot : 0),
  }));
  // Where passes actually happen decides; the chaser's gain only breaks a
  // near-tie between corners (within 10% of the busiest). Scored on two real
  // races, this is what beat the alternatives - see the README.
  let best;
  if (passesAtM.length || personalPassesAtM.length) {
    const busiest = Math.max(...scored.map((c) => c.passShare));
    const contenders = scored.filter((c) => c.passShare >= busiest * 0.9);
    best = contenders.reduce((a, b) => (b.gainS > a.gainS ? b : a));
    best.score = Math.max(best.score, 1e-6);
  } else {
    best = scored.reduce((a, b) => (b.score > a.score ? b : a));
  }
  if (!(best.score > 0)) return { when, where: null, closingSPerLap };
  const why = [];
  if (best.gainS >= 0.02) why.push(`gains ${best.gainS.toFixed(2)}s on the run to it`);
  const mineThere = personalPassesAtM.length ? Math.round(mine[list.findIndex((c) => c.corner === best.corner)] * personalPassesAtM.length) : 0;
  if (mineThere >= 1) why.push(role === 'attack' ? `you've passed there ${mineThere > 1 ? `${mineThere} times` : 'before'}` : `you've been passed there ${mineThere > 1 ? `${mineThere} times` : 'already'}`);
  else if (best.passShare >= 0.1) why.push(`${Math.round(best.passShare * 100)}% of passes here happen there`);
  return {
    when,
    where: { corner: best.corner, atM: best.atM, why },
    closingSPerLap,
    confidence: haveSplits && passesAtM.length >= 10 ? 'high' : haveSplits || passesAtM.length >= 10 ? 'medium' : 'low',
    candidates: scored.sort((a, b) => b.score - a.score).slice(0, 3),
  };
}

module.exports = { forecastAttack, gainOver, ATTACK_RANGE_S };
