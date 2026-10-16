const { HEADER_LENGTH } = require('./header');

// Car Telemetry 2 (packet 16) - new in F1 26 (packet format 2026): the 2026
// regulations' active aero and Overtake mode, 10 bytes per car, no trailer.
// Layout cross-checked against rdgonzaga/f1-game-telemetry (itself checked
// with volodymyr-fed/F1Game.UDP v26) and a real Suzuka race capture: the
// aero flips to straight mode down the main straight every lap, and
// overtake becomes available near the car ahead, counting down to the
// activation point.
const STRUCT_SIZE = 10;

function parseCarTelemetry2(buf, numCars) {
  const bytes = buf.length - HEADER_LENGTH;
  const stride = Math.floor(bytes / numCars);
  if (bytes % numCars !== 0 || stride < STRUCT_SIZE) {
    console.warn(`[carTelemetry2] packet size mismatch: ${buf.length} bytes for ${numCars} cars`);
    if (stride < STRUCT_SIZE) return { cars: [] };
  }
  const cars = [];
  for (let i = 0; i < numCars; i++) {
    const s = HEADER_LENGTH + i * stride;
    cars.push({
      activeAeroMode: buf.readUInt8(s), // 0 corner, 1 straight
      activeAeroAvailable: !!buf.readUInt8(s + 1),
      activeAeroActivationDistance: buf.readUInt16LE(s + 2), // m to the zone
      overtakeAvailable: !!buf.readUInt8(s + 4),
      overtakeActive: !!buf.readUInt8(s + 5), // armed, not necessarily deploying
      overtakeActivationDistance: buf.readUInt16LE(s + 6),
      regulations2026: !!buf.readUInt8(s + 8),
      wrongWay: !!buf.readUInt8(s + 9),
    });
  }
  return { cars };
}

module.exports = { parseCarTelemetry2 };
