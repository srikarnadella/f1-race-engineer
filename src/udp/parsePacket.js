const PACKET_IDS = require('./packetIds');
const { parseHeader } = require('./parsers/header');
const { parseCarTelemetry } = require('./parsers/carTelemetry');
const { parseCarStatus } = require('./parsers/carStatus');
const { parseCarDamage } = require('./parsers/carDamage');
const { parseLapData } = require('./parsers/lapData');
const { parseParticipants } = require('./parsers/participants');
const { parseSession } = require('./parsers/session');
const { parseEvent } = require('./parsers/event');
const { parseCarSetups } = require('./parsers/carSetups');
const { parseMotionEx } = require('./parsers/motionEx');
const { parseCarTelemetry2 } = require('./parsers/carTelemetry2');
const { parseTyreSets } = require('./parsers/tyreSets');
const { parseFinalClassification } = require('./parsers/finalClassification');
const { parseSessionHistory } = require('./parsers/sessionHistory');
const { parseLapPositions } = require('./parsers/lapPositions');

// Every per-car array has a fixed number of slots, set by the packet format:
// 22 from F1 2020 to F1 25, 24 from format 2026 (verified on a real capture -
// Lap Data, Car Damage, Car Setups and Lap Positions all divide by 24 with
// their F1 25 struct sizes). Packet length alone can't decide it: F1 25's
// 1320-byte telemetry array divides evenly by both 22 and 24. Each parser
// then takes its per-car stride from the packet length, so a struct that
// grows keeps parsing its known prefix.
function carSlotsFor(header) {
  return header.packetFormat >= 2026 ? 24 : 22;
}

const PARSERS = {
  [PACKET_IDS.CAR_TELEMETRY]: (buf, n) => parseCarTelemetry(buf, n),
  [PACKET_IDS.CAR_STATUS]: (buf, n) => parseCarStatus(buf, n),
  [PACKET_IDS.CAR_DAMAGE]: (buf, n) => parseCarDamage(buf, n),
  [PACKET_IDS.LAP_DATA]: (buf, n) => parseLapData(buf, n),
  [PACKET_IDS.PARTICIPANTS]: (buf, n) => parseParticipants(buf, n),
  [PACKET_IDS.SESSION]: (buf) => parseSession(buf),
  [PACKET_IDS.EVENT]: (buf) => parseEvent(buf),
  [PACKET_IDS.CAR_SETUPS]: (buf, n) => parseCarSetups(buf, n),
  [PACKET_IDS.MOTION_EX]: (buf) => parseMotionEx(buf),
  [PACKET_IDS.CAR_TELEMETRY_2]: (buf, n) => parseCarTelemetry2(buf, n),
  [PACKET_IDS.TYRE_SETS]: (buf) => parseTyreSets(buf),
  [PACKET_IDS.FINAL_CLASSIFICATION]: (buf, n) => parseFinalClassification(buf, n),
  [PACKET_IDS.SESSION_HISTORY]: (buf) => parseSessionHistory(buf),
  [PACKET_IDS.LAP_POSITIONS]: (buf, n) => parseLapPositions(buf, n),
};

// Single entry point used by both the live UDP listener and the replay
// feed, so "record once, replay anywhere" can't drift from live behaviour.
function parsePacket(buf) {
  const header = parseHeader(buf);
  const parse = PARSERS[header.packetId];
  if (!parse) return { header, data: null }; // Motion, lobby, time trial - not needed.
  return { header, data: parse(buf, carSlotsFor(header)) };
}

module.exports = { parsePacket };
