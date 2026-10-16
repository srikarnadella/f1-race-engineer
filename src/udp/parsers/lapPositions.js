const { HEADER_LENGTH } = require('./header');

// Lap Positions (packet 15): every car's position at the start of each lap,
// up to 50 laps per packet - the data behind a position chart. Rows are
// laps, columns are car slots (24 in F1 26, verified on a real Monaco race).
const MAX_LAPS = 50;

function parseLapPositions(buf, numCars) {
  if (buf.length !== HEADER_LENGTH + 2 + MAX_LAPS * numCars) {
    console.warn(`[parser] LapPositions: ${buf.length} bytes doesn't fit ${MAX_LAPS} laps x ${numCars} cars - skipped`);
    return null;
  }
  const numLaps = Math.min(MAX_LAPS, buf.readUInt8(HEADER_LENGTH));
  const lapStart = buf.readUInt8(HEADER_LENGTH + 1);
  const laps = [];
  for (let l = 0; l < numLaps; l++) {
    const s = HEADER_LENGTH + 2 + l * numCars;
    laps.push(Array.from({ length: numCars }, (_, c) => buf.readUInt8(s + c)));
  }
  return { lapStart, laps }; // laps[k][carIdx] = position at the start of lap lapStart + k + 1 (0 = no car)
}

module.exports = { parseLapPositions };
