const BufferReader = require('../bufferReader');
const { HEADER_LENGTH } = require('./header');

// Motion: every car's place in the world. F1 25 sends 22 cars of 60 bytes; F1 26 sends 24 of 54 (checked on
// a real capture: 1325 bytes). Only the prefix both share is read: position (metres, y is up), velocity (m/s)
// and the forward and right directions (int16, 32767 = 1). The g-forces and angles after it moved in F1 26 and
// aren't used. The stride comes from the packet length, as in the other per-car parsers; a truncated packet
// gives the cars it holds whole.
const PREFIX = 36;
const DIR = 32767;

function parseMotion(buf, numCars) {
  const bytes = buf.length - HEADER_LENGTH;
  const stride = bytes % numCars === 0 ? bytes / numCars : numCars === 24 ? 54 : 60;
  const held = bytes >= PREFIX ? Math.min(numCars, Math.floor((bytes - PREFIX) / stride) + 1) : 0;
  const r = new BufferReader(buf);
  const cars = [];
  for (let i = 0; i < held; i++) {
    r.offset = HEADER_LENGTH + i * stride;
    const x = r.f32();
    const y = r.f32();
    const z = r.f32();
    const vx = r.f32();
    const vy = r.f32();
    const vz = r.f32();
    cars.push({
      x, y, z, vx, vy, vz,
      speed: Math.hypot(vx, vy, vz),
      forwardX: r.i16() / DIR, forwardY: r.i16() / DIR, forwardZ: r.i16() / DIR,
      rightX: r.i16() / DIR, rightY: r.i16() / DIR, rightZ: r.i16() / DIR,
    });
  }
  return { cars };
}

module.exports = { parseMotion };
