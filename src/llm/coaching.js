// Coaching rules for Ask the race: what to change, corner by corner, from the telemetry, each with
// the number it rests on. The engine decides; the model only explains. Rules of thumb from
// comparing a lap with your own best lap, not an optimiser: your best lap shows what you can do.
const MIN_LOSS_S = 0.03; // less than this through a corner isn't worth a word
const CANDIDATES = 3; // lift-and-coast suggestions

// corners: lapCompare's, for lap `lap` against your best lap `best` (+ = this lap lost / later).
function adviseCorners(corners, { best, lap }) {
  const out = [];
  for (const c of corners) {
    if (!(c.timeS >= MIN_LOSS_S)) continue;
    const tips = [];
    if (c.brakePointM != null && c.brakePointM <= -8 && !(c.apexKmh > 3)) tips.push(`brake ${Math.abs(c.brakePointM)} m later, as on lap ${best}`);
    if (c.apexKmh != null && c.apexKmh <= -4) tips.push(`carry ${Math.abs(c.apexKmh)} km/h more to the apex (${c.refApexKmh} km/h on lap ${best})`);
    if (c.throttleM != null && c.throttleM >= 10) tips.push(`get to full throttle ${c.throttleM} m sooner after the apex`);
    if (c.coastM != null && c.coastM - (c.refCoastM || 0) >= 20) tips.push(`you coasted ${c.coastM} m before braking; keep the throttle open to the brake point`);
    if (!tips.length && c.exitKmh <= -4) tips.push(`your exit was ${Math.abs(c.exitKmh)} km/h down: a straighter, earlier throttle on the way out`);
    if (!tips.length) continue;
    out.push({ corner: c.corner, atKm: +(c.atM / 1000).toFixed(1), lostS: +c.timeS.toFixed(2), text: `Corner ${c.corner} (${(c.atM / 1000).toFixed(1)} km), ${c.timeS.toFixed(2)} s lost on lap ${lap}: ${tips.join('; ')}.` });
  }
  return out.sort((a, b) => b.lostS - a.lostS);
}

// Lift and coast saves fuel where the engine has been working longest: the braking zones after
// the longest flat-out runs. zones: lapCorners' for one lap.
function liftAndCoast(zones, { lap, fuelPerLapKg = null }) {
  const candidates = [...zones].sort((a, b) => b.flatOutM - a.flatOutM).slice(0, CANDIDATES).sort((a, b) => a.atM - b.atM).map((z) => ({
    corner: z.corner,
    atKm: +(z.atM / 1000).toFixed(1),
    flatOutM: z.flatOutM,
    text: `Corner ${z.corner} (${(z.atM / 1000).toFixed(1)} km): ${z.flatOutM} m flat out before it, braking from ${z.entryKmh} km/h; ${z.coastM >= 10 ? `you already coast ${z.coastM} m there` : 'you coast 0 m there now'}.`,
  }));
  const coasting = zones.filter((z) => z.coastM >= 10);
  return {
    lap,
    candidates,
    summary: `${fuelPerLapKg != null ? `You used ${fuelPerLapKg.toFixed(1)} kg a lap. ` : ''}On lap ${lap} you coasted before ${coasting.length ? coasting.map((z) => `corner ${z.corner} (${z.coastM} m)`).join(', ') : 'no corner'}. To save fuel, lift before the braking zones after the longest flat-out runs: the corners below. Each lift costs a little time, so only where you need the fuel.`,
  };
}

// Brake bias and differential, from what the car did at each corner (the race store's corner_issue
// rows) and the settings at the time. The live suggestions' rules (engine/adjustments.js): fronts
// locking -> bias rearward, rears locking -> forward, wheelspin on exit -> raise the on-throttle diff,
// understeer on exit -> lower it. Once is a mistake; a third of the laps or more is the car.
const BIAS_STEP = 2;
const BIAS_RANGE = [50, 70];
const DIFF_STEP = 5;
const DIFF_RANGE = [10, 100];
const BASE_BIAS_CORNERS = 3;
const MATCH_M = 200;
/** @param {number} v @param {number[]} range */
const clamp = (v, range) => Math.max(range[0], Math.min(range[1], v));
const mode = (xs) => {
  const n = new Map();
  for (const x of xs) if (x != null) n.set(x, (n.get(x) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

// rows: corner_issue rows; corners: lapCorners' (for corner numbers); racingLaps: laps driven at pace.
function balanceAdvice(rows, { corners = [], racingLaps, bias = null, diff = null }) {
  const nearest = (d) => corners.reduce((a, c) => (Math.abs(c.atM - d) <= MATCH_M && (!a || Math.abs(c.atM - d) < Math.abs(a.atM - d)) ? c : a), null);
  const byCorner = new Map();
  for (const r of rows) {
    const c = nearest(r.distance_m);
    const key = c ? `c${c.corner}` : `d${Math.round(r.distance_m / 100)}`;
    if (!byCorner.has(key)) byCorner.set(key, { corner: c ? c.corner : null, atM: c ? c.atM : r.distance_m, kinds: new Map() });
    const entry = byCorner.get(key);
    if (!entry.kinds.has(r.kind)) entry.kinds.set(r.kind, { kind: r.kind, laps: new Set(), wheels: [], bias: [], diff: [] });
    const k = entry.kinds.get(r.kind);
    k.laps.add(r.lap_num);
    k.wheels.push(r.wheel);
    k.bias.push(r.brake_bias);
    k.diff.push(r.diff_on_throttle);
  }
  const list = [...byCorner.values()].sort((a, b) => a.atM - b.atM);
  const where = (e) => (e.corner != null ? `corner ${e.corner}` : `the corner at ${(e.atM / 1000).toFixed(1)} km`);
  const often = (k) => k.laps.size >= 2 && k.laps.size / Math.max(1, racingLaps) >= 1 / 3;
  const of = (k) => `on ${k.laps.size} of ${racingLaps} laps`;

  const advice = [];
  const frontCorners = list.filter((e) => e.kinds.has('front_lock') && often(e.kinds.get('front_lock')));
  if (frontCorners.length >= BASE_BIAS_CORNERS) {
    const b = mode(frontCorners.flatMap((e) => e.kinds.get('front_lock').bias)) ?? bias;
    if (b != null) advice.push(`The fronts lock at ${frontCorners.length} corners (${frontCorners.map(where).join(', ')}) with the bias at ${b}%: move the base brake bias rearward, ${b} to ${clamp(b - BIAS_STEP, BIAS_RANGE)}%.`);
  }
  for (const e of list) {
    for (const k of e.kinds.values()) {
      if (!often(k)) continue;
      const b = mode(k.bias) ?? bias;
      const d = mode(k.diff) ?? diff;
      const wheel = mode(k.wheels);
      if (k.kind === 'front_lock' && frontCorners.length < BASE_BIAS_CORNERS && b != null) advice.push(`${wheel || 'The fronts'} locks into ${where(e)} ${of(k)} with the bias at ${b}%: move the brake bias rearward there, ${b} to ${clamp(b - BIAS_STEP, BIAS_RANGE)}% (or brake a little softer).`);
      if (k.kind === 'rear_lock' && b != null) advice.push(`${wheel || 'The rears'} locks into ${where(e)} ${of(k)} with the bias at ${b}%: move the brake bias forward there, ${b} to ${clamp(b + BIAS_STEP, BIAS_RANGE)}%.`);
      if (k.kind === 'wheelspin' && d != null) advice.push(`Wheelspin out of ${where(e)} ${of(k)} with the on-throttle diff at ${d}%: raise the on-throttle diff, ${d} to ${clamp(d + DIFF_STEP, DIFF_RANGE)}% (or squeeze the throttle in later).`);
      if (k.kind === 'understeer' && d != null) advice.push(`Understeer out of ${where(e)} ${of(k)} with the on-throttle diff at ${d}%: lower the on-throttle diff, ${d} to ${clamp(d - DIFF_STEP, DIFF_RANGE)}%.`);
    }
  }
  return {
    racingLaps,
    corners: list.map((e) => ({ corner: e.corner, atKm: +(e.atM / 1000).toFixed(1), issues: [...e.kinds.values()].map((k) => ({ kind: k.kind, wheel: mode(k.wheels), laps: [...k.laps].sort((x, y) => x - y) })) })),
    advice,
  };
}

// The battery round one lap, from the telemetry's charge (% of the 4 MJ store): where it was used
// and where it came back, the low point, what was left at the line, and rules on top: an empty
// battery, laps ending with more than they started, and the longest flat-out run getting less than a
// shorter one. points: [d, t, speed, throttle, brake, steer, gear, ersPct, ersMode]; zones: lapCorners'.
const TREND_M = 50; // the charge read every 50 m
const MIN_SWING = 3; // a use or a gain under 3 points of charge isn't worth a line
function batteryLap(points, zones, { lap }) {
  const pts = points.filter((p) => p[7] != null);
  if (pts.length < 10) return { error: `No battery data on lap ${lap}: it was saved before Undercut kept the battery in the lap telemetry.` };
  const at = (d) => {
    let best = pts[0];
    for (const p of pts) if (Math.abs(p[0] - d) < Math.abs(best[0] - d)) best = p;
    return best[7];
  };
  const endD = pts[pts.length - 1][0];
  const grid = [];
  for (let d = pts[0][0]; d <= endD; d += TREND_M) grid.push([d, at(d)]);
  // Runs of falling (deploying) or rising (harvesting) charge; a flat stretch keeps the run going.
  const runs = [];
  let cur = null;
  for (let k = 1; k < grid.length; k++) {
    const diff = grid[k][1] - grid[k - 1][1];
    const dir = Math.abs(diff) < 0.2 ? 0 : Math.sign(diff);
    if (cur && (dir === 0 || dir === cur.dir)) {
      if (dir) cur.to = k;
      continue;
    }
    if (dir === 0) continue;
    cur = { dir, from: k - 1, to: k };
    runs.push(cur);
  }
  const seg = (r) => ({ fromKm: +(grid[r.from][0] / 1000).toFixed(1), toKm: +(grid[r.to][0] / 1000).toFixed(1), pct: +Math.abs(grid[r.to][1] - grid[r.from][1]).toFixed(0) });
  const deployed = runs.filter((r) => r.dir < 0).map(seg).filter((s) => s.pct >= MIN_SWING);
  const harvested = runs.filter((r) => r.dir > 0).map(seg).filter((s) => s.pct >= MIN_SWING);
  const startPct = Math.round(pts[0][7]);
  const endPct = Math.round(pts[pts.length - 1][7]);
  const low = pts.reduce((a, p) => (p[7] < a[7] ? p : a));

  const advice = [];
  const empty = pts.find((p) => p[7] <= 1);
  if (empty) advice.push(`You ran the battery empty at ${(empty[0] / 1000).toFixed(1)} km on lap ${lap}: keep some back for the longest straights, where an empty battery costs the most, and deploy less on the short ones.`);
  if (endPct - startPct >= 10 && endPct >= 50) advice.push(`You ended the lap with ${endPct}% having started with ${startPct}%: you can deploy more, on the longest straights first.`);
  // Each flat-out run before a braking zone: how much of the battery it used.
  const runsBefore = zones.filter((z) => z.flatOutM >= 150).map((z) => ({ ...z, used: Math.round(at(z.atM - z.flatOutM) - at(z.atM)) }));
  const longest = [...runsBefore].sort((a, b) => b.flatOutM - a.flatOutM)[0];
  const better = longest && runsBefore.filter((z) => z !== longest && z.used - longest.used >= 8).sort((a, b) => b.used - a.used)[0];
  if (longest && better && longest.used < 5) {
    advice.push(`Before corner ${longest.corner} (${longest.flatOutM} m flat out, the longest run) you used ${Math.max(0, longest.used)}% of the battery, but before corner ${better.corner} (${better.flatOutM} m) ${better.used}%: move some of it to the longer straight.`);
  }
  return {
    lap, startPct, endPct, lowestPct: Math.round(low[7]), lowestAtKm: +(low[0] / 1000).toFixed(1),
    deployed, harvested,
    straights: runsBefore.map((z) => ({ corner: z.corner, flatOutM: z.flatOutM, usedPct: z.used })),
    advice,
  };
}

module.exports = { adviseCorners, liftAndCoast, balanceAdvice, batteryLap };
