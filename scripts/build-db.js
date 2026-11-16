#!/usr/bin/env node
// Fills the race store (data/race.db, see src/data/store.js) from the raw
// captures: each one replayed through the real pipeline on its own clock,
// every session in it written as it ends. Safe to re-run: a session already
// in the store is replaced, not duplicated. The live bridge adds new
// sessions to the same file as they finish.
//
//   npm run db [-- capture-folder ...]   (default: every folder in captures/)
//   npm run db -- --db <race.db> [capture-folder ...]   (another store: the desktop app's, say)
const path = require('path');
const { ingestCapture } = require('../src/data/ingest');
const { captureFiles } = require('../src/data/captures');
const { openStore } = require('../src/data/store');

const ROOT = path.resolve(__dirname, '..');
// --db <file>: write to that store instead (the app's is %APPDATA%\Undercut\data\race.db).
const args = process.argv.slice(2);
const dbAt = args.indexOf('--db');
const DB_FILE = dbAt >= 0 ? path.resolve(args.splice(dbAt, 2)[1]) : path.join(ROOT, 'data', 'race.db');

async function main() {
  const files = captureFiles(ROOT, args);
  if (!files.length) {
    console.error('No captures found - record races with `npm run capture` first.');
    process.exit(1);
  }
  require('fs').mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const store = openStore(DB_FILE);
  for (const f of files) {
    const captureName = path.basename(path.dirname(f));
    const sessions = await ingestCapture({ file: f, store, captureName });
    console.log(`  ${captureName}: ${sessions.map((x) => `${x.track} ${x.name} (${x.laps} laps)`).join(', ') || 'no sessions'}`);
  }
  const count = (table) => store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  console.log(`\n${count('session')} sessions, ${count('lap')} laps, ${count('event')} events, ${count('trace_point')} trace points -> ${path.relative(ROOT, DB_FILE)}`);
  store.db.exec('PRAGMA optimize');
  store.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
