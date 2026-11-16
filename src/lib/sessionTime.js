// Sessions ingested from a recording store their start as an offset into it; the recording's
// name is its local start time (2026-10-19_173010). Returns epoch ms, or null if unknown.
function sessionStart(startedAtMs, captureName) {
  if (startedAtMs > 1e12) return startedAtMs;
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(captureName || '');
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() + startedAtMs;
}

module.exports = { sessionStart };
