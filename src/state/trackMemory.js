// What earlier races at a track measured - the pit loss, the tyre age share
// and wear the AI boxed at - so the second race at a track starts from the
// first one's numbers instead of a guess. One small JSON file in data/
// (gitignored); null file = remember nothing (replays, tests).
//
// Each sample remembers the session it came from ({ v, s } in the file), so deleting a race can take
// what it taught with it (forget). A plain number is a sample from before that: it has no session, so it stays.

const fs = require('fs');
const path = require('path');

const KEEP_PER_TRACK = 20; // the latest samples of each kind

function createTrackMemory(file = null) {
  let byTrack = {};
  if (file && fs.existsSync(file)) {
    try {
      // A list of points is a map outline an older Undercut kept here (state/trackOutline.js), not a memory.
      byTrack = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')) || {}).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)));
    } catch (err) {
      // Set aside, not overwritten by the next save: it may be fixable by hand.
      const aside = `${file}.unreadable-${Date.now()}`;
      try {
        fs.renameSync(file, aside);
      } catch (_) { /* leave it; the next save replaces it */ }
      console.warn(`[memory] ${file} was unreadable (${err.message}) - moved to ${aside}, starting fresh`);
    }
  }

  const valueOf = (x) => (typeof x === 'object' && x ? x.v : x);
  const get = (trackId, kind) => ((byTrack[trackId] && byTrack[trackId][kind]) || []).map(valueOf);

  // Every sample's value, by track and kind.
  const all = () => Object.fromEntries(Object.entries(byTrack).map(([t, kinds]) => [t, Object.fromEntries(Object.entries(kinds).map(([k, xs]) => [k, xs.map(valueOf)]))]));

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Write then rename, so a crash mid-write can't leave a half-written file.
      fs.writeFileSync(file + '.tmp', JSON.stringify(byTrack));
      fs.renameSync(file + '.tmp', file);
    } catch (err) {
      console.warn(`[memory] could not save: ${err.message}`);
    }
  }

  function add(trackId, kind, value, sessionUid = null) {
    if (trackId == null || !Number.isFinite(value)) return;
    const track = (byTrack[trackId] = byTrack[trackId] || {});
    track[kind] = [...(track[kind] || []), sessionUid == null ? value : { v: value, s: String(sessionUid) }].slice(-KEEP_PER_TRACK);
    save();
  }

  // Drops every sample that session taught, at every track. Returns how many went.
  function forget(sessionUid) {
    if (sessionUid == null) return 0;
    const uid = String(sessionUid);
    let gone = 0;
    for (const [trackId, kinds] of Object.entries(byTrack)) {
      for (const [kind, xs] of Object.entries(kinds)) {
        const kept = xs.filter((x) => !(typeof x === 'object' && x && x.s === uid));
        gone += xs.length - kept.length;
        if (kept.length) kinds[kind] = kept;
        else delete kinds[kind];
      }
      if (!Object.keys(kinds).length) delete byTrack[trackId];
    }
    if (gone) save();
    return gone;
  }

  return { get, add, forget, all };
}

module.exports = { createTrackMemory };
