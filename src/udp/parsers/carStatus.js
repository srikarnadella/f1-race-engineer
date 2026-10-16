const BufferReader = require('../bufferReader');
const { HEADER_LENGTH } = require('./header');

// No trailing fields after the array. Per-car struct:
//   F1 23-25: 55 bytes
//   F1 26 (packet format 2026): 59 bytes - ersHarvestLimitPerLap (f32)
//   inserted before ersDeployedThisLap.
// The stride comes from the packet length; anything past the known fields
// is skipped.
const KNOWN_PREFIX_SIZE = 55;
const F1_26_STRUCT_SIZE = 59;

function readCar(r, stride) {
  const start = r.offset;
  const car = {
    tractionControl: r.u8(),
    antiLockBrakes: r.u8(),
    fuelMix: r.u8(),
    frontBrakeBias: r.u8(),
    pitLimiterStatus: r.u8(),
    fuelInTank: r.f32(),
    fuelCapacity: r.f32(),
    fuelRemainingLaps: r.f32(),
    maxRPM: r.u16(),
    idleRPM: r.u16(),
    maxGears: r.u8(),
    drsAllowed: r.u8(),
    drsActivationDistance: r.u16(),
    actualTyreCompound: r.u8(),
    visualTyreCompound: r.u8(),
    tyresAgeLaps: r.u8(),
    vehicleFiaFlags: r.i8(),
    enginePowerICE: r.f32(),
    enginePowerMGUK: r.f32(),
    ersStoreEnergy: r.f32(),
    ersDeployMode: r.u8(),
    ersHarvestedThisLapMGUK: r.f32(),
    ersHarvestedThisLapMGUH: r.f32(),
    // F1 26 inserts ersHarvestLimitPerLap (f32) here, before the deployed
    // figure - not at the end of the struct. Cross-checked with
    // rdgonzaga/f1-game-telemetry's docs/udp-spec.md, and with a real
    // capture (6.2 MJ at this offset, 0 deployed while stationary).
    ersHarvestLimitPerLap: stride >= F1_26_STRUCT_SIZE ? r.f32() : null,
    ersDeployedThisLap: r.f32(),
    networkPaused: r.u8(),
  };
  r.offset = start + stride;
  return car;
}

function parseCarStatus(buf, numCars) {
  const carsBytes = buf.length - HEADER_LENGTH;
  const stride = Math.floor(carsBytes / numCars);
  if (carsBytes % numCars !== 0 || stride < KNOWN_PREFIX_SIZE) {
    console.warn(`[carStatus] packet size mismatch: ${buf.length} bytes for ${numCars} cars`);
    if (stride < KNOWN_PREFIX_SIZE) return { cars: [] };
  }

  const r = new BufferReader(buf, HEADER_LENGTH);
  const cars = r.array(numCars, () => readCar(r, stride));
  return { cars };
}

module.exports = { parseCarStatus };
