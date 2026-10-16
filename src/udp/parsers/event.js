const { HEADER_LENGTH } = require('./header');

// Just the 4-char event code - enough to drive race-engineer alerts
// (SSTA, SEND, FTLP, PENA, DRSE/DRSD, SCAR/VSCAR, RTMT, etc). The
// per-event detail payload that follows is intentionally not parsed here.
const EVENT_NAMES = {
  SSTA: 'Session Started',
  SEND: 'Session Ended',
  FTLP: 'Fastest Lap',
  RTMT: 'Retirement',
  DRSE: 'DRS Enabled',
  DRSD: 'DRS Disabled',
  TMPT: 'Team Mate In Pits',
  CHQF: 'Chequered Flag',
  RCWN: 'Race Winner',
  PENA: 'Penalty Issued',
  SPTP: 'Speed Trap Triggered',
  STLG: 'Start Lights',
  LGOT: 'Lights Out',
  DTSV: 'Drive Through Penalty Served',
  SGSV: 'Stop Go Penalty Served',
  FLBK: 'Flashback',
  BUTN: 'Button Status',
  RDFL: 'Red Flag',
  OVTK: 'Overtake',
  SCAR: 'Safety Car',
  COLL: 'Collision',
};

// The Safety Car event's detail (F1 24+): uint8 safetyCarType, uint8 eventType.
// Parsed because "VSC deployed" and "SC in this lap" call for very different
// reactions, and the bare code can't tell them apart.
const SAFETY_CAR_TYPES = { 1: 'Safety Car', 2: 'Virtual Safety Car', 3: 'Formation Lap Safety Car' };
const SAFETY_CAR_EVENTS = { 0: 'deployed', 1: 'in this lap', 2: 'returned', 3: 'race resumed' };

// F1 25 penalty types (unchanged in the F1 26 capture).
const PENALTY_TYPES = {
  0: 'Drive-through penalty', 1: 'Stop-go penalty', 2: 'Grid penalty', 3: 'Penalty reminder', 4: 'Time penalty',
  5: 'Warning', 6: 'Disqualified', 7: 'Removed from formation lap', 8: 'Parked too long', 9: 'Tyre regulations',
  10: 'Lap invalidated', 11: 'This and next lap invalidated', 12: 'Lap invalidated', 13: 'This and next lap invalidated',
  14: 'This and previous lap invalidated', 15: 'This and previous lap invalidated', 16: 'Retired', 17: 'Black flag timer',
};

function parseEvent(buf) {
  const code = buf.toString('utf8', HEADER_LENGTH, HEADER_LENGTH + 4);
  const d = HEADER_LENGTH + 4; // start of the event's detail union
  const has = (n) => buf.length >= d + n;
  // Which car an event is about, so a call can name the driver (verified
  // on an F1 26 race capture: fastest laps by Norris/Piastri/Russell, a
  // warning for the player).
  if (code === 'FTLP' && has(5)) {
    return { code, name: EVENT_NAMES.FTLP, vehicleIdx: buf.readUInt8(d), lapTimeS: buf.readFloatLE(d + 1) };
  }
  if (code === 'PENA' && has(7)) {
    const penaltyType = buf.readUInt8(d);
    const timeS = buf.readUInt8(d + 4);
    return {
      code, name: PENALTY_TYPES[penaltyType] || EVENT_NAMES.PENA, penaltyType, infringementType: buf.readUInt8(d + 1),
      vehicleIdx: buf.readUInt8(d + 2), otherVehicleIdx: buf.readUInt8(d + 3), timeS: timeS === 255 ? null : timeS,
      lapNum: buf.readUInt8(d + 5), placesGained: buf.readUInt8(d + 6),
    };
  }
  if (code === 'RTMT' && has(1)) return { code, name: EVENT_NAMES.RTMT, vehicleIdx: buf.readUInt8(d) };
  // Who passed whom - the labels the overtake model learns from (verified
  // on a real F1 26 race: "LAWSON passes SAINZ", then the re-pass).
  if (code === 'OVTK' && has(2)) return { code, name: EVENT_NAMES.OVTK, overtakerIdx: buf.readUInt8(d), overtakenIdx: buf.readUInt8(d + 1) };
  if (code === 'SCAR' && buf.length >= HEADER_LENGTH + 6) {
    const safetyCarType = buf.readUInt8(HEADER_LENGTH + 4);
    const safetyCarEventType = buf.readUInt8(HEADER_LENGTH + 5);
    const type = SAFETY_CAR_TYPES[safetyCarType];
    const what = SAFETY_CAR_EVENTS[safetyCarEventType];
    return { code, name: type && what ? `${type} ${what}` : EVENT_NAMES.SCAR, safetyCarType, safetyCarEventType };
  }
  return { code, name: EVENT_NAMES[code] || code };
}

module.exports = { parseEvent };
