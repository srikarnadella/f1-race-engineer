// What earlier races at a track measured - the pit loss, the tyre age share
// and wear the AI boxed at - so the second race at a track starts from the
// first one's numbers instead of a guess. One small JSON file in data/
// (gitignored); null file = remember nothing (replays, tests).

const fs = require('fs');
const path = require('path');

const KEEP_PER_TRACK = 20; // the latest samples of each kind

function createTrackMemory(file = null) {
  let byTrack = {};
  if (file && fs.existsSync(file)) {
    try {
      byTrack = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      // Set aside, not overwritten by the next save: it may be fixable by hand.
      const aside = `${file}.unreadable-${Date.now()}`;
      try {
        fs.renameSync(file, aside);
      } catch (_) { /* leave it; the next save replaces it */ }
      console.warn(`[memory] ${file} was unreadable (${err.message}) - moved to ${aside}, starting fresh`);
    }
  }

  const get = (trackId, kind) => (byTrack[trackId] && byTrack[trackId][kind]) || [];

  function add(trackId, kind, value) {
    if (trackId == null || !Number.isFinite(value)) return;
    const track = (byTrack[trackId] = byTrack[trackId] || {});
    track[kind] = [...(track[kind] || []), value].slice(-KEEP_PER_TRACK);
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(byTrack));
    } catch (err) {
      console.warn(`[memory] could not save: ${err.message}`);
    }
  }

  return { get, add };
}

module.exports = { createTrackMemory };
