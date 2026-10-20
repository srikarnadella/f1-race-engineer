const test = require('node:test');
const assert = require('node:assert');
const enc = require('../src/sim/encoders');
const PACKET_IDS = require('../src/udp/packetIds');
const { parsePacket } = require('../src/udp/parsePacket');

const H = { sessionUID: 42n, sessionTime: 123.5, frameIdentifier: 7, playerCarIndex: 3 };
const cars = (fn) => Array.from({ length: enc.NUM_CARS }, (_, i) => fn(i));

test('header round-trips', () => {
  const { header } = parsePacket(enc.encodeEvent(H, 'FTLP'));
  assert.strictEqual(header.packetId, PACKET_IDS.EVENT);
  assert.strictEqual(header.sessionUID, 42n);
  assert.strictEqual(header.playerCarIndex, 3);
  assert.ok(Math.abs(header.sessionTime - 123.5) < 1e-4);
});

test('car telemetry: every car, every glance field', () => {
  const { data } = parsePacket(enc.encodeCarTelemetry(H, cars((i) => ({ speed: 100 + i, gear: 5, engineRPM: 11000, drs: 1, tyresSurfaceTemperature: [90, 91, 92, 93] }))));
  assert.strictEqual(data.cars.length, 22);
  assert.strictEqual(data.cars[21].speed, 121);
  assert.strictEqual(data.cars[0].gear, 5);
  assert.strictEqual(data.cars[0].drs, 1);
  assert.deepStrictEqual(data.cars[0].tyresSurfaceTemperature, [90, 91, 92, 93]);
});

test('car status: fuel, ERS and tyre fields', () => {
  const { data } = parsePacket(enc.encodeCarStatus(H, cars(() => ({ fuelInTank: 12.5, fuelRemainingLaps: 7.25, actualTyreCompound: 19, tyresAgeLaps: 16, ersStoreEnergy: 3e6 }))));
  assert.strictEqual(data.cars.length, 22);
  assert.strictEqual(data.cars[5].fuelInTank, 12.5);
  assert.strictEqual(data.cars[5].fuelRemainingLaps, 7.25);
  assert.strictEqual(data.cars[5].actualTyreCompound, 19);
  assert.strictEqual(data.cars[5].tyresAgeLaps, 16);
  assert.strictEqual(data.cars[5].ersStoreEnergy, 3e6);
});

test('car damage: F1 25 layout (with tyre blisters) keeps wing damage aligned', () => {
  const { data } = parsePacket(enc.encodeCarDamage(H, cars(() => ({ tyresWear: [10, 20, 30, 40], tyreBlisters: [1, 2, 3, 4], frontLeftWingDamage: 12, rearWingDamage: 5, engineDamage: 9 }))));
  const c = data.cars[0];
  assert.deepStrictEqual(c.tyresWear, [10, 20, 30, 40]);
  assert.deepStrictEqual(c.tyreBlisters, [1, 2, 3, 4]);
  assert.strictEqual(c.frontLeftWingDamage, 12);
  assert.strictEqual(c.rearWingDamage, 5);
  assert.strictEqual(c.engineDamage, 9);
});

test('lap data: split minute/ms fields recombine, all cars parsed', () => {
  const { data } = parsePacket(enc.encodeLapData(H, cars((i) => ({ carPosition: i + 1, currentLapNum: 15, lastLapTimeInMS: 66123, deltaToCarInFrontInMS: 61234, pitStatus: i === 4 ? 1 : 0, lapDistance: 1000 }))));
  assert.strictEqual(data.cars.length, 22);
  assert.strictEqual(data.cars[21].carPosition, 22);
  assert.strictEqual(data.cars[0].lastLapTimeInMS, 66123);
  assert.strictEqual(data.cars[0].deltaToCarInFrontInMS, 61234); // 1 min + 1234ms
  assert.strictEqual(data.cars[4].pitStatus, 1);
  assert.strictEqual(data.cars[0].lapDistance, 1000);
});

test('participants: names are null-terminated within a 57-byte struct', () => {
  const { data } = parsePacket(enc.encodeParticipants(H, cars((i) => ({ name: `DRIVER${i}`, teamId: i % 10, raceNumber: i + 1 }))));
  assert.strictEqual(data.participants.length, 22);
  assert.strictEqual(data.participants[0].name, 'DRIVER0');
  assert.strictEqual(data.participants[21].name, 'DRIVER21');
  assert.strictEqual(data.participants[21].raceNumber, 22);
});

test('session: safetyCarStatus read past the fixed 21-slot marshal zone array', () => {
  // Fewer than 21 zones in use - the old numMarshalZones-based skip misread this.
  const { data } = parsePacket(enc.encodeSession(H, { totalLaps: 22, trackLength: 4318, trackTemperature: 38, numMarshalZones: 15, safetyCarStatus: 2 }));
  assert.strictEqual(data.totalLaps, 22);
  assert.strictEqual(data.trackLength, 4318);
  assert.strictEqual(data.trackTemperature, 38);
  assert.strictEqual(data.safetyCarStatus, 2);
});

test('event: 4-char code mapped to a label', () => {
  const { data } = parsePacket(enc.encodeEvent(H, 'RDFL'));
  assert.deepStrictEqual(data, { code: 'RDFL', name: 'Red Flag' });
});

test('unhandled packet types return data: null rather than throwing', () => {
  const buf = enc.encodeEvent(H, 'XXXX');
  buf[6] = PACKET_IDS.MOTION;
  assert.strictEqual(parsePacket(buf).data, null);
});

test('event: safety car detail distinguishes VSC deployed from race resumed', () => {
  const deployed = parsePacket(enc.encodeEvent(H, 'SCAR', [2, 0])).data;
  assert.strictEqual(deployed.name, 'Virtual Safety Car deployed');
  assert.strictEqual(deployed.safetyCarEventType, 0);
  assert.strictEqual(parsePacket(enc.encodeEvent(H, 'SCAR', [1, 3])).data.name, 'Safety Car race resumed');
});

test('event: speed trap and collision name the cars (layout checked on an F1 26 race)', () => {
  // Speed trap: car 4 at 293.6 km/h, the fastest so far (float32 little-endian).
  const f = Buffer.alloc(4);
  f.writeFloatLE(293.6);
  const trap = parsePacket(enc.encodeEvent(H, 'SPTP', [4, ...f, 1, 1, 4, ...f])).data;
  assert.deepStrictEqual([trap.vehicleIdx, +trap.speedKmh.toFixed(1), trap.isOverallFastest], [4, 293.6, true]);
  const coll = parsePacket(enc.encodeEvent(H, 'COLL', [11, 8])).data;
  assert.deepStrictEqual([coll.name, coll.vehicleIdx, coll.otherVehicleIdx], ['Collision', 11, 8]);
});

test('a car-count mismatch degrades to a warning, not a throw', () => {
  const buf = enc.encodeLapData(H, []);
  const warn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(m);
  try {
    // Pretend 21 cars: 1255 bytes doesn't divide evenly, so the stride is fractional.
    const { parseLapData } = require('../src/udp/parsers/lapData');
    assert.doesNotThrow(() => parseLapData(buf, 21));
  } finally {
    console.warn = warn;
  }
  assert.ok(warnings.some((m) => /size mismatch/.test(m)));
});

test('session: the weekend ID, after the forecast (shared by every session of a weekend)', () => {
  const { data } = parsePacket(enc.encodeSession(H, { sessionType: 15, weekendLinkIdentifier: 2227884873 }));
  assert.strictEqual(data.weekendLinkIdentifier, 2227884873);
});
