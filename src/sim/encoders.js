const PACKET_IDS = require('../udp/packetIds');

// The inverse of src/udp/parsers: builds binary packets in the F1 25 layout
// (which F1 26 is assumed to share - see PROJECT_SPEC §11). Used by the
// synthetic demo-session generator and by the parser round-trip tests, so
// the bytes the dashboard sees in demo mode go through the real parsers.
const PACKET_FORMAT = 2025;
const NUM_CARS = 22;

// Per-car struct sizes in the F1 25 spec. Parsers only read a prefix of
// some of these; the remainder is zero-filled here to keep the stride real.
const SIZES = {
  CAR_TELEMETRY: 60,
  CAR_STATUS: 55,
  CAR_DAMAGE: 46,
  LAP_DATA: 57,
  PARTICIPANT: 57,
  CAR_SETUP: 50,
  SESSION_PACKET: 753,
  MOTION_EX_PACKET: 273,
};

class BufferWriter {
  constructor(size) {
    this.buf = Buffer.alloc(size);
    this.offset = 0;
  }
  u8(v) { this.buf.writeUInt8(v & 0xff, this.offset); this.offset += 1; }
  i8(v) { this.buf.writeInt8(v, this.offset); this.offset += 1; }
  u16(v) { this.buf.writeUInt16LE(v & 0xffff, this.offset); this.offset += 2; }
  u32(v) { this.buf.writeUInt32LE(v >>> 0, this.offset); this.offset += 4; }
  u64(v) { this.buf.writeBigUInt64LE(BigInt(v), this.offset); this.offset += 8; }
  f32(v) { this.buf.writeFloatLE(v, this.offset); this.offset += 4; }
  // Pads the current struct out to `size` bytes from `start`.
  padTo(start, size) { this.offset = start + size; }
}

const clampU8 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const clampU16 = (v) => Math.max(0, Math.min(65535, Math.round(v)));

function writeHeader(w, packetId, h) {
  w.u16(PACKET_FORMAT);
  w.u8(25); // gameYear
  w.u8(1); // gameMajorVersion
  w.u8(0); // gameMinorVersion
  w.u8(1); // packetVersion
  w.u8(packetId);
  w.u64(h.sessionUID);
  w.f32(h.sessionTime);
  w.u32(h.frameIdentifier);
  w.u32(h.frameIdentifier);
  w.u8(h.playerCarIndex);
  w.u8(255); // secondaryPlayerCarIndex: none
}

// F1 encodes some durations as a uint16 milliseconds part + uint8 minutes part.
function writeSplitMs(w, ms) {
  const total = Math.max(0, Math.round(ms));
  w.u16(total % 60000);
  w.u8(Math.floor(total / 60000));
}

function encodeCarTelemetry(h, cars) {
  const w = new BufferWriter(29 + NUM_CARS * SIZES.CAR_TELEMETRY + 3);
  writeHeader(w, PACKET_IDS.CAR_TELEMETRY, h);
  for (let i = 0; i < NUM_CARS; i++) {
    const c = cars[i] || {};
    const start = w.offset;
    w.u16(clampU16(c.speed || 0));
    w.f32(c.throttle || 0);
    w.f32(c.steer || 0);
    w.f32(c.brake || 0);
    w.u8(0); // clutch
    w.i8(c.gear || 0);
    w.u16(clampU16(c.engineRPM || 0));
    w.u8(c.drs ? 1 : 0);
    w.u8(clampU8(c.revLightsPercent || 0));
    w.u16(0); // revLightsBitValue
    for (const t of c.brakesTemperature || [0, 0, 0, 0]) w.u16(clampU16(t));
    for (const t of c.tyresSurfaceTemperature || [0, 0, 0, 0]) w.u8(clampU8(t));
    for (const t of c.tyresInnerTemperature || [0, 0, 0, 0]) w.u8(clampU8(t));
    w.u16(clampU16(c.engineTemperature || 0));
    for (const p of c.tyresPressure || [0, 0, 0, 0]) w.f32(p);
    for (let k = 0; k < 4; k++) w.u8(0); // surfaceType
    w.padTo(start, SIZES.CAR_TELEMETRY);
  }
  w.u8(255); // mfdPanelIndex
  w.u8(255); // mfdPanelIndexSecondaryPlayer
  w.i8(0); // suggestedGear
  return w.buf;
}

function encodeCarStatus(h, cars) {
  const w = new BufferWriter(29 + NUM_CARS * SIZES.CAR_STATUS);
  writeHeader(w, PACKET_IDS.CAR_STATUS, h);
  for (let i = 0; i < NUM_CARS; i++) {
    const c = cars[i] || {};
    const start = w.offset;
    w.u8(0); // tractionControl
    w.u8(0); // antiLockBrakes
    w.u8(c.fuelMix ?? 1);
    w.u8(c.frontBrakeBias ?? 56);
    w.u8(c.pitLimiterStatus ? 1 : 0);
    w.f32(c.fuelInTank || 0);
    w.f32(110); // fuelCapacity
    w.f32(c.fuelRemainingLaps || 0);
    w.u16(13000); // maxRPM
    w.u16(4000); // idleRPM
    w.u8(8); // maxGears
    w.u8(c.drsAllowed ? 1 : 0);
    w.u16(0); // drsActivationDistance
    w.u8(c.actualTyreCompound ?? 18);
    w.u8(c.visualTyreCompound ?? 17);
    w.u8(clampU8(c.tyresAgeLaps || 0));
    w.i8(0); // vehicleFiaFlags
    w.f32(0); // enginePowerICE
    w.f32(0); // enginePowerMGUK
    w.f32(c.ersStoreEnergy || 0);
    w.u8(c.ersDeployMode ?? 1);
    w.f32(0);
    w.f32(0);
    w.f32(0);
    w.u8(0); // networkPaused
    w.padTo(start, SIZES.CAR_STATUS);
  }
  return w.buf;
}

function encodeCarDamage(h, cars) {
  const w = new BufferWriter(29 + NUM_CARS * SIZES.CAR_DAMAGE);
  writeHeader(w, PACKET_IDS.CAR_DAMAGE, h);
  for (let i = 0; i < NUM_CARS; i++) {
    const c = cars[i] || {};
    const start = w.offset;
    for (const v of c.tyresWear || [0, 0, 0, 0]) w.f32(v);
    for (const v of c.tyresDamage || [0, 0, 0, 0]) w.u8(clampU8(v));
    for (let k = 0; k < 4; k++) w.u8(0); // brakesDamage
    for (const v of c.tyreBlisters || [0, 0, 0, 0]) w.u8(clampU8(v));
    w.u8(clampU8(c.frontLeftWingDamage || 0));
    w.u8(clampU8(c.frontRightWingDamage || 0));
    w.u8(clampU8(c.rearWingDamage || 0));
    w.u8(clampU8(c.floorDamage || 0));
    w.u8(clampU8(c.diffuserDamage || 0));
    w.u8(clampU8(c.sidepodDamage || 0));
    w.u8(0); // drsFault
    w.u8(0); // ersFault
    w.u8(clampU8(c.gearBoxDamage || 0));
    w.u8(clampU8(c.engineDamage || 0));
    w.padTo(start, SIZES.CAR_DAMAGE); // engine component wear, blown/seized flags
  }
  return w.buf;
}

function encodeLapData(h, cars) {
  const w = new BufferWriter(29 + NUM_CARS * SIZES.LAP_DATA + 2);
  writeHeader(w, PACKET_IDS.LAP_DATA, h);
  for (let i = 0; i < NUM_CARS; i++) {
    const c = cars[i] || {};
    const start = w.offset;
    w.u32(c.lastLapTimeInMS || 0);
    w.u32(c.currentLapTimeInMS || 0);
    writeSplitMs(w, c.sector1TimeInMS || 0);
    writeSplitMs(w, c.sector2TimeInMS || 0);
    writeSplitMs(w, c.deltaToCarInFrontInMS || 0);
    writeSplitMs(w, c.deltaToRaceLeaderInMS || 0);
    w.f32(c.lapDistance || 0);
    w.f32(c.totalDistance || 0);
    w.f32(0); // safetyCarDelta
    w.u8(c.carPosition || 0);
    w.u8(c.currentLapNum || 0);
    w.u8(c.pitStatus || 0);
    w.u8(c.numPitStops || 0);
    w.u8(c.sector || 0);
    w.u8(0); // currentLapInvalid
    w.u8(0); // penalties
    w.u8(0); // totalWarnings
    w.u8(0); // cornerCuttingWarnings
    w.u8(0); // numUnservedDriveThroughPens
    w.u8(0); // numUnservedStopGoPens
    w.u8(c.gridPosition || 0);
    w.u8(c.driverStatus ?? 4); // 4 = on track
    w.u8(c.resultStatus ?? 2); // 2 = active
    w.u8(c.pitLaneTimerActive ? 1 : 0);
    w.u16(0); // pitLaneTimeInLaneInMS
    w.u16(0); // pitStopTimerInMS
    w.u8(0); // pitStopShouldServePen
    w.padTo(start, SIZES.LAP_DATA); // speed trap fields
  }
  w.u8(255); // timeTrialPBCarIdx
  w.u8(255); // timeTrialRivalCarIdx
  return w.buf;
}

function encodeParticipants(h, participants) {
  const w = new BufferWriter(29 + 1 + NUM_CARS * SIZES.PARTICIPANT);
  writeHeader(w, PACKET_IDS.PARTICIPANTS, h);
  w.u8(participants.length);
  for (let i = 0; i < NUM_CARS; i++) {
    const p = participants[i] || {};
    const start = w.offset;
    w.u8(p.aiControlled ? 1 : 0);
    w.u8(p.driverId ?? 255);
    w.u8(0); // networkId
    w.u8(p.teamId ?? 0);
    w.u8(0); // myTeam
    w.u8(p.raceNumber || 0);
    w.u8(p.nationality || 0);
    w.buf.write((p.name || '').slice(0, 31), w.offset, 'utf8'); // char[32], null-padded
    w.padTo(start, SIZES.PARTICIPANT);
  }
  return w.buf;
}

function encodeSession(h, s) {
  const w = new BufferWriter(SIZES.SESSION_PACKET);
  writeHeader(w, PACKET_IDS.SESSION, h);
  w.u8(s.weather || 0);
  w.i8(s.trackTemperature || 0);
  w.i8(s.airTemperature || 0);
  w.u8(s.totalLaps || 0);
  w.u16(s.trackLength || 0);
  w.u8(s.sessionType ?? 15); // 15 = race
  w.i8(s.trackId ?? 0);
  w.u8(0); // formula: F1 modern
  w.u16(s.sessionTimeLeft || 0);
  w.u16(s.sessionDuration || 0);
  w.u8(80); // pitSpeedLimit
  w.u8(0); // gamePaused
  w.u8(0); // isSpectating
  w.u8(255); // spectatorCarIndex
  w.u8(0); // sliProNativeSupport
  const zones = s.numMarshalZones ?? 15;
  w.u8(zones);
  for (let z = 0; z < 21; z++) {
    w.f32(z < zones ? z / zones : 0);
    w.i8(0);
  }
  w.u8(s.safetyCarStatus || 0);
  w.u8(0); // networkGame
  const forecast = s.forecast || [];
  w.u8(forecast.length);
  for (let i = 0; i < 64; i++) {
    const f = forecast[i] || {};
    w.u8(f.sessionType ?? 0);
    w.u8(f.timeOffsetMin || 0);
    w.u8(f.weather || 0);
    w.i8(f.trackTemperature || 0);
    w.i8(f.trackTemperatureChange ?? 2);
    w.i8(f.airTemperature || 0);
    w.i8(f.airTemperatureChange ?? 2);
    w.u8(f.rainPercentage || 0);
  }
  w.u8(s.forecastAccuracy || 0);
  return w.buf; // remainder (assists, settings, etc.) stays zero-filled
}

// `detail` is the raw bytes of the event's detail union, e.g. [2, 0] for
// SCAR = Virtual Safety Car deployed.
function encodeEvent(h, code, detail = []) {
  const w = new BufferWriter(29 + 4 + 12);
  writeHeader(w, PACKET_IDS.EVENT, h);
  w.buf.write(code.slice(0, 4), w.offset, 'ascii');
  detail.forEach((b, k) => w.buf.writeUInt8(b, w.offset + 4 + k));
  return w.buf;
}

function encodeCarSetups(h, setups) {
  const w = new BufferWriter(29 + NUM_CARS * SIZES.CAR_SETUP + 4);
  writeHeader(w, PACKET_IDS.CAR_SETUPS, h);
  for (let i = 0; i < NUM_CARS; i++) {
    const s = setups[i] || {};
    const start = w.offset;
    w.u8(s.frontWing ?? 25);
    w.u8(s.rearWing ?? 22);
    w.u8(s.onThrottle ?? 60);
    w.u8(s.offThrottle ?? 55);
    w.f32(s.frontCamber ?? -3.0);
    w.f32(s.rearCamber ?? -1.5);
    w.f32(s.frontToe ?? 0.05);
    w.f32(s.rearToe ?? 0.2);
    w.u8(s.frontSuspension ?? 30);
    w.u8(s.rearSuspension ?? 12);
    w.u8(s.frontAntiRollBar ?? 10);
    w.u8(s.rearAntiRollBar ?? 6);
    w.u8(s.frontSuspensionHeight ?? 30);
    w.u8(s.rearSuspensionHeight ?? 60);
    w.u8(s.brakePressure ?? 100);
    w.u8(s.brakeBias ?? 56);
    w.u8(s.engineBraking ?? 50);
    w.padTo(start, SIZES.CAR_SETUP); // tyre pressures, ballast, fuel load
  }
  w.f32(0); // nextFrontWingValue
  return w.buf;
}

// Player's car only. Arrays in the game's wheel order: RL, RR, FL, FR.
function encodeMotionEx(h, m) {
  const w = new BufferWriter(SIZES.MOTION_EX_PACKET);
  writeHeader(w, PACKET_IDS.MOTION_EX, h);
  for (const key of ['suspensionPosition', 'suspensionVelocity', 'suspensionAcceleration', 'wheelSpeed', 'wheelSlipRatio', 'wheelSlipAngle']) {
    for (const v of m[key] || [0, 0, 0, 0]) w.f32(v);
  }
  return w.buf; // forces, velocities, aero heights, camber: zero-filled
}

module.exports = {
  NUM_CARS,
  SIZES,
  encodeCarSetups,
  encodeMotionEx,
  encodeCarTelemetry,
  encodeCarStatus,
  encodeCarDamage,
  encodeLapData,
  encodeParticipants,
  encodeSession,
  encodeEvent,
};
