const BufferReader = require('../bufferReader');
const { HEADER_LENGTH } = require('./header');

// Extended motion data - the player's car only. Wheel arrays are in the
// game's order: RL, RR, FL, FR. Only the leading arrays are read; their
// order has been stable since F1 2020, while fields at the end keep growing
// (F1 25 added chassis pitch and camber), so later additions can't shift them.
const LEADING_ARRAYS_SIZE = 6 * 4 * 4;

function parseMotionEx(buf) {
  if (buf.length < HEADER_LENGTH + LEADING_ARRAYS_SIZE) return null;
  const r = new BufferReader(buf, HEADER_LENGTH);
  const four = () => [r.f32(), r.f32(), r.f32(), r.f32()];
  return {
    suspensionPosition: four(),
    suspensionVelocity: four(),
    suspensionAcceleration: four(),
    wheelSpeed: four(), // m/s
    // Negative under braking when a wheel turns slower than the car moves
    // (locking); positive under power when it turns faster (wheelspin).
    wheelSlipRatio: four(),
    wheelSlipAngle: four(), // radians
  };
}

module.exports = { parseMotionEx };
