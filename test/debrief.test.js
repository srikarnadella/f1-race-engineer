const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDebrief } = require('../src/state/debrief');

// Just the FieldModel surface the debrief reads: the player (car 0) and one
// rival, a finished race, and the official result.
function fakeField({ classified, playerTraces = [], rivalTraces = [] }) {
  const lapData = (pos) => ({ carPosition: pos, currentLapNum: 3, gridPosition: 4, numPitStops: 1, resultStatus: 3, sector1TimeInMS: 0, sector2TimeInMS: 0 });
  const sh = (s1, s2, s3) => ({ laps: [{ lapMs: s1 + s2 + s3, s1, s2, s3, valid: true }, { lapMs: 99000, s1: 1, s2: 1, s3: 1, valid: false }] });
  const cars = [
    { carIndex: 0, participant: { name: 'ME' }, lapData: lapData(2), status: { visualTyreCompound: 17, tyresAgeLaps: 3, fuelInTank: 5, ersStoreEnergy: 2e6 }, damage: { tyresWear: [10, 10, 10, 10] }, lapHistory: [{ lapNum: 1, lapMs: 80000 }, { lapNum: 2, lapMs: 79000 }], sessionHistory: sh(20000, 30000, 29000) },
    { carIndex: 1, participant: { name: 'RIVAL' }, lapData: lapData(1), status: { visualTyreCompound: 16 }, lapHistory: [{ lapNum: 2, lapMs: 78500 }], sessionHistory: sh(20500, 29500, 28500) },
  ];
  return {
    getGeneration: () => 1,
    getSession: () => ({ sessionType: 15, trackId: 13, totalLaps: 3, trackLength: 5800 }),
    takePlayerLapTraces: () => playerTraces.splice(0),
    takeRivalLapTraces: () => rivalTraces.splice(0),
    playerIndex: () => 0,
    getCar: (i) => cars[i],
    orderedByPosition: () => [cars[1], cars[0]],
    getRecentEvents: () => [],
    getClassification: () => (classified ? { cars: [{ position: 3, gridPosition: 5, points: 15 }, { position: 1, gridPosition: 1, points: 25 }] } : null),
    getLapPositions: () => ({ lapStart: 0, laps: [[4, 1], [3, 1], [2, 1]] }),
  };
}

test('debrief: official result, sector gaps and position chart; saved and reloaded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debrief-'));
  try {
    const d = createDebrief(fakeField({ classified: true }), { dir });
    d.tick();
    const [s] = d.view().sessions;
    // The Final Classification wins over the live position (P2 on track).
    assert.deepStrictEqual([s.finish, s.grid, s.positionsGained, s.points, s.official], [3, 5, 2, 15, true]);
    // Fastest valid sectors across the field - the invalid 1 ms lap is ignored.
    assert.deepStrictEqual(s.fieldBestSectors.map((x) => [x.ms, x.name]), [[20000, 'You'], [29500, 'RIVAL'], [28500, 'RIVAL']]);
    assert.deepStrictEqual(s.positionChart.cars.find((c) => c.isPlayer).positions, [4, 3, 2]);

    // The classification ends the session, so it's on disk already...
    const files = fs.readdirSync(dir);
    assert.strictEqual(files.length, 1);
    assert.match(files[0], /_Suzuka_Race\.json\.gz$/);
    // ...and a fresh start (no live session yet) brings it back.
    const reloaded = createDebrief(fakeField({ classified: false }), { dir }).view().sessions;
    assert.strictEqual(reloaded.length, 1);
    assert.deepStrictEqual([reloaded[0].finish, reloaded[0].live, reloaded[0].laps.length], [3, false, 1]); // one tick records the newest lap
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('debrief: nothing is written without a directory', () => {
  const d = createDebrief(fakeField({ classified: true }));
  d.tick();
  d.flush();
  assert.strictEqual(d.view().sessions[0].official, true);
});

test('debrief: your best lap against a rival best lap, kept with the session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debrief-'));
  // 5.8 km at a steady speed, a point every 2 m: [d, tMs, speed, throttle, brake, steer, gear].
  const trace = (lapNum, kmh, extra = {}) => ({
    lapNum, startedAtLine: true, invalid: false, lapMs: Math.round((5800 / (kmh / 3.6)) * 1000),
    points: Array.from({ length: 2900 }, (_, k) => [k * 2, Math.round(((k * 2) / (kmh / 3.6)) * 1000), kmh, 1, 0, 0, 7]),
    ...extra,
  });
  try {
    const field = fakeField({ classified: false, playerTraces: [trace(2, 264)], rivalTraces: [{ carIndex: 1, ...trace(2, 266) }, { carIndex: 1, ...trace(1, 300) }] });
    const d = createDebrief(field, { dir });
    d.tick();
    const [s] = d.view().sessions;
    const c = d.compare(s.id, null, 'r1');
    // Their lap is the reference: the gap is yours to them (0.6 s slower over 5.8 km).
    assert.strictEqual(c.lapA.rival, 'RIVAL');
    assert.strictEqual(c.lapB.lapNum, 2);
    assert.ok(c.totalS > 0.5 && c.totalS < 0.7, c.totalS);
    assert.deepStrictEqual(c.rivals.map((r) => [r.id, r.name, r.lapNum]), [['r1', 'RIVAL', 2]]); // lap 1 (the start) isn't a best lap
    d.flush();
    const again = createDebrief(fakeField({ classified: false }), { dir });
    assert.strictEqual(again.compare(again.view().sessions.find((x) => !x.live).id, null, 'r1').lapA.rival, 'RIVAL');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
