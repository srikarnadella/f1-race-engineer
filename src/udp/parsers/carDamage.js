const BufferReader = require('../bufferReader');
const { HEADER_LENGTH } = require('./header');

// Only the fields a race engineer actually glances at are parsed precisely
// (tyre wear/damage, wings, gearbox/engine). The struct has grown over the
// years with extra wear-component fields; carStructSize is derived from the
// packet length instead of hardcoded so a few extra trailing bytes per car
// don't break parsing - see README "Verifying packet offsets" if this warns.
// tyresWear f32[4] + tyresDamage[4] + brakesDamage[4] + 10 single-byte fields (pre-blister layout)
const KNOWN_PREFIX_SIZE = 16 + 4 + 4 + 10;

// F1 25 inserted tyreBlisters[4] after brakesDamage, growing the struct from
// 42 to 46 bytes. Detected by stride so both layouts parse; VERIFY against a
// live F1 26 capture (PROJECT_SPEC §11) - if wing damage reads nonsense, the
// insertion point is wrong.
const BLISTERS_LAYOUT_MIN_SIZE = 46;

function readCar(r, carStructSize) {
  const start = r.offset;
  const tyresWear = r.array(4, BufferReader.prototype.f32);
  const tyresDamage = r.array(4, BufferReader.prototype.u8);
  const brakesDamage = r.array(4, BufferReader.prototype.u8);
  const tyreBlisters = carStructSize >= BLISTERS_LAYOUT_MIN_SIZE ? r.array(4, BufferReader.prototype.u8) : null;
  const frontLeftWingDamage = r.u8();
  const frontRightWingDamage = r.u8();
  const rearWingDamage = r.u8();
  const floorDamage = r.u8();
  const diffuserDamage = r.u8();
  const sidepodDamage = r.u8();
  const drsFault = r.u8();
  const ersFault = r.u8();
  const gearBoxDamage = r.u8();
  const engineDamage = r.u8();
  // Skip any remaining/unparsed fields (engine wear breakdown etc.) to stay
  // aligned for the next car in the array.
  const consumed = r.offset - start;
  if (carStructSize > consumed) r.skip(carStructSize - consumed);

  return {
    tyresWear,
    tyresDamage,
    brakesDamage,
    tyreBlisters,
    frontLeftWingDamage,
    frontRightWingDamage,
    rearWingDamage,
    floorDamage,
    diffuserDamage,
    sidepodDamage,
    drsFault,
    ersFault,
    gearBoxDamage,
    engineDamage,
  };
}

function parseCarDamage(buf, numCarsHint) {
  const carsBytes = buf.length - HEADER_LENGTH;
  const numCars = numCarsHint || Math.round(carsBytes / KNOWN_PREFIX_SIZE);
  // Floored so a size mismatch degrades to a warning + misread fields
  // rather than fractional offsets that throw on every read.
  const carStructSize = Math.floor(carsBytes / numCars);
  if (carsBytes % numCars !== 0) {
    console.warn(`[carDamage] packet size mismatch: ${buf.length} bytes for ${numCars} cars`);
  }

  const r = new BufferReader(buf, HEADER_LENGTH);
  const cars = r.array(numCars, () => readCar(r, carStructSize));
  return { cars };
}

module.exports = { parseCarDamage };
