const { HEADER_LENGTH } = require('./header');

// Final Classification (packet 8): sent once, as the results screen appears -
// the official result. F1 25 layout, 46 bytes per car (24 slots in F1 26,
// verified on a real Suzuka race). Stint arrays are 8 long, only the first
// numTyreStints are real.
const STRUCT_SIZE = 46;

function parseFinalClassification(buf, numCars) {
  const bytes = buf.length - HEADER_LENGTH - 1;
  const stride = Math.floor(bytes / numCars);
  if (bytes % numCars !== 0 || stride < STRUCT_SIZE) {
    console.warn(`[parser] FinalClassification: ${buf.length} bytes doesn't fit ${numCars} x ${STRUCT_SIZE} - skipped`);
    return null;
  }
  const numActive = buf.readUInt8(HEADER_LENGTH);
  const cars = [];
  for (let i = 0; i < numCars; i++) {
    const s = HEADER_LENGTH + 1 + i * stride;
    const stints = buf.readUInt8(s + 21);
    const arr = (o) => Array.from({ length: Math.min(8, stints) }, (_, k) => buf.readUInt8(s + o + k));
    cars.push({
      position: buf.readUInt8(s),
      numLaps: buf.readUInt8(s + 1),
      gridPosition: buf.readUInt8(s + 2),
      points: buf.readUInt8(s + 3),
      numPitStops: buf.readUInt8(s + 4),
      resultStatus: buf.readUInt8(s + 5),
      resultReason: buf.readUInt8(s + 6),
      bestLapTimeInMS: buf.readUInt32LE(s + 7),
      totalRaceTimeS: buf.readDoubleLE(s + 11),
      penaltiesTimeS: buf.readUInt8(s + 19),
      numPenalties: buf.readUInt8(s + 20),
      tyreStintsVisual: arr(30),
      tyreStintsEndLaps: arr(38),
    });
  }
  return { numCars: numActive, cars };
}

module.exports = { parseFinalClassification };
