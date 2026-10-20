// Live delta to the player's personal best lap AND to their previous lap,
// plus live mini-sectors, the way an in-car delta bar works: record
// (lapDistance -> currentLapTime) through each lap; a complete, valid lap
// that beats the best becomes the best reference; every complete lap becomes
// the "previous lap" reference. The live delta is "my time at this point"
// minus the reference's time at this point.
const SAMPLE_EVERY_M = 10;
// A trace that didn't start near the line (joined mid-lap, flashback, demo
// starting part-way round) can't be a reference lap.
const MAX_START_DISTANCE_M = 50;
const FLASHBACK_REWIND_M = 30;
const MINI_SECTORS = 25;

function timeAtDistance(ref, d) {
  if (!ref || !ref.length || d < ref[0].d) return null;
  let lo = 0;
  let hi = ref.length - 1;
  if (d >= ref[hi].d) return ref[hi].tMs;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ref[mid].d <= d) lo = mid;
    else hi = mid;
  }
  const a = ref[lo];
  const b = ref[hi];
  return a.tMs + ((d - a.d) / (b.d - a.d)) * (b.tMs - a.tMs);
}

// Each mini-sector's time on a whole lap trace (25 equal slices).
function splitsOf(trace, trackLength, lapTimeMs) {
  const out = [];
  let prev = 0;
  for (let k = 1; k <= MINI_SECTORS; k++) {
    const t = k === MINI_SECTORS ? lapTimeMs : timeAtDistance(trace, (k * trackLength) / MINI_SECTORS);
    if (t == null) return null;
    out.push(t - prev);
    prev = t;
  }
  return out;
}

function createLapDeltaTracker() {
  let trace = []; // [{ d, tMs }] for the lap in progress, ascending d
  let traceValid = false;
  let best = null; // { lapTimeMs, trace }
  let last = null; // the previous complete lap: { lapTimeMs, trace }
  let bestSplits = null; // best time per mini-sector across complete laps
  let lastSplits = null;
  let lapNum = null;
  let trackLength = null;

  function update(lap, trackLengthM) {
    if (trackLengthM) trackLength = trackLengthM;
    if (lapNum !== null && lap.currentLapNum !== lapNum) {
      // Lap just completed (forwards only - a flashback back across the line
      // isn't a lap): it's the new "previous lap", and the best if it's quickest.
      if (lap.currentLapNum > lapNum && traceValid && lap.lastLapTimeInMS > 0) {
        last = { lapTimeMs: lap.lastLapTimeInMS, trace };
        if (!best || lap.lastLapTimeInMS < best.lapTimeMs) best = last;
        lastSplits = trackLength ? splitsOf(trace, trackLength, lap.lastLapTimeInMS) : null;
        if (lastSplits) bestSplits = bestSplits ? bestSplits.map((b, k) => Math.min(b, lastSplits[k])) : lastSplits.slice();
      }
      trace = [];
      traceValid = false;
    }
    lapNum = lap.currentLapNum;

    if (lap.lapDistance < 0) return; // before the line on a standing start
    // A flashback rewinds within the lap: the trace beyond this point is
    // from the abandoned timeline, so drop it and record the re-run.
    const tail = trace[trace.length - 1];
    if (tail && lap.lapDistance < tail.d - FLASHBACK_REWIND_M) trace = trace.filter((p) => p.d <= lap.lapDistance);
    if (!trace.length) traceValid = lap.lapDistance <= MAX_START_DISTANCE_M;
    if (lap.currentLapInvalid || lap.pitStatus !== 0) traceValid = false;

    const lastPoint = trace[trace.length - 1];
    if (!lastPoint || lap.lapDistance - lastPoint.d >= SAMPLE_EVERY_M) {
      trace.push({ d: lap.lapDistance, tMs: lap.currentLapTimeInMS });
    }
  }

  // The current lap's completed mini-sectors, each rated against your best
  // for that slice ('pb'), your previous lap ('faster' / 'slower').
  function liveMiniSectors(lap) {
    if (!trackLength || !lap || !(lap.lapDistance >= 0)) return null;
    const done = Math.min(MINI_SECTORS, Math.floor(lap.lapDistance / (trackLength / MINI_SECTORS)));
    const cells = [];
    let prevT = 0;
    for (let k = 0; k < MINI_SECTORS; k++) {
      if (k >= done) {
        cells.push({ state: k === done ? 'current' : null });
        continue;
      }
      const t = timeAtDistance(trace, ((k + 1) * trackLength) / MINI_SECTORS);
      const split = t != null && prevT != null ? t - prevT : null;
      prevT = t;
      let state = 'none';
      if (split != null && bestSplits) state = split <= bestSplits[k] ? 'pb' : lastSplits && split < lastSplits[k] ? 'faster' : 'slower';
      cells.push({ state, vsLastMs: split != null && lastSplits ? Math.round(split - lastSplits[k]) : null });
    }
    return cells;
  }

  function current(lap) {
    const out = { bestLapTimeInMS: best ? best.lapTimeMs : null, deltaToBestMs: null, previousLapTimeInMS: last ? last.lapTimeMs : null, deltaToLastMs: null, miniSectors: null };
    // In the pits / garage the timer and the distance don't describe a lap being driven.
    if (!lap || lap.pitStatus || !(lap.currentLapTimeInMS > 0)) return out;
    const refBest = best && timeAtDistance(best.trace, lap.lapDistance);
    const refLast = last && timeAtDistance(last.trace, lap.lapDistance);
    if (refBest != null) out.deltaToBestMs = Math.round(lap.currentLapTimeInMS - refBest);
    if (refLast != null) out.deltaToLastMs = Math.round(lap.currentLapTimeInMS - refLast);
    out.miniSectors = liveMiniSectors(lap);
    return out;
  }

  return { update, current };
}

module.exports = { createLapDeltaTracker, MINI_SECTORS };
