const { parsePacket } = require('../udp/parsePacket');
const { readLog } = require('./logFile');

// Feeds a recorded .f1log (or .f1log.gz) file into onPacket at its original
// relative timing, then loops. This is what lets the public demo show a
// live-moving dashboard with no game, no UDP socket, and no viewer setup at
// all - it runs through the exact same parsePacket() the live listener uses.
async function startReplay({ filePath, onPacket, onLoopStart, loop = true, speed = 1 }) {
  async function playOnce() {
    if (onLoopStart) onLoopStart();
    const stats = { badLines: 0, truncated: false };
    // Schedule against the loop's wall-clock start, not packet-to-packet:
    // relative setTimeouts each fire a little late, and over thousands of
    // packets that drift adds up to the replay running several % slow.
    const startedAt = Date.now();

    for await (const { tMs, buf } of readLog(filePath, stats)) {
      const wait = startedAt + tMs / speed - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        const parsed = parsePacket(buf);
        if (parsed.data !== null) onPacket(parsed.header.packetId, parsed.header, parsed.data);
      } catch (err) {
        console.warn('[replay] failed to parse recorded packet:', err.message);
      }
    }
    // e.g. a half-written last line from a capture that was killed.
    if (stats.badLines) console.warn(`[replay] skipped ${stats.badLines} unreadable line(s) in the recording`);
    if (stats.truncated) console.warn('[replay] recording ends mid-block (capture was interrupted) - played what was there');
  }

  do {
    await playOnce();
  } while (loop);
}

module.exports = { startReplay };
