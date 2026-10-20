const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDebrief } = require('../src/engine/debrief');

// Just the FieldModel surface the debrief reads: the player (car 0) and one
// rival, a finished race, and the official result.
function fakeField({ classified, playerTraces = [], rivalTraces = [], sessionType = 15 }) {
  const lapData = (pos) => ({ carPosition: pos, currentLapNum: 3, gridPosition: 4, numPitStops: 1, resultStatus: 3, sector1TimeInMS: 0, sector2TimeInMS: 0 });
  const sh = (s1, s2, s3) => ({ laps: [{ lapMs: s1 + s2 + s3, s1, s2, s3, valid: true }, { lapMs: 99000, s1: 1, s2: 1, s3: 1, valid: false }] });
  const cars = [
    { carIndex: 0, participant: { name: 'ME' }, lapData: lapData(2), status: { visualTyreCompound: 17, tyresAgeLaps: 3, fuelInTank: 5, ersStoreEnergy: 2e6 }, damage: { tyresWear: [10, 10, 10, 10] }, lapHistory: [{ lapNum: 1, lapMs: 80000 }, { lapNum: 2, lapMs: 79000 }], sessionHistory: sh(20000, 30000, 29000) },
    { carIndex: 1, participant: { name: 'RIVAL' }, lapData: lapData(1), status: { visualTyreCompound: 16 }, lapHistory: [{ lapNum: 2, lapMs: 78500 }], sessionHistory: sh(20500, 29500, 28500) },
  ];
  return {
    getGeneration: () => 1,
    getSession: () => ({ sessionType, trackId: 13, totalLaps: 3, trackLength: 5800 }),
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

test('debrief in qualifying: each best is the game best valid lap, not the laps seen in passing (Spa, 20 Oct 2026)', () => {
  // The Field showed LECLERC 1:56.780 against his 1:45.950: the game drops cars on track mid-lap there.
  const f = fakeField({ classified: false, sessionType: 8 });
  f.getCar(1).lapHistory = [{ lapNum: 2, lapMs: 116780 }];
  f.getCar(1).sessionHistory.bestLapNum = 1;
  const d = createDebrief(f);
  d.tick();
  const rival = d.view().sessions[0].field.find((x) => x.name === 'RIVAL');
  assert.strictEqual(rival.bestMs, 78500);
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

test('debrief: the session store keeps the newest 50 on disk (roadmap D5)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debrief-'));
  try {
    // 55 older sessions (named by start time, as saved), plus a stray file that isn't a session.
    for (let k = 0; k < 55; k++) fs.writeFileSync(path.join(dir, `2020-01-01-00-00-${String(k).padStart(2, '0')}_Old_Race.json.gz`), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
    const d = createDebrief(fakeField({ classified: true }), { dir });
    d.tick(); // the classification saves this session
    const sessions = fs.readdirSync(dir).filter((n) => n.endsWith('.json.gz')).sort();
    assert.strictEqual(sessions.length, 50);
    assert.match(sessions[49], /_Suzuka_Race\.json\.gz$/); // the new one is kept
    assert.strictEqual(sessions[0], '2020-01-01-00-00-06_Old_Race.json.gz'); // the six oldest went
    assert.ok(fs.existsSync(path.join(dir, 'notes.txt')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('debrief: a penalty a flashback undid is not on the record (Barcelona, 17 Oct 2026)', () => {
  // A crash, a stop-go, then a flashback to before it: the race went on without the penalty.
  const f = fakeField({ classified: false });
  let now = 100;
  const events = [];
  f.getSessionTime = () => now;
  f.getRecentEvents = () => events;
  const d = createDebrief(f);
  events.push({ seq: 1, code: 'PENA', vehicleIdx: 0, penaltyType: 0, name: 'Stop-go penalty', lapNum: 3, timeS: 10, sessionTime: 100 });
  d.tick();
  assert.strictEqual(d.current().penalties.length, 1);
  now = 101;
  d.tick();
  assert.strictEqual(d.current().penalties.length, 1, 'still there as time goes on');
  now = 95; // the flashback
  d.tick();
  assert.deepStrictEqual(d.current().penalties, []);
});
