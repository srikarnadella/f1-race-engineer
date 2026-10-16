const { HEADER_LENGTH } = require('./header');

// Session History (packet 11): one car per packet, cycling through the grid -
// every lap and sector time that car has set. Lap Data only carries the lap
// in progress, so this is the only source of the field's sector times.
// F1 25 layout, unchanged in F1 26 (1460 bytes, verified on a real race).
const MAX_LAPS = 100;
const LAP_SIZE = 14;
const HEAD = 7;
const SIZE = HEADER_LENGTH + HEAD + MAX_LAPS * LAP_SIZE + 8 * 3;

const split = (buf, o) => buf.readUInt16LE(o) + buf.readUInt8(o + 2) * 60000;

function parseSessionHistory(buf) {
  if (buf.length !== SIZE) {
    console.warn(`[parser] SessionHistory: ${buf.length} bytes, expected ${SIZE} - skipped`);
    return null;
  }
  const h = HEADER_LENGTH;
  const numLaps = Math.min(MAX_LAPS, buf.readUInt8(h + 1));
  const laps = [];
  for (let i = 0; i < numLaps; i++) {
    const s = h + HEAD + i * LAP_SIZE;
    // Bit 0: lap valid; bits 1-3: sectors 1-3 valid.
    laps.push({ lapMs: buf.readUInt32LE(s), s1: split(buf, s + 4), s2: split(buf, s + 7), s3: split(buf, s + 10), valid: !!(buf.readUInt8(s + 13) & 1) });
  }
  return {
    carIdx: buf.readUInt8(h),
    bestLapNum: buf.readUInt8(h + 3),
    bestSectorLapNums: [buf.readUInt8(h + 4), buf.readUInt8(h + 5), buf.readUInt8(h + 6)],
    laps,
  };
}

module.exports = { parseSessionHistory };
