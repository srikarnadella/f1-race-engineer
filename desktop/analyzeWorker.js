// `npm run analyze` for the desktop Library, off the main thread: a full race
// is a few hundred MB of packets, and the engine has to keep ticking meanwhile.
const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const { analyzeCapture, toMarkdown } = require('../src/capture/analyze');

analyzeCapture(workerData.dir).then(
  (report) => {
    fs.writeFileSync(path.join(workerData.dir, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(workerData.dir, 'report.md'), toMarkdown(report));
    parentPort.postMessage({ ok: true });
  },
  (err) => parentPort.postMessage({ error: err.message }),
);
