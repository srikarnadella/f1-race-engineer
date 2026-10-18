#!/usr/bin/env node
// Fills the race store (data/race.db, see src/data/store.js) from the raw
// captures: each one replayed through the real pipeline on its own clock,
// every session in it written as it ends. Safe to re-run: a session already
// in the store is replaced, not duplicated. The live bridge adds new
// sessions to the same file as they finish.
//
//   npm run db [-- capture-folder ...]   (default: every folder in captures/)
const path = require('path');
const { readLog } = require('../src/capture/logFile');
const { createPipeline } = require('../src/pipeline');
const { captureFiles } = require('../src/data/captures');
const { openStore } = require('../src/data/store');

const ROOT = path.resolve(__dirname, '..');
const DB_FILE = path.join(ROOT, 'data', 'race.db');
const TICK_EVERY_MS = 100; // the engine ticks at 10 Hz live

async function main() {
  const files = captureFiles(ROOT, process.argv.slice(2));
  if (!files.length) {
    console.error('No captures found - record races with `npm run capture` first.');
    process.exit(1);
  }
  require('fs').mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const store = openStore(DB_FILE);
  const warn = console.warn;
  for (const f of files) {
    const captureName = path.basename(path.dirname(f));
    let t = 0;
    let lastTick = -Infinity;
    console.warn = () => {}; // odd packets are the analyzer's business, not this one's
    const pipeline = createPipeline({ now: () => t, store, captureName });
    for await (const { tMs, buf } of readLog(f)) {
      t = tMs;
      pipeline.feed(buf);
      if (tMs - lastTick >= TICK_EVERY_MS) {
        lastTick = tMs;
        pipeline.tick();
      }
    }
    pipeline.flush();
    console.warn = warn;
    const sessions = store.db.prepare(`SELECT session_name, track, (SELECT count(*) FROM lap l WHERE l.session_id = s.session_id) laps
      FROM session s JOIN capture USING (capture_id) WHERE capture.name = ? ORDER BY started_at_ms`).all(captureName);
    console.log(`  ${captureName}: ${sessions.map((s) => `${s.track} ${s.session_name} (${s.laps} laps)`).join(', ') || 'no sessions'}`);
  }
  const count = (table) => store.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
  console.log(`\n${count('session')} sessions, ${count('lap')} laps, ${count('event')} events, ${count('trace_point')} trace points -> ${path.relative(ROOT, DB_FILE)}`);
  store.db.pragma('optimize');
  store.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
