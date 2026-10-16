// Where the player loses time to the field, mini-sector by mini-sector.
// The game only sends inputs for your own car, but Lap Data gives every
// car's distance and lap time - enough to time each car through 25 equal
// slices of the lap (state/lapTrace.js). Compared on best splits, so one
// scrappy lap doesn't hide where a rival is genuinely quicker.

const round = (v, dp = 3) => Math.round(v * 10 ** dp) / 10 ** dp;

// cars: [{ name, isPlayer, miniSectors: [{ lapNum, splits: [ms x 25] }] }]
function rivalAnalysis(rawCars, trackLength) {
  const raw = rawCars.filter((c) => c.miniSectors && c.miniSectors.length);
  const rawPlayer = raw.find((c) => c.isPlayer);
  if (!rawPlayer) return null;
  const n = rawPlayer.miniSectors[0].splits.length;
  // Drop laps with a physically implausible split (glitched timing across
  // a flashback or the pit lane): faster than 80% or slower than 3x the
  // field's median for that slice.
  const medians = Array.from({ length: n }, (_, k) => {
    const all = raw.flatMap((c) => c.miniSectors.map((l) => l.splits[k])).sort((a, b) => a - b);
    return all[all.length >> 1];
  });
  const plausible = (l) => l.splits.every((v, k) => v >= 0.8 * medians[k] && v <= 3 * medians[k]);
  const withData = raw.map((c) => ({ ...c, miniSectors: c.miniSectors.filter(plausible) })).filter((c) => c.miniSectors.length);
  const player = withData.find((c) => c.isPlayer);
  if (!player) return null;
  const bestSplits = (c) => Array.from({ length: n }, (_, k) => Math.min(...c.miniSectors.map((l) => l.splits[k])));
  const bestLap = (c) => Math.min(...c.miniSectors.map((l) => l.splits.reduce((a, b) => a + b, 0)));

  const mine = bestSplits(player);
  const field = Array.from({ length: n }, (_, k) => {
    let best = null;
    for (const c of withData) {
      const v = Math.min(...c.miniSectors.map((l) => l.splits[k]));
      if (!best || v < best.ms) best = { ms: v, name: c.name, isPlayer: c.isPlayer };
    }
    return best;
  });

  // The benchmark rival: the quickest actual lap among the others.
  const others = withData.filter((c) => !c.isPlayer);
  const rival = others.length ? others.reduce((a, b) => (bestLap(b) < bestLap(a) ? b : a)) : null;
  const rivalSplits = rival ? bestSplits(rival) : null;
  const sliceM = trackLength ? trackLength / n : null;

  const sectors = mine.map((ms, k) => ({
    index: k + 1,
    fromM: sliceM ? Math.round(k * sliceM) : null,
    toM: sliceM ? Math.round((k + 1) * sliceM) : null,
    youMs: ms,
    vsFieldBestS: round((ms - field[k].ms) / 1000),
    fieldBestBy: field[k].name,
    vsRivalS: rivalSplits ? round((ms - rivalSplits[k]) / 1000) : null,
  }));

  // Group neighbouring slices where time goes, so the story is "1.6-2.1 km"
  // rather than three separate rows.
  const losses = [];
  for (const s of sectors) {
    const v = s.vsRivalS != null ? s.vsRivalS : s.vsFieldBestS;
    const last = losses[losses.length - 1];
    if (v >= 0.02 && last && last.to === s.index - 1) Object.assign(last, { to: s.index, toM: s.toM, lossS: round(last.lossS + v) });
    else if (v >= 0.02) losses.push({ from: s.index, to: s.index, fromM: s.fromM, toM: s.toM, lossS: v });
  }
  losses.sort((a, b) => b.lossS - a.lossS);

  return {
    miniSectors: n,
    rival: rival ? { name: rival.name, bestLapMs: bestLap(rival) } : null,
    yourBestLapMs: bestLap(player),
    yourIdealLapMs: mine.reduce((a, b) => a + b, 0),
    fieldIdealLapMs: field.reduce((a, b) => a + b.ms, 0),
    gapToRivalS: rival ? round((bestLap(player) - bestLap(rival)) / 1000) : null,
    sectors,
    biggestLosses: losses.slice(0, 3).map((l) => ({
      ...l,
      text: `${l.fromM != null ? `${(l.fromM / 1000).toFixed(1)}-${(l.toM / 1000).toFixed(1)} km` : `mini-sectors ${l.from}-${l.to}`}: ${l.lossS.toFixed(2)}s slower than ${rival ? rival.name : 'the field best'}`,
    })),
  };
}

module.exports = { rivalAnalysis };
