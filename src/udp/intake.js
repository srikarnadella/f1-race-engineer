// What is reaching the UDP port, before any of it is parsed: the first-run check. "No telemetry" has four causes
// (UDP off in the game, the wrong port, an old packet format, the port taken by another program) and the dashboard
// can only tell them apart if the bridge counts what arrives.
const HEADER_BYTES = 29;

function createIntake(clock = Date.now) {
  let packets = 0;
  let unreadable = 0;
  let format = null;
  let lastAtMs = null;
  let error = null;

  return {
    // One raw datagram. Never throws: this sits on the hot path of every packet.
    note(buf) {
      packets++;
      lastAtMs = clock();
      if (!buf || buf.length < HEADER_BYTES) {
        unreadable++;
        return;
      }
      format = buf.readUInt16LE(0);
    },
    // The socket could not open or broke (EADDRINUSE: another program owns the port).
    fail(err) {
      error = { code: err && err.code ? err.code : 'ERR', message: err && err.message ? err.message : String(err) };
    },
    view() {
      return { packets, unreadable, format, error, lastAgoMs: lastAtMs == null ? null : clock() - lastAtMs };
    },
  };
}

module.exports = { createIntake };
