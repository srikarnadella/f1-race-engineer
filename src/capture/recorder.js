const { openLogWriter } = require('./logFile');

// Newline-delimited JSON: { tMs, hex }. Not byte-efficient, but "just grep
// it" debuggability matters; name the file .gz to compress it (captures do).
// `startedAt` lets a capture session share one clock across its files.
function createRecorder(filePath, startedAt = Date.now()) {
  const out = openLogWriter(filePath);

  function record(buf) {
    out.write(JSON.stringify({ tMs: Date.now() - startedAt, hex: buf.toString('hex') }));
  }

  return { record, close: out.close };
}

module.exports = { createRecorder };
