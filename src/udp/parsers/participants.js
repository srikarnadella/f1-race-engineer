const BufferReader = require('../bufferReader');
const { HEADER_LENGTH } = require('./header');

// Per-car struct, after a 1-byte numActiveCars:
//   F1 23-25: 57 bytes - 7 one-byte fields (aiControlled, driverId,
//             networkId, teamId, myTeam, raceNumber, nationality), name[32],
//             then 18 bytes (telemetry/online-name flags, techLevel,
//             platform, livery colours)
//   F1 26:    60 bytes - 3 more bytes before the name (the driver id
//             looks to have become 16-bit); name[32] and the 18-byte tail
//             are unchanged (verified on a real capture).
// So the name is found from the end of the struct, which holds for both.
// The one-byte fields are only trusted at the F1 25 size.
const NAME_LENGTH = 32;
const TAIL_SIZE = 18;
const F1_25_STRUCT_SIZE = 57;

function readName(buf, start) {
  const slice = buf.subarray(start, Math.min(start + NAME_LENGTH, buf.length));
  const nullIdx = slice.indexOf(0);
  return slice.toString('utf8', 0, nullIdx === -1 ? slice.length : nullIdx);
}

function parseParticipants(buf, numCars) {
  const numActiveCars = buf.readUInt8(HEADER_LENGTH);
  const arrayStart = HEADER_LENGTH + 1;
  const arrayBytes = buf.length - arrayStart;
  const stride = Math.floor(arrayBytes / numCars);
  if (arrayBytes % numCars !== 0 || stride < F1_25_STRUCT_SIZE) {
    console.warn(`[participants] packet size mismatch: ${buf.length} bytes for ${numCars} cars`);
    if (stride < F1_25_STRUCT_SIZE) return { numActiveCars, participants: [] };
  }
  const nameOffset = stride - TAIL_SIZE - NAME_LENGTH;

  const participants = [];
  for (let i = 0; i < numCars; i++) {
    const base = arrayStart + i * stride;
    const r = new BufferReader(buf, base);
    const aiControlled = !!r.u8();
    const name = readName(buf, base + nameOffset);
    if (stride === F1_25_STRUCT_SIZE) {
      const driverId = r.u8();
      const networkId = r.u8();
      const teamId = r.u8();
      const myTeam = !!r.u8();
      const raceNumber = r.u8();
      const nationality = r.u8();
      participants.push({ aiControlled, driverId, networkId, teamId, myTeam, raceNumber, nationality, name });
    } else {
      participants.push({ aiControlled, driverId: null, networkId: null, teamId: null, myTeam: null, raceNumber: null, nationality: null, name });
    }
  }

  return { numActiveCars, participants };
}

module.exports = { parseParticipants };
