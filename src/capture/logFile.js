const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const { PassThrough } = require('stream');

// .f1log files are newline-delimited JSON: { tMs, hex } per raw packet.
// A name ending in .gz is gzipped - a full race at 60Hz is ~1GB as plain
// hex-JSON and a fraction of that compressed - and stays readable after a
// crash or Ctrl+C, because the stream is sync-flushed every couple of
// seconds and the reader stops cleanly at a truncated tail.

const FLUSH_EVERY_MS = 2000;

function openLogWriter(filePath) {
  const file = fs.createWriteStream(filePath, { flags: 'w' });
  if (!filePath.endsWith('.gz')) {
    return { write: (line) => file.write(line + '\n'), close: () => new Promise((resolve) => file.end(resolve)) };
  }
  const gz = zlib.createGzip();
  gz.pipe(file);
  const flusher = setInterval(() => gz.flush(zlib.constants.Z_SYNC_FLUSH), FLUSH_EVERY_MS);
  flusher.unref();
  return {
    write: (line) => gz.write(line + '\n'),
    close: () => new Promise((resolve) => {
      clearInterval(flusher);
      file.on('close', resolve);
      gz.end();
    }),
  };
}

// Yields { tMs, buf } for every readable packet line. Unreadable lines and
// a truncated gzip tail (capture killed mid-write) end or skip quietly;
// `stats` counts what was skipped so callers can report it.
async function* readLog(filePath, stats = { badLines: 0, truncated: false }) {
  let input = fs.createReadStream(filePath);
  if (filePath.endsWith('.gz')) {
    // readline re-throws any error from its input, so it reads from a
    // pass-through that simply ends when the gzip data does - including a
    // file cut off mid-block, where we keep what decompressed and note it.
    const gunzip = zlib.createGunzip();
    const out = new PassThrough();
    gunzip.on('error', () => {
      stats.truncated = true;
      out.end();
    });
    input.pipe(gunzip).pipe(out);
    input = out;
  }
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      stats.badLines++;
      continue;
    }
    if (typeof rec.tMs !== 'number' || typeof rec.hex !== 'string') {
      stats.badLines++;
      continue;
    }
    yield { tMs: rec.tMs, buf: Buffer.from(rec.hex, 'hex') };
  }
}

module.exports = { openLogWriter, readLog };
