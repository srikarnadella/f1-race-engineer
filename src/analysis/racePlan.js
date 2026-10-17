// Before the start: one stop or two, on which tyres, and roughly when.
// Each stint costs its set's pace offset every lap (the game's own lap-time
// delta per set, from the Tyre Sets packet) plus the compound's wear rate x
// tyre age; each stop costs the pit loss. Fuel burns the same whatever the
// plan, so it drops out. A dry race must use two compounds.

// shortcut: wear rates for a compound nothing has measured yet (ms per lap
// of tyre age; real F1 26 races measured ~80-200); practice laps at the
// track replace them (state/trackMemory.js).
const DEFAULT_DEG_MS = { 16: 150, 17: 90, 18: 60 };
const DRY = [16, 17, 18];
const NEW_WEAR_PCT = 5; // a set under this is new
const SETS_PER_COMPOUND = 2; // enough for a two-stop on one compound twice

// Extra time over a whole stint of `laps` on a set: offset each lap, plus
// deg x age summed from its starting age.
const stintMs = (s, laps) => laps * s.offsetMs + s.degMs * (laps * s.startAge + (laps * (laps - 1)) / 2);

// sets: the player's Tyre Sets entries; deg: { [compound]: ms per lap of age }.
function racePlan({ totalLaps, pitLossMs, sets, deg = {} }) {
  if (!(totalLaps >= 3) || !(pitLossMs > 0) || !sets || !sets.length) return null;
  // Per compound, the freshest sets the player still has.
  const pool = [];
  for (const c of DRY) {
    const mine = sets
      .filter((s) => s.available && s.visualTyreCompound === c && s.usableLife > 0)
      .sort((a, b) => a.wear - b.wear)
      .slice(0, SETS_PER_COMPOUND);
    for (const s of mine) {
      pool.push({
        index: s.index,
        compound: c,
        offsetMs: s.lapDeltaTimeMs,
        degMs: deg[c] > 0 ? deg[c] : DEFAULT_DEG_MS[c],
        // A used set starts its stint some laps old.
        startAge: s.wear < NEW_WEAR_PCT ? 0 : Math.max(0, s.usableLife - s.lifeSpan),
        life: Math.max(1, s.usableLife - (s.wear < NEW_WEAR_PCT ? 0 : Math.max(0, s.usableLife - s.lifeSpan))),
      });
    }
  }
  const best = { 1: null, 2: null };
  const keep = (seq, stints, totalMs) => {
    const stops = seq.length - 1;
    if (!best[stops] || totalMs < best[stops].totalMs) best[stops] = { stops, totalMs, seq, stints };
  };
  const twoCompounds = (seq) => new Set(seq.map((s) => s.compound)).size >= 2; // the dry-race rule
  const n = totalLaps;
  // Each stint at most its set's rated life, so only those splits are tried.
  for (const a of pool) {
    for (const b of pool) {
      if (b.index === a.index) continue;
      if (twoCompounds([a, b])) {
        for (let L1 = Math.max(1, n - b.life); L1 <= Math.min(a.life, n - 1); L1++) keep([a, b], [L1, n - L1], stintMs(a, L1) + stintMs(b, n - L1) + pitLossMs);
      }
      for (const c of pool) {
        if (c.index === a.index || c.index === b.index || !twoCompounds([a, b, c])) continue;
        for (let L1 = 1; L1 <= Math.min(a.life, n - 2); L1++) {
          for (let L2 = Math.max(1, n - L1 - c.life); L2 <= Math.min(b.life, n - L1 - 1); L2++) {
            const L3 = n - L1 - L2;
            keep([a, b, c], [L1, L2, L3], stintMs(a, L1) + stintMs(b, L2) + stintMs(c, L3) + 2 * pitLossMs);
          }
        }
      }
    }
  }
  const plans = [best[1], best[2]].filter(Boolean).sort((x, y) => x.totalMs - y.totalMs);
  // shortcut: at most two stops, inside each set's rated life - a full-length
  // race (50%+ distance) can need three; add them when such races are recorded.
  if (!plans.length) return null;
  const view = (p) => {
    let lap = 0;
    return {
      stops: p.stops,
      stints: p.seq.map((s, i) => ({ compound: s.compound, laps: p.stints[i], setIndex: s.index })),
      // Box at the end of these laps.
      boxLaps: p.stints.slice(0, -1).map((L) => (lap += L)),
      totalMs: Math.round(p.totalMs),
    };
  };
  const [first, second] = plans.map(view);
  return { best: first, other: second ? { ...second, slowerMs: second.totalMs - first.totalMs } : null };
}

const NAME = { 16: 'Soft', 17: 'Medium', 18: 'Hard' };
// "1 stop: Soft 14 laps, Medium 16 - box end of lap 14"
function planText(p) {
  const stints = p.stints.map((s, i) => `${NAME[s.compound]}${i < p.stints.length - 1 ? ` ${s.laps} laps` : ` ${s.laps}`}`).join(', ');
  return `${p.stops} stop${p.stops === 1 ? '' : 's'}: ${stints} - box end of lap ${p.boxLaps.join(' and ')}`;
}

module.exports = { racePlan, planText };
