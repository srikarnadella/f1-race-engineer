// Post-race lap comparison on distance-aligned traces: where, and how, one
// lap lost time to another. Traces are [d, tMs, speed, throttle, brake,
// steer, gear] rows (see state/lapTrace.js), sampled by time, so they're
// first resampled onto a shared distance grid.

const STEP_M = 5;
const MINI_SECTORS = 25;
// Light braking counts too (Suzuka's flowing corners were missed at 0.3),
// but only if the car actually slows - a dab of brake isn't a corner.
const BRAKE_ON = 0.15;
const MIN_SPEED_DROP_KMH = 10;
const MATCH_WINDOW_M = 150; // the other lap's brake point must be this close to count as the same corner
const EXIT_AFTER_RELEASE_M = 100;
const COL = { d: 0, t: 1, speed: 2, throttle: 3, brake: 4, steer: 5, gear: 6 };

// Keep only forward-moving samples (a flashback can leave repeats).
function rising(points) {
  const out = [];
  for (const p of points) if (!out.length || p[COL.d] > out[out.length - 1][COL.d]) out.push(p);
  return out;
}

// Linear interpolation of every channel onto 0, STEP, 2*STEP ... up to `endD`.
function resample(points, endD) {
  const pts = rising(points);
  const n = Math.floor(endD / STEP_M) + 1;
  const out = { d: [], t: [], speed: [], throttle: [], brake: [], steer: [], gear: [] };
  let j = 0;
  for (let k = 0; k < n; k++) {
    const d = k * STEP_M;
    while (j < pts.length - 2 && pts[j + 1][COL.d] < d) j++;
    const a = pts[j];
    const b = pts[Math.min(j + 1, pts.length - 1)];
    const f = b[COL.d] === a[COL.d] ? 0 : Math.max(0, Math.min(1, (d - a[COL.d]) / (b[COL.d] - a[COL.d])));
    out.d.push(d);
    for (const key of ['t', 'speed', 'throttle', 'brake', 'steer']) out[key].push(a[COL[key]] + f * (b[COL[key]] - a[COL[key]]));
    out.gear.push(f < 0.5 ? a[COL.gear] : b[COL.gear]);
  }
  return out;
}

// Braking zones on a resampled lap: onset, release, and the slowest point.
function brakingZones(r) {
  const zones = [];
  let k = 0;
  while (k < r.d.length) {
    if (r.brake[k] >= BRAKE_ON && (k === 0 || r.brake[k - 1] < BRAKE_ON)) {
      let end = k;
      while (end < r.d.length - 1 && r.brake[end + 1] >= 0.05) end++;
      // The apex: slowest point from the brake to a little after release.
      const apexEnd = Math.min(r.d.length - 1, end + Math.round(60 / STEP_M));
      let apex = k;
      for (let m = k; m <= apexEnd; m++) if (r.speed[m] < r.speed[apex]) apex = m;
      if (r.speed[k] - r.speed[apex] >= MIN_SPEED_DROP_KMH) zones.push({ start: k, end, apex });
      k = end + 1;
    } else {
      k++;
    }
  }
  return zones;
}

const round = (v, dp = 0) => Math.round(v * 10 ** dp) / 10 ** dp;
const at = (arr, k) => arr[Math.max(0, Math.min(arr.length - 1, k))];

// Pairs each reference corner with the other lap's braking zone, mutual
// nearest only: at Suzuka a light brake 140 m before the hairpin on one lap
// otherwise "matched" the hairpin itself on the others.
function matchZones(refZones, refR, zones, r) {
  const nearest = (d, list, rr) => {
    let best = null;
    list.forEach((z, idx) => {
      const dist = Math.abs(rr.d[z.start] - d);
      if (dist <= MATCH_WINDOW_M && (!best || dist < best.dist)) best = { idx, dist };
    });
    return best ? best.idx : null;
  };
  return refZones.map((za, i) => {
    const j = nearest(refR.d[za.start], zones, r);
    if (j == null) return null;
    return nearest(r.d[zones[j].start], refZones, refR) === i ? zones[j] : null;
  });
}

// A is the reference (usually the best lap); B is the lap being explained.
function compareLaps(a, b) {
  const endD = Math.min(rising(a.points).pop()[COL.d], rising(b.points).pop()[COL.d]);
  const ra = resample(a.points, endD);
  const rb = resample(b.points, endD);
  const delta = ra.t.map((t, k) => (rb.t[k] - t) / 1000); // + = B slower so far

  const per = Math.max(1, Math.floor(ra.d.length / MINI_SECTORS));
  const miniSectors = [];
  for (let m = 0; m < MINI_SECTORS; m++) {
    const s = m * per;
    const e = m === MINI_SECTORS - 1 ? ra.d.length - 1 : Math.min(ra.d.length - 1, (m + 1) * per);
    miniSectors.push({ fromM: ra.d[s], toM: ra.d[e], deltaS: round(delta[e] - delta[s], 3) });
  }

  // Corner by corner: match each of A's braking zones to B's.
  const za0 = brakingZones(ra);
  const matched = matchZones(za0, ra, brakingZones(rb), rb);
  const corners = za0.map((za, i) => {
    const mb = matched[i];
    const from = Math.max(0, za.start - Math.round(80 / STEP_M));
    const to = Math.min(ra.d.length - 1, za.end + Math.round(EXIT_AFTER_RELEASE_M / STEP_M));
    const c = {
      corner: i + 1,
      atM: round(ra.d[za.start]),
      fromM: ra.d[from],
      toM: ra.d[to],
      timeS: round(delta[to] - delta[from], 3), // + = B lost time through this corner
      entryKmh: round(at(rb.speed, za.start) - at(ra.speed, za.start)),
      apexKmh: null,
      exitKmh: round(at(rb.speed, to) - at(ra.speed, to)),
      brakePointM: null, // + = B braked later
      refApexKmh: round(ra.speed[za.apex]),
    };
    if (mb) {
      c.brakePointM = round(rb.d[mb.start] - ra.d[za.start]);
      c.apexKmh = round(rb.speed[mb.apex] - ra.speed[za.apex]);
    }
    c.summary = describeCorner(c);
    return c;
  });

  const lost = corners.filter((c) => c.timeS >= 0.03).sort((x, y) => y.timeS - x.timeS);
  // Big losses away from any braking zone - contact, traffic, a moment on
  // a fast corner - would otherwise go unexplained.
  // A slice counts as "in a corner" when most of it lies inside a corner's
  // measured window (brake point -80 m to release +100 m).
  const inCorner = (m) => corners.some((c) => Math.min(m.toM, c.toM) - Math.max(m.fromM, c.fromM) > (m.toM - m.fromM) / 2);
  const offCorner = miniSectors.filter((m) => m.deltaS >= 0.25 && !inCorner(m)).sort((x, y) => y.deltaS - x.deltaS);
  const headline = [
    ...lost.map((c) => ({ s: c.timeS, text: c.summary })),
    ...offCorner.map((m) => ({ s: m.deltaS, text: `${(m.fromM / 1000).toFixed(1)}-${(m.toM / 1000).toFixed(1)} km: lost ${m.deltaS.toFixed(2)}s away from a braking zone - traffic, contact or a fast corner` })),
  ].sort((x, y) => y.s - x.s).slice(0, 3).map((h) => h.text);
  return {
    stepM: STEP_M,
    lapA: { lapNum: a.lapNum, lapMs: a.lapMs },
    lapB: { lapNum: b.lapNum, lapMs: b.lapMs },
    totalS: round(delta[delta.length - 1], 3),
    trace: {
      d: ra.d,
      delta: delta.map((v) => round(v, 3)),
      a: { speed: ra.speed.map((v) => round(v)), throttle: ra.throttle.map((v) => round(v, 2)), brake: ra.brake.map((v) => round(v, 2)), gear: ra.gear },
      b: { speed: rb.speed.map((v) => round(v)), throttle: rb.throttle.map((v) => round(v, 2)), brake: rb.brake.map((v) => round(v, 2)), gear: rb.gear },
    },
    miniSectors,
    corners,
    headline,
  };
}

// "Corner 3: lost 0.14s - braked 11 m earlier, 6 km/h slower at the apex"
function describeCorner(c) {
  const why = [];
  if (c.brakePointM != null && Math.abs(c.brakePointM) >= 5) why.push(`braked ${Math.abs(c.brakePointM)} m ${c.brakePointM < 0 ? 'earlier' : 'later'}`);
  if (c.apexKmh != null && Math.abs(c.apexKmh) >= 3) why.push(`${Math.abs(c.apexKmh)} km/h ${c.apexKmh < 0 ? 'slower' : 'faster'} at the apex`);
  if (Math.abs(c.exitKmh) >= 4) why.push(`${Math.abs(c.exitKmh)} km/h ${c.exitKmh < 0 ? 'down' : 'up'} on exit`);
  const verb = c.timeS >= 0 ? `lost ${c.timeS.toFixed(2)}s` : `gained ${Math.abs(c.timeS).toFixed(2)}s`;
  return `Corner ${c.corner} (${(c.atM / 1000).toFixed(1)} km): ${verb}${why.length ? ` - ${why.join(', ')}` : ''}`;
}

// Across all clean laps: how repeatable each corner is. A wide spread of
// braking points or apex speeds is time left on the table even when the
// best lap was fine.
function consistency(traces) {
  if (traces.length < 3) return [];
  const ends = traces.map((t) => rising(t.points).pop()[COL.d]);
  const endD = Math.min(...ends);
  const laps = traces.map((t) => resample(t.points, endD));
  const ref = laps[0];
  const refZones = brakingZones(ref);
  const sd = (xs) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };
  const matches = laps.map((r) => matchZones(refZones, ref, brakingZones(r), r));
  return refZones.map((za, i) => {
    const points = [];
    const apexes = [];
    laps.forEach((r, li) => {
      const z = matches[li][i];
      if (!z) return;
      points.push(r.d[z.start]);
      apexes.push(r.speed[z.apex]);
    });
    return {
      corner: i + 1,
      atM: round(ref.d[za.start]),
      laps: points.length,
      brakePointSdM: points.length >= 3 ? round(sd(points), 1) : null,
      apexSdKmh: apexes.length >= 3 ? round(sd(apexes), 1) : null,
    };
  });
}

module.exports = { compareLaps, consistency, resample, brakingZones, describeCorner, STEP_M };
