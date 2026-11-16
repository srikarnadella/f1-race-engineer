// "Read setups from my recordings" for the desktop app, off the main thread: a recording is a few hundred MB of packets and
// the bridge has to keep ticking. It opens its own connection to the race store (WAL, with a busy timeout), keeps a copy of the
// store first, and replays each recording through the same pipeline the app uses. Progress goes back one message per recording.
const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const { openStore } = require('../src/data/store');
const { ingestCapture } = require('../src/data/ingest');

(async () => {
  const { dbFile, files } = workerData;
  const path = require('path');
  let store = null;
  let failure = null;
  try {
    store = openStore(dbFile);
    // A consistent copy before anything is replaced, kept once: the first one is the one worth having.
    const copy = `${dbFile}.before-backfill`;
    if (!fs.existsSync(copy)) store.db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    let done = 0;
    for (const f of files) {
      const sessions = await ingestCapture({ file: f, store });
      parentPort.postMessage({ progress: { done: ++done, total: files.length, name: path.basename(path.dirname(f)), sessions: sessions.length } });
    }
  } catch (err) {
    failure = err.message;
  }
  if (store) store.close(); // closed before the last message, so whoever hears it can open the store
  parentPort.postMessage(failure ? { error: failure } : { ok: true, total: files.length });
})();
