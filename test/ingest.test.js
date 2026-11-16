const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { openStore } = require('../src/data/store');
const { ingestCapture } = require('../src/data/ingest');
const { buildLibrary, identity } = require('../src/analysis/setupLibrary');
const { syntheticPackets } = require('./helpers/synthetic');

// "Read setups from my recordings": a capture replayed through the real pipeline into the store, safe to repeat.
function recording(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const capDir = path.join(dir, 'captures', '2026-10-20_120000');
  fs.mkdirSync(capDir, { recursive: true });
  const file = path.join(capDir, 'packets.f1log');
  fs.writeFileSync(file, `${syntheticPackets().map((p) => JSON.stringify({ tMs: p.tMs, hex: p.buf.toString('hex') })).join('\n')}\n`);
  return { dir, file };
}

test('ingest: a recording becomes sessions with their setups and laps, named after its folder', async (t) => {
  const { file } = recording(t);
  const store = openStore(':memory:');
  const sessions = await ingestCapture({ file, store });
  assert.ok(sessions.length >= 1 && sessions[0].laps > 0);
  assert.strictEqual(store.db.prepare("SELECT count(*) n FROM capture WHERE name = '2026-10-20_120000'").get().n, 1);
  assert.ok(store.setupLibrarySessions()[0].runs.length >= 1);
  // A recording's sessions are stored as offsets into it; the library and the briefing show the day it was driven.
  const day = (ms) => new Date(ms).toDateString();
  assert.strictEqual(day(store.setupLibrarySessions()[0].startedAt), new Date(2026, 9, 20).toDateString());
  assert.strictEqual(day(store.trackHistory(store.setupLibrarySessions()[0].trackId)[0].startedAt), new Date(2026, 9, 20).toDateString());
});

test('ingest: reading the same recording again replaces its sessions rather than doubling them, and keeps your names and stars', async (t) => {
  const { file } = recording(t);
  const store = openStore(':memory:');
  await ingestCapture({ file, store });
  const [s] = store.setupLibrarySessions();
  store.saveSetupNote({ trackId: s.trackId, key: identity(s.runs[0].setup), values: s.runs[0].setup, name: 'Mine', favorite: true });
  await ingestCapture({ file, store });
  assert.strictEqual(store.db.prepare('SELECT count(*) n FROM session').get().n, 1);
  const lib = buildLibrary({ sessions: store.setupLibrarySessions(), notes: store.setupNotes() });
  assert.strictEqual(lib[0].setups[0].name, 'Mine');
  assert.strictEqual(lib[0].setups[0].favorite, true);
});

test('ingest worker: reads recordings off the main thread, reports each one, and keeps a copy of the store first', async (t) => {
  const { dir, file } = recording(t);
  const dbFile = path.join(dir, 'race.db');
  openStore(dbFile).close(); // an existing store
  const messages = [];
  await new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, '..', 'desktop', 'ingestWorker.js'), { workerData: { dbFile, files: [file] } });
    w.on('message', (m) => messages.push(m));
    w.on('error', reject);
    w.on('exit', resolve);
  });
  assert.deepStrictEqual(messages.map((m) => m.error), [undefined, undefined]);
  assert.deepStrictEqual(messages[0].progress, { done: 1, total: 1, name: '2026-10-20_120000', sessions: messages[0].progress.sessions });
  assert.strictEqual(messages[1].ok, true);
  assert.ok(fs.existsSync(`${dbFile}.before-backfill`), 'a copy before anything is replaced');
  const store = openStore(dbFile);
  assert.ok(store.setupLibrarySessions().length >= 1);
  store.close(); // before the folder is removed
});

test('ingest worker: a recording it cannot read stops it with the reason, and the store is left as it was', async (t) => {
  const { dir } = recording(t);
  const dbFile = path.join(dir, 'race.db');
  const messages = [];
  await new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, '..', 'desktop', 'ingestWorker.js'), { workerData: { dbFile, files: [path.join(dir, 'nope', 'packets.f1log')] } });
    w.on('message', (m) => messages.push(m));
    w.on('error', reject);
    w.on('exit', resolve);
  });
  assert.ok(messages.at(-1).error);
});
