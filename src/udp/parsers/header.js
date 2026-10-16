const BufferReader = require('../bufferReader');

// 29-byte header present on every packet, stable across F1 23-26.
const HEADER_LENGTH = 29;

function parseHeader(buf) {
  const r = new BufferReader(buf);
  return {
    packetFormat: r.u16(),
    gameYear: r.u8(),
    gameMajorVersion: r.u8(),
    gameMinorVersion: r.u8(),
    packetVersion: r.u8(),
    packetId: r.u8(),
    sessionUID: r.u64(),
    sessionTime: r.f32(),
    frameIdentifier: r.u32(),
    overallFrameIdentifier: r.u32(),
    playerCarIndex: r.u8(),
    secondaryPlayerCarIndex: r.u8(),
  };
}

module.exports = { parseHeader, HEADER_LENGTH };
