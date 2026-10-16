// Regression tests on real F1 26 packets (packet format 2026), captured
// from the game in a Montreal time trial. These pin the layout changes found
// in that capture: 24 car slots, a 59-byte telemetry struct (uint8 engine
// temperature), a 59-byte status struct, 3 extra participant bytes before
// the name, and a longer session packet.
const test = require('node:test');
const assert = require('node:assert');
const PACKET_IDS = require('../src/udp/packetIds');
const { parsePacket } = require('../src/udp/parsePacket');
const fixtures = require('./fixtures/f1-26-packets.json');

const warnings = [];
const packet = (id) => {
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    return parsePacket(Buffer.from(fixtures[id], 'hex'));
  } finally {
    console.warn = realWarn;
  }
};

test('F1 26: header says packet format 2026, player is car 0', () => {
  const { header } = packet(PACKET_IDS.CAR_TELEMETRY);
  assert.strictEqual(header.packetFormat, 2026);
  assert.strictEqual(header.playerCarIndex, 0);
});

test('F1 26: every per-car packet has 24 slots and parses without a size warning', () => {
  for (const id of [PACKET_IDS.LAP_DATA, PACKET_IDS.CAR_SETUPS, PACKET_IDS.CAR_TELEMETRY, PACKET_IDS.CAR_STATUS, PACKET_IDS.CAR_DAMAGE]) {
    assert.strictEqual(packet(id).data.cars.length, 24, `packet ${id}`);
  }
  assert.strictEqual(packet(PACKET_IDS.PARTICIPANTS).data.participants.length, 24);
  assert.deepStrictEqual(warnings, []);
});

test('F1 26: car telemetry decodes past the shrunken engine temperature', () => {
  const car = packet(PACKET_IDS.CAR_TELEMETRY).data.cars[0];
  assert.ok(car.speed > 0 && car.speed < 400, `speed ${car.speed}`);
  assert.ok(car.gear >= 1 && car.gear <= 8, `gear ${car.gear}`);
  assert.ok(car.engineTemperature > 60 && car.engineTemperature < 150, `engine ${car.engineTemperature}`);
  for (const p of car.tyresPressure) assert.ok(p > 15 && p < 35, `pressure ${p}`);
  for (const s of car.surfaceType) assert.ok(s >= 0 && s < 20, `surface ${s}`);
});

test('F1 26: car status keeps its F1 25 fields', () => {
  const car = packet(PACKET_IDS.CAR_STATUS).data.cars[0];
  assert.strictEqual(car.frontBrakeBias, 57);
  assert.strictEqual(car.fuelCapacity, 110);
  assert.strictEqual(car.visualTyreCompound, 16);
  assert.ok(Math.abs(car.ersStoreEnergy - 4e6) < 1e5, `ers ${car.ersStoreEnergy}`);
  // The new 2026 field sits before ersDeployedThisLap.
  assert.ok(Math.abs(car.ersHarvestLimitPerLap - 6.2e6) < 1e5, `harvest limit ${car.ersHarvestLimitPerLap}`);
  assert.strictEqual(car.ersDeployedThisLap, 0);
  assert.strictEqual(car.networkPaused, 0);
});

test('F1 26: participant names sit 3 bytes later than in F1 25', () => {
  const names = packet(PACKET_IDS.PARTICIPANTS).data.participants.map((p) => p.name).filter(Boolean);
  assert.deepStrictEqual(names.slice(0, 3), ['PLAYER', 'Default Ghost', 'Personal Best']);
});

test('F1 26: Car Telemetry 2 carries Overtake mode and active aero for 24 cars', () => {
  const { header, data } = packet(PACKET_IDS.CAR_TELEMETRY_2);
  assert.strictEqual(data.cars.length, 24);
  const me = data.cars[header.playerCarIndex];
  assert.strictEqual(me.regulations2026, true);
  assert.strictEqual(me.overtakeAvailable, true);
  assert.ok([0, 1].includes(me.activeAeroMode));
  assert.strictEqual(me.wrongWay, false);
});

test('F1 26: session, setups, lap data and motion ex keep their F1 25 layouts', () => {
  const s = packet(PACKET_IDS.SESSION).data;
  assert.deepStrictEqual([s.sessionType, s.trackId, s.trackLength, s.numMarshalZones, s.safetyCarStatus], [18, 6, 4371, 15, 0]);
  const setup = packet(PACKET_IDS.CAR_SETUPS).data.cars[0];
  assert.deepStrictEqual([setup.onThrottle, setup.offThrottle, setup.brakeBias, setup.engineBraking], [60, 50, 57, 50]);
  assert.ok(Math.abs(setup.frontCamber + 3.5) < 1e-6);
  const lap = packet(PACKET_IDS.LAP_DATA).data.cars[0];
  assert.deepStrictEqual([lap.carPosition, lap.currentLapNum, lap.pitStatus], [1, 1, 0]);
  assert.ok(lap.lapDistance > 0 && lap.lapDistance < s.trackLength);
  const mx = packet(PACKET_IDS.MOTION_EX).data;
  for (const v of mx.wheelSlipRatio) assert.ok(Math.abs(v) < 5, `slip ${v}`);
});

test('F1 26: Final Classification - 24 slots of 46 bytes, a full result for the 22 finishers', () => {
  const { data } = packet(PACKET_IDS.FINAL_CLASSIFICATION);
  assert.strictEqual(data.numCars, 22);
  const placed = data.cars.filter((c) => c.position).map((c) => c.position).sort((a, b) => a - b);
  assert.deepStrictEqual(placed, Array.from({ length: 22 }, (_, i) => i + 1));
  const p6 = data.cars.find((c) => c.position === 6);
  assert.deepStrictEqual([p6.gridPosition, p6.points, p6.numPitStops, p6.bestLapTimeInMS, p6.tyreStintsVisual], [10, 8, 1, 76545, [18, 17]]);
});

test('F1 26: Session History - lap and sector times add up', () => {
  const { data } = packet(PACKET_IDS.SESSION_HISTORY);
  assert.ok(data.laps.length > 5);
  for (const l of data.laps.filter((x) => x.valid && x.lapMs)) assert.ok(Math.abs(l.s1 + l.s2 + l.s3 - l.lapMs) <= 3, `lap ${l.lapMs} vs sectors`);
});

test('F1 26: Lap Positions - every lap a permutation of the running order', () => {
  const { data } = packet(PACKET_IDS.LAP_POSITIONS);
  assert.ok(data.laps.length > 20);
  const first = data.laps[0].filter(Boolean).sort((a, b) => a - b);
  assert.deepStrictEqual(first, Array.from({ length: 22 }, (_, i) => i + 1));
});
