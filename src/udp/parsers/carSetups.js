const BufferReader = require('../bufferReader');
const { HEADER_LENGTH } = require('./header');

// F1 25: 50 bytes per car (engineBraking was added after F1 24's 49), then a
// trailing float nextFrontWingValue. Only the prefix up to engineBraking is
// read, and the stride is taken from the packet length, so a struct that
// grows at the end in F1 26 still parses.
const TRAILER_SIZE = 4;
const PREFIX_SIZE = 28; // frontWing .. brakeBias, unchanged since F1 22
const F1_25_STRUCT_SIZE = 50; // engineBraking only exists from here on

function readSetup(r, start, stride) {
  r.offset = start;
  const setup = {
    frontWing: r.u8(),
    rearWing: r.u8(),
    onThrottle: r.u8(), // differential adjustment on throttle, %
    offThrottle: r.u8(),
    frontCamber: r.f32(),
    rearCamber: r.f32(),
    frontToe: r.f32(),
    rearToe: r.f32(),
    frontSuspension: r.u8(),
    rearSuspension: r.u8(),
    frontAntiRollBar: r.u8(),
    rearAntiRollBar: r.u8(),
    frontSuspensionHeight: r.u8(),
    rearSuspensionHeight: r.u8(),
    brakePressure: r.u8(),
    brakeBias: r.u8(),
    engineBraking: stride >= F1_25_STRUCT_SIZE ? r.u8() : null,
  };
  return setup;
}

function parseCarSetups(buf, numCars) {
  const bytes = buf.length - HEADER_LENGTH - TRAILER_SIZE;
  const stride = Math.floor(bytes / numCars);
  if (bytes % numCars !== 0) {
    console.warn(`[carSetups] packet size mismatch: ${buf.length} bytes is not ${numCars} equal structs + trailer`);
  }
  if (stride < PREFIX_SIZE) return { cars: [] };
  const r = new BufferReader(buf, HEADER_LENGTH);
  const cars = [];
  for (let i = 0; i < numCars; i++) cars.push(readSetup(r, HEADER_LENGTH + i * stride, stride));
  return { cars };
}

module.exports = { parseCarSetups };
