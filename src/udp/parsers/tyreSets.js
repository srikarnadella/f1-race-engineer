const { HEADER_LENGTH } = require('./header');

// Tyre Sets (packet 12): one car's 20 tyre sets per packet (13 dry + 7 wet),
// cycling through the cars. Layout unchanged from F1 25 in F1 26 (verified on
// a real Monaco race: the fitted set's life counts down as it wears, a used
// set keeps its wear, and each set's lap-time delta is relative to the fitted one).
const SETS = 20;
const SET_SIZE = 10;

function parseTyreSets(buf) {
  if (buf.length < HEADER_LENGTH + 1 + SETS * SET_SIZE + 1) return null;
  const carIdx = buf.readUInt8(HEADER_LENGTH);
  const sets = [];
  for (let i = 0; i < SETS; i++) {
    const s = HEADER_LENGTH + 1 + i * SET_SIZE;
    sets.push({
      index: i,
      actualTyreCompound: buf.readUInt8(s),
      visualTyreCompound: buf.readUInt8(s + 1),
      wear: buf.readUInt8(s + 2), // %
      available: !!buf.readUInt8(s + 3),
      recommendedSession: buf.readUInt8(s + 4),
      lifeSpan: buf.readUInt8(s + 5), // laps left in this set
      usableLife: buf.readUInt8(s + 6), // max laps recommended for the compound
      lapDeltaTimeMs: buf.readInt16LE(s + 7), // vs the fitted set (- = faster)
      fitted: !!buf.readUInt8(s + 9),
    });
  }
  return { carIdx, sets, fittedIdx: buf.readUInt8(HEADER_LENGTH + 1 + SETS * SET_SIZE) };
}

module.exports = { parseTyreSets };
