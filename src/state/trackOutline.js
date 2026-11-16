// The track's outline for the map: your position (Motion) by distance round the lap, from one clean lap, kept per track
// in a small file. A bin per BINS-th of the lap holds the latest place you were there; when the lap ends the bins are the
// outline. A lap with a hole (the pit lane, a long stop) is not used, and an outline already kept is not redrawn: the
// first clean lap is as good as any, and a later spin or flashback must not bend it.
const fs = require('fs');

const BINS = 240;
const MIN_COVERAGE = 0.95;
const MIN_SPEED_KMH = 30;

function createOutlines({ file = null } = {}) {
  let kept = {};
  try {
    if (file && fs.existsSync(file)) kept = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    kept = {}; // a damaged file costs the maps, which draw again
  }
  let cur = null; // the lap being drawn: { trackId, length, bins, lastD }

  const fresh = (trackId, length) => ({ trackId, length, bins: new Array(BINS).fill(null), lastD: null });

  // The bins as a closed outline, holes filled between their neighbours; null if too much is missing.
  function close(bins) {
    const have = bins.map((b, i) => (b ? i : -1)).filter((i) => i >= 0);
    if (have.length < BINS * MIN_COVERAGE) return null;
    return bins.map((b, i) => {
      if (b) return b;
      let lo = i;
      while (!bins[lo]) lo = (lo - 1 + BINS) % BINS;
      let hi = i;
      while (!bins[hi]) hi = (hi + 1) % BINS;
      const span = (hi - lo + BINS) % BINS;
      const t = ((i - lo + BINS) % BINS) / span;
      return [bins[lo][0] + (bins[hi][0] - bins[lo][0]) * t, bins[lo][1] + (bins[hi][1] - bins[lo][1]) * t];
    }).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
  }

  function save() {
    if (!file) return;
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(kept));
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      console.warn(`[map] could not keep the track outline: ${err.message}`);
    }
  }

  // One look at the player: trackId, length (m), distance (m round the lap), x/z (world, m), speedKmh, inPit.
  function observe({ trackId, length, distance, x, z, speedKmh, inPit }) {
    if (trackId == null || !(length > 0) || !Number.isFinite(distance) || distance < 0 || !Number.isFinite(x) || !Number.isFinite(z)) return;
    if (!cur || cur.trackId !== trackId || cur.length !== length) cur = fresh(trackId, length);
    // Across the line: the lap just driven is complete.
    if (cur.lastD != null && distance < cur.lastD - length / 2) {
      if (!kept[trackId]) {
        const outline = close(cur.bins);
        if (outline) {
          kept[trackId] = outline;
          save();
        }
      }
      cur = fresh(trackId, length);
    }
    cur.lastD = distance;
    if (inPit || !(speedKmh >= MIN_SPEED_KMH)) return;
    cur.bins[Math.min(BINS - 1, Math.floor((distance / length) * BINS))] = [x, z];
  }

  const get = (trackId) => kept[trackId] || null;

  return { observe, get };
}

module.exports = { createOutlines, BINS };
