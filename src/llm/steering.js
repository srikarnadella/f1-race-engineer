// Oversteer and understeer from the steering you did (roadmap L8). The stored laps have your steering, speed
// and pedals every 5 m but no yaw or lateral load, and a car that slides shows in what the driver does about
// it: more lock for less speed through the same corner is understeer; a big catch of countersteer is
// oversteer, and whether it came on or off the throttle says which setting is involved.
//
// Read against your OWN usual at each corner (the median over your laps): a corner whose exit simply turns
// the other way isn't a slide. Only what repeats is called the car; once is a mistake. Calibrated on real
// races: laps flagged for understeer lost 0.14-1.0 s through the corner against about 0.1 for the rest, and
// 0.15 of lock is where a correction stops being ordinary line-to-line scatter (6-8% of corner-laps at 0.08,
// 2-8% at 0.16).
//
// The setup advice is only what the community guides agree on, as things to test: they disagree on the
// direction of the on-throttle differential and the anti-roll bars, so those are not told.
const { median } = require('../lib/stats');

const STEP_M = 5;
const COUNTER_EXTRA = 0.15; // lock of extra countersteer over your usual at that corner
const LOCK_EXTRA = 0.06; // lock of extra steering at the apex...
const SPEED_DOWN_KMH = 2; // ...with this much less speed through it
const POWER_THROTTLE = 0.3; // throttle at the peak of the catch that makes it "on the throttle"
const EXIT_M = 100; // how far after the apex a catch is looked for, and no further than the next corner's braking
const NEXT_GAP_M = 15;
const AFTER_APEX_M = 150; // time through a corner: from the braking point to this far after the apex
const MIN_LAPS = 5;
const MIN_REPEAT_LAPS = 2;
const REPEAT_SHARE = 0.25;
const MIN_LOSS_S = 0.1; // an understeer habit that costs less than this through the corner gets no setup advice (a catch costs grip and tyres even when the lap time hides it)
const MAX_ONE_OFFS = 3; // listed, biggest first
const NEAR_M = 150; // a wheel-slip flag this close to the apex is the same corner

const at = (r, m) => Math.max(0, Math.min(r.d.length - 1, Math.round(m / STEP_M)));
const list = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const s2 = (v) => v.toFixed(2);

// One lap through one corner: the lock at the apex, the biggest catch after it and the throttle then, the
// slowest speed around the apex, and the time from the braking point to just after the apex.
function lapThrough(r, corner, nextAtM) {
  const a = at(r, corner.apexAtM);
  let sum = 0;
  let n = 0;
  for (let k = Math.max(0, a - 3); k <= Math.min(r.d.length - 1, a + 3); k++) { sum += r.steer[k]; n++; }
  const mean = sum / n;
  const dir = Math.sign(mean) || 1;
  const end = at(r, Math.min(corner.apexAtM + EXIT_M, nextAtM - NEXT_GAP_M));
  let counter = 0;
  let counterAt = a;
  for (let k = a + 2; k <= end; k++) {
    const v = -dir * r.steer[k];
    if (v > counter) { counter = v; counterAt = k; }
  }
  let minV = Infinity;
  for (let k = Math.max(0, a - 6); k <= Math.min(r.d.length - 1, a + 6); k++) minV = Math.min(minV, r.speed[k]);
  return { lock: Math.abs(mean), counter, throttle: r.throttle[counterAt], minV, timeS: (r.t[at(r, corner.apexAtM + AFTER_APEX_M)] - r.t[at(r, corner.atM)]) / 1000 };
}

const KIND_NAME = { understeer: 'Understeer', oversteer_power: 'Oversteer on the throttle', oversteer_off: 'Oversteer off the throttle' };

// laps: [{ lap, r }] your racing laps with telemetry, r resampled every 5 m (d, t in ms, speed, throttle,
// brake, steer); corners: [{ corner, atM, apexAtM }] from your best lap; setting: { brake_bias,
// diff_on_throttle, diff_off_throttle }; issues: corner_issue rows (the wheel-slip data).
function analyzeSteering({ laps, corners, setting = {}, issues = [] }) {
  if (laps.length < MIN_LAPS) {
    return { enough: false, laps: laps.length, corners: [], advice: [], text: `Needs at least ${MIN_LAPS} laps with telemetry to tell a habit from a one-off; you have ${laps.length}.` };
  }
  const found = [];
  corners.forEach((corner, i) => {
    const next = corners[i + 1] ? corners[i + 1].atM : Infinity;
    const rows = laps.map(({ lap, r }) => ({ lap, ...lapThrough(r, corner, next) }));
    const usual = { lock: median(rows.map((x) => x.lock)), counter: median(rows.map((x) => x.counter)), minV: median(rows.map((x) => x.minV)), timeS: median(rows.map((x) => x.timeS)) };
    const flags = { understeer: [], oversteer_power: [], oversteer_off: [] };
    for (const x of rows) {
      if (x.lock - usual.lock >= LOCK_EXTRA && usual.minV - x.minV >= SPEED_DOWN_KMH) flags.understeer.push(x);
      if (x.counter - usual.counter >= COUNTER_EXTRA) (x.throttle >= POWER_THROTTLE ? flags.oversteer_power : flags.oversteer_off).push(x);
    }
    const summary = (xs, kind) => {
      const mean = (f) => (xs.length ? xs.reduce((a, x) => a + f(x), 0) / xs.length : 0);
      return {
        laps: xs.map((x) => x.lap),
        extra: kind === 'understeer' ? mean((x) => x.lock - usual.lock) : mean((x) => x.counter - usual.counter),
        slower_kmh: kind === 'understeer' ? mean((x) => usual.minV - x.minV) : 0,
        throttle_pct: Math.round(mean((x) => x.throttle) * 100),
        lost_s: Math.max(0, +mean((x) => x.timeS - usual.timeS).toFixed(2)),
      };
    };
    const entry = { corner: corner.corner, at_km: +(corner.apexAtM / 1000).toFixed(1), apexAtM: corner.apexAtM, habits: [], one_offs: [] };
    for (const kind of Object.keys(flags)) {
      entry[kind] = summary(flags[kind], kind);
      const n = flags[kind].length;
      if (n >= MIN_REPEAT_LAPS && n / laps.length >= REPEAT_SHARE) entry.habits.push(kind);
      else if (n) for (const x of flags[kind]) entry.one_offs.push({ lap: x.lap, kind, extra: kind === 'understeer' ? x.lock - usual.lock : x.counter - usual.counter });
    }
    if (entry.habits.length || entry.one_offs.length) found.push(entry);
  });

  // The wheel-slip data (Motion Ex) agreeing, on the same lap near the same corner.
  const agrees = (entry, kind) => {
    const want = kind === 'understeer' ? ['understeer'] : ['wheelspin', 'rear_lock'];
    return issues.filter((x) => want.includes(x.kind) && entry[kind].laps.includes(x.lap_num) && Math.abs(x.distance_m - entry.apexAtM) <= NEAR_M);
  };

  const lines = [];
  for (const e of found) {
    for (const kind of e.habits) {
      const s = e[kind];
      const small = kind === 'understeer' && s.lost_s < MIN_LOSS_S ? ', too little to chase' : '';
      const lost = s.lost_s > 0.01 ? `; those laps lost ${s2(s.lost_s)} s through the corner${small}` : kind === 'understeer' ? '; too little to chase' : '';
      if (kind === 'understeer') {
        lines.push(`${KIND_NAME[kind]}, corner ${e.corner} (${e.at_km} km): on laps ${list(s.laps)} you needed ${s2(s.extra)} more steering lock than usual and carried ${s.slower_kmh.toFixed(0)} km/h less speed through the apex${lost}.`);
      } else {
        lines.push(`${KIND_NAME[kind]}, corner ${e.corner} (${e.at_km} km): on laps ${list(s.laps)} you caught a slide with ${s2(s.extra)} more countersteer than usual (your throttle was ${s.throttle_pct}% at the peak)${lost}.`);
      }
      const hit = agrees(e, kind);
      if (hit.length) lines.push(`The wheel-slip data agrees: ${[...new Set(hit.map((x) => x.kind.replace('_', ' ')))].join(' and ')} on lap ${list([...new Set(hit.map((x) => x.lap_num))])} at that corner.`);
    }
  }
  const oneOffs = found.flatMap((e) => e.one_offs.map((o) => ({ ...o, corner: e.corner }))).sort((a, b) => b.extra - a.extra);
  if (oneOffs.length) {
    const shown = oneOffs.slice(0, MAX_ONE_OFFS).map((o) => `lap ${o.lap} corner ${o.corner} (${o.kind.replace('_', ' ')})`);
    const more = oneOffs.length - MAX_ONE_OFFS;
    lines.push(`One-offs (once, so probably driving rather than the car): ${shown.join('; ')}${more > 0 ? ` and ${more} more` : ''}.`);
  }

  // Advice, once per kind of problem, from what the guides agree on.
  const advice = [];
  const now = (key, label) => (Number.isFinite(setting[key]) ? ` (now ${setting[key]}%)` : '');
  const habitCorners = (kind) => found.filter((e) => e.habits.includes(kind) && (kind !== 'understeer' || e[kind].lost_s >= MIN_LOSS_S));
  const cornersOf = (kind) => list(habitCorners(kind).map((e) => String(e.corner)));
  if (habitCorners('understeer').length) {
    advice.push(`Understeer (corner ${cornersOf('understeer')}): more front wing, or less rear wing, adds front grip in the middle of the corner.`);
    advice.push(`A lower off-throttle diff${now('diff_off_throttle')} helps the car rotate on the way in; a higher one keeps it straighter.`);
    advice.push('Driving first: brake a little earlier and release the brake more gradually; understeer from too much speed on entry is a driving fix before a setup one.');
  }
  if (habitCorners('oversteer_power').length) {
    const thr = Math.round(habitCorners('oversteer_power').reduce((a, e) => a + e.oversteer_power.throttle_pct, 0) / habitCorners('oversteer_power').length);
    advice.push(`Oversteer on the throttle (corner ${cornersOf('oversteer_power')}): more rear wing steadies the car under power.`);
    advice.push(`The guides disagree on which way the on-throttle diff${now('diff_on_throttle')} helps here, so test one step each way, one at a time, and keep the one that is quicker.`);
    advice.push(`Driving: ease the throttle in more gently; it was already at ${thr}% when the rear stepped out.`);
  }
  if (habitCorners('oversteer_off').length) {
    advice.push(`Oversteer off the throttle (corner ${cornersOf('oversteer_off')}): a higher off-throttle diff${now('diff_off_throttle')} keeps the rear steadier on lift-off and under braking; a lower one lets it rotate.`);
    const rear = issues.filter((x) => x.kind === 'rear_lock' && habitCorners('oversteer_off').some((e) => e.oversteer_off.laps.includes(x.lap_num) && Math.abs(x.distance_m - e.apexAtM) <= NEAR_M * 2));
    if (rear.length) advice.push(`A rear wheel also locked on lap ${list([...new Set(rear.map((x) => x.lap_num))])} there: the brake bias may be too far back.`);
  }

  const settingLine = ['brake_bias', 'diff_on_throttle', 'diff_off_throttle'].some((k) => Number.isFinite(setting[k]))
    ? `Your setup in this session: ${[['brake_bias', 'brake bias'], ['diff_on_throttle', 'on-throttle diff'], ['diff_off_throttle', 'off-throttle diff']].filter(([k]) => Number.isFinite(setting[k])).map(([k, n]) => `${n} ${setting[k]}%`).join(', ')}.`
    : '';
  const head = lines.length ? `Handling from your steering over ${laps.length} laps (against your own usual at each corner):` : `No corner showed steering out of the ordinary over ${laps.length} laps: no repeated extra steering lock with less speed (understeer) and no big extra corrections (oversteer). This reads your steering, not the car's yaw, so a slide you caught early can slip through.`;
  const caution = advice.length ? 'These are starting points. The guides disagree on some directions, so change one thing at a time, by one or two clicks, and compare three laps before keeping it.' : '';
  const text = [head, ...lines, ...(advice.length ? ['What to try:', ...advice.map((a) => `- ${a}`)] : []), settingLine, caution].filter(Boolean).join('\n');
  return { enough: true, laps: laps.length, corners: found, advice, text };
}

module.exports = { analyzeSteering };
