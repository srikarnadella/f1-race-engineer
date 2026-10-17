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

// Every plan tried, as a total that is linear in the wear rates:
//   totalMs = baseMs + sum over compounds of deg[c] x ageLaps[c] + stops x pit loss
// baseMs is the sets' pace offsets; ageLaps[c] the tyre age summed over every
// lap run on compound c. So the search runs once, and pricing a plan under
// other wear rates (planOdds) is a few multiplications.
function candidates({ totalLaps, sets }) {
  // Per compound, the freshest sets the player still has.
  const pool = [];
  for (const c of DRY) {
    const mine = sets
      .filter((s) => s.available && s.visualTyreCompound === c && s.usableLife > 0)
      .sort((a, b) => a.wear - b.wear)
      .slice(0, SETS_PER_COMPOUND);
    for (const s of mine) {
      // A used set starts its stint some laps old.
      const startAge = s.wear < NEW_WEAR_PCT ? 0 : Math.max(0, s.usableLife - s.lifeSpan);
      pool.push({ index: s.index, compound: c, offsetMs: s.lapDeltaTimeMs, startAge, life: Math.max(1, s.usableLife - startAge) });
    }
  }
  const out = [];
  const add = (seq, stints) => {
    const ageLaps = { 16: 0, 17: 0, 18: 0 };
    let baseMs = 0;
    seq.forEach((s, i) => {
      const L = stints[i];
      baseMs += L * s.offsetMs;
      ageLaps[s.compound] += L * s.startAge + (L * (L - 1)) / 2;
    });
    out.push({ seq, stints, stops: seq.length - 1, baseMs, ageLaps });
  };
  const twoCompounds = (seq) => new Set(seq.map((s) => s.compound)).size >= 2; // the dry-race rule
  const n = totalLaps;
  // Each stint at most its set's rated life, so only those splits are tried.
  for (const a of pool) {
    for (const b of pool) {
      if (b.index === a.index) continue;
      if (twoCompounds([a, b])) {
        for (let L1 = Math.max(1, n - b.life); L1 <= Math.min(a.life, n - 1); L1++) add([a, b], [L1, n - L1]);
      }
      for (const c of pool) {
        if (c.index === a.index || c.index === b.index || !twoCompounds([a, b, c])) continue;
        for (let L1 = 1; L1 <= Math.min(a.life, n - 2); L1++) {
          for (let L2 = Math.max(1, n - L1 - c.life); L2 <= Math.min(b.life, n - L1 - 1); L2++) add([a, b, c], [L1, L2, n - L1 - L2]);
        }
      }
    }
  }
  return out;
}

const degOf = (deg, c) => (deg[c] > 0 ? deg[c] : DEFAULT_DEG_MS[c]);
const priced = (p, deg, pitLossMs) => p.baseMs + DRY.reduce((t, c) => t + degOf(deg, c) * p.ageLaps[c], 0) + p.stops * pitLossMs;

// The best one-stop and two-stop totals under these wear rates and pit loss.
function bestByStops(plans, deg, pitLossMs) {
  const best = { 1: null, 2: null };
  for (const p of plans) {
    const totalMs = priced(p, deg, pitLossMs);
    if (!best[p.stops] || totalMs < best[p.stops].totalMs) best[p.stops] = { ...p, totalMs };
  }
  return best;
}

// sets: the player's Tyre Sets entries; deg: { [compound]: ms per lap of age }.
function racePlan({ totalLaps, pitLossMs, sets, deg = {} }) {
  if (!(totalLaps >= 3) || !(pitLossMs > 0) || !sets || !sets.length) return null;
  const best = bestByStops(candidates({ totalLaps, sets }), deg, pitLossMs);
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

// One stop or two, as odds: `samples` races, each with every compound's wear
// rate and the pit loss drawn from a normal around the estimate (degSd,
// pitLossSdMs: how well each is known), counting which plan wins. Seeded, so
// the same inputs give the same odds.
function planOdds({ totalLaps, pitLossMs, sets, deg = {} }, { degSd = {}, pitLossSdMs = 0, samples = 1000 } = {}) {
  if (!(totalLaps >= 3) || !(pitLossMs > 0) || !sets || !sets.length) return null;
  // Plans with the same wear shape differ only in their pace offsets, so only
  // the cheapest of each can ever win: ~5,800 plans become ~500.
  const shapes = new Map();
  for (const p of candidates({ totalLaps, sets })) {
    const key = `${p.stops}|${p.ageLaps[16]}|${p.ageLaps[17]}|${p.ageLaps[18]}`;
    const q = shapes.get(key);
    if (!q || p.baseMs < q.baseMs) shapes.set(key, p);
  }
  const plans = [...shapes.values()];
  let seed = 0x0dd5;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  let one = 0;
  let decided = 0;
  for (let i = 0; i < samples; i++) {
    const [d16, d17, d18] = DRY.map((c) => Math.max(1, degOf(deg, c) + (degSd[c] || 0) * gauss()));
    const loss = Math.max(0, pitLossMs + pitLossSdMs * gauss());
    let best1 = Infinity;
    let best2 = Infinity;
    for (const p of plans) {
      const t = p.baseMs + d16 * p.ageLaps[16] + d17 * p.ageLaps[17] + d18 * p.ageLaps[18] + p.stops * loss;
      if (p.stops === 1) best1 = Math.min(best1, t);
      else best2 = Math.min(best2, t);
    }
    if (best1 === Infinity && best2 === Infinity) continue;
    decided++;
    if (best1 <= best2) one++;
  }
  if (!decided) return null;
  const oneStopPct = Math.round((100 * one) / decided);
  return { oneStopPct, twoStopPct: 100 - oneStopPct, samples: decided };
}

// How widely planOdds draws each input, from where it came from: this
// session's fit (its 90% range is 3.29 standard deviations), earlier sessions
// at the track (their spread, at least 10%; one session 25%), or a default (40%).
// shortcut: the pit-loss spreads are judgement, not measured spreads; record
// stops at more tracks to measure them.
const PIT_LOSS_SD_MS = { measured: 1000, 'earlier races here': 1500 };
function planUncertainty({ fitted = {}, remembered = {}, lossSource }) {
  const degSd = {};
  for (const c of DRY) {
    const f = fitted[c];
    const r = remembered[c] || [];
    if (f && f.ciMs) degSd[c] = (f.ciMs[1] - f.ciMs[0]) / 3.29;
    else if (r.length >= 2) {
      const m = r.reduce((a, b) => a + b, 0) / r.length;
      const sorted = [...r].sort((a, b) => a - b);
      const med = sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      degSd[c] = Math.max(Math.sqrt(r.reduce((a, v) => a + (v - m) ** 2, 0) / (r.length - 1)), 0.1 * med);
    } else if (r.length === 1) degSd[c] = 0.25 * r[0];
    else degSd[c] = 0.4 * DEFAULT_DEG_MS[c];
  }
  return { degSd, pitLossSdMs: PIT_LOSS_SD_MS[lossSource] || 3000 };
}

const NAME = { 16: 'Soft', 17: 'Medium', 18: 'Hard' };
// "1 stop: Soft 14 laps, Medium 16 - box end of lap 14"
function planText(p) {
  const stints = p.stints.map((s, i) => `${NAME[s.compound]}${i < p.stints.length - 1 ? ` ${s.laps} laps` : ` ${s.laps}`}`).join(', ');
  return `${p.stops} stop${p.stops === 1 ? '' : 's'}: ${stints} - box end of lap ${p.boxLaps.join(' and ')}`;
}

module.exports = { racePlan, planOdds, planUncertainty, planText };
