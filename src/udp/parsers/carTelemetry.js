const BufferReader = require('../bufferReader');
const { HEADER_LENGTH } = require('./header');

// 3 trailing bytes follow the car array (mfdPanelIndex,
// mfdPanelIndexSecondaryPlayer, suggestedGear). Per-car struct:
//   F1 23-25: 60 bytes
//   F1 26 (packet format 2026): 59 bytes - engineTemperature shrank from
//   uint16 to uint8; every other field is in the same place (verified on a
//   real capture: brake temps, tyre temps, pressures and surface all decode).
const TRAILING_BYTES = 3;
const F1_25_STRUCT_SIZE = 60;

function readCar(r, stride) {
  const start = r.offset;
  const car = {
    speed: r.u16(),
    throttle: r.f32(),
    steer: r.f32(),
    brake: r.f32(),
    clutch: r.u8(),
    gear: r.i8(),
    engineRPM: r.u16(),
    drs: r.u8(),
    revLightsPercent: r.u8(),
    revLightsBitValue: r.u16(),
    brakesTemperature: r.array(4, BufferReader.prototype.u16),
    tyresSurfaceTemperature: r.array(4, BufferReader.prototype.u8),
    tyresInnerTemperature: r.array(4, BufferReader.prototype.u8),
    engineTemperature: stride >= F1_25_STRUCT_SIZE ? r.u16() : r.u8(),
    tyresPressure: r.array(4, BufferReader.prototype.f32),
    surfaceType: r.array(4, BufferReader.prototype.u8),
  };
  r.offset = start + stride;
  return car;
}

function parseCarTelemetry(buf, numCars) {
  const carsBytes = buf.length - HEADER_LENGTH - TRAILING_BYTES;
  const stride = Math.floor(carsBytes / numCars);
  if (carsBytes % numCars !== 0 || stride < F1_25_STRUCT_SIZE - 1) {
    // Field layout changed in this game version - see README "Capture and validate a session".
    console.warn(`[carTelemetry] packet size mismatch: ${buf.length} bytes for ${numCars} cars`);
    if (stride < F1_25_STRUCT_SIZE - 1) return { cars: [], mfdPanelIndex: null, mfdPanelIndexSecondaryPlayer: null, suggestedGear: null };
  }

  const r = new BufferReader(buf, HEADER_LENGTH);
  const cars = r.array(numCars, () => readCar(r, stride));
  r.offset = HEADER_LENGTH + numCars * stride;
  const mfdPanelIndex = r.u8();
  const mfdPanelIndexSecondaryPlayer = r.u8();
  const suggestedGear = r.i8();

  return { cars, mfdPanelIndex, mfdPanelIndexSecondaryPlayer, suggestedGear };
}

module.exports = { parseCarTelemetry };
