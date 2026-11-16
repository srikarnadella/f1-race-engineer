// Reads recorded captures into the race store: each one replayed through the real pipeline on its own clock, every session in
// it written as it ends. Shared by `npm run db` (scripts/build-db.js) and the desktop app's "read setups from my recordings"
// (desktop/ingestWorker.js). Safe to run again: a session already in the store is replaced, not duplicated, and the names and
// stars in setup_note are in their own table, so they stay.
const path = require('path');
const { readLog } = require('../capture/logFile');
const { createPipeline } = require('../pipeline');

const TICK_EVERY_MS = 100; // the engine ticks at 10 Hz live

// file: a packet log (.f1log or .f1log.gz); store: an open race store. Returns the sessions it wrote.
async function ingestCapture({ file, store, captureName = path.basename(path.dirname(file)) }) {
  let t = 0;
  let lastTick = -Infinity;
  const warn = console.warn;
  console.warn = () => {}; // odd packets are the analyzer's business, not this one's
  try {
    const pipeline = createPipeline({ now: () => t, store, captureName });
    for await (const { tMs, buf } of readLog(file)) {
      t = tMs;
      pipeline.feed(buf);
      if (tMs - lastTick >= TICK_EVERY_MS) {
        lastTick = tMs;
        pipeline.tick();
      }
    }
    pipeline.flush();
  } finally {
    console.warn = warn;
  }
  return store.db.prepare(`SELECT session_name, track, (SELECT count(*) FROM lap l WHERE l.session_id = s.session_id) laps
    FROM session s JOIN capture USING (capture_id) WHERE capture.name = ? ORDER BY started_at_ms`).all(captureName).map((s) => ({ name: String(s.session_name), track: String(s.track), laps: Number(s.laps) }));
}

module.exports = { ingestCapture };
