const test = require('node:test');
const assert = require('node:assert');
const { createLapRecorder, createCallRecorder, toCsv, fromCsv, LAP_COLUMNS, CALL_SCHEMA } = require('../src/data/laps');
const { auditCalls } = require('../src/analysis/callsAudit');
const { syntheticPackets, replay } = require('./helpers/synthetic');

// The lap dataset: one row per car per completed lap, recorded as laps
// complete (the field model keeps only the last 12), and taken back when a
// flashback undoes them.

// Just the field model surface the recorder reads.
function fakeField() {
  const cars = [0, 1].map((carIndex) => ({
    carIndex,
    lapHistory: [],
    lapData: { currentLapNum: 1, carPosition: carIndex + 1, deltaToRaceLeaderInMS: carIndex * 1500, numPitStops: 0, resultStatus: 2 },
    status: { visualTyreCompound: 17, tyresAgeLaps: 0, fuelInTank: 10 },
    damage: { tyresWear: [1, 2, 3, 4] },
    tyreSets: [{ fitted: true, usableLife: 20 }],
  }));
  return {
    cars,
    orderedByPosition: () => cars,
    getCar: (i) => cars[i],
    getSession: () => ({ trackId: 5, sessionType: 15, totalLaps: 30, safetyCarStatus: 0 }),
    playerIndex: () => 0,
    complete(carIndex, lapNum, lapMs, extra = {}) {
      const car = cars[carIndex];
      car.lapHistory.push({ lapNum, lapMs, pit: false, neutralised: false, compound: 17, tyreAge: lapNum - 1, fuelKg: 10 - lapNum, ...extra });
      car.lapData.currentLapNum = lapNum + 1;
    },
  };
}

test('laps: each completed lap once per car, with the race state at the line', () => {
  const fm = fakeField();
  const rec = createLapRecorder(fm, { raceId: 'r1' });
  fm.complete(0, 1, 92000);
  rec.sync();
  rec.sync(); // a second look at the same lap adds nothing
  fm.complete(1, 1, 93000);
  fm.complete(0, 2, 90000);
  rec.sync();
  const rows = rec.rows();
  assert.deepStrictEqual(rows.map((r) => [r.carIndex, r.lapNum, r.lapMs]), [[0, 1, 92000], [0, 2, 90000], [1, 1, 93000]]);
  const r = rows[1];
  assert.strictEqual(r.raceId, 'r1');
  assert.strictEqual(r.track, 'Monaco');
  assert.strictEqual(r.isPlayer, true);
  assert.strictEqual(r.wearMax, 4);
  assert.strictEqual(r.usableLife, 20);
  assert.strictEqual(r.totalLaps, 30);
});

test('laps: a flashback that undoes laps takes their rows back', () => {
  const fm = fakeField();
  const rec = createLapRecorder(fm, { raceId: 'r1' });
  for (let lap = 1; lap <= 4; lap++) fm.complete(0, lap, 90000 + lap);
  rec.sync();
  // Back to lap 3: laps 3 and 4 never happened.
  fm.cars[0].lapHistory = fm.cars[0].lapHistory.filter((l) => l.lapNum < 3);
  fm.cars[0].lapData.currentLapNum = 3;
  rec.sync();
  fm.complete(0, 3, 95000);
  rec.sync();
  assert.deepStrictEqual(rec.rows().map((r) => [r.lapNum, r.lapMs]), [[1, 90001], [2, 90002], [3, 95000]]);
});

test('laps: the last lap at the flag is kept, though the lap counter never moves on', () => {
  const fm = fakeField();
  const rec = createLapRecorder(fm, { raceId: 'r1' });
  fm.complete(0, 1, 90000);
  rec.sync();
  // Crossing the line at the flag: the lap is recorded, the counter stays, the car is finished.
  fm.cars[0].lapHistory.push({ lapNum: 2, lapMs: 89000, pit: false, neutralised: false, compound: 17, tyreAge: 1, fuelKg: 8 });
  fm.cars[0].lapData.resultStatus = 3;
  rec.sync();
  assert.deepStrictEqual(rec.rows().map((r) => r.lapNum), [1, 2]);
});

test('laps: laps older than the field model keeps are not lost', () => {
  const fm = fakeField();
  const rec = createLapRecorder(fm, { raceId: 'r1' });
  for (let lap = 1; lap <= 30; lap++) {
    fm.complete(0, lap, 90000 + lap);
    fm.cars[0].lapHistory = fm.cars[0].lapHistory.slice(-12);
    rec.sync();
  }
  assert.strictEqual(rec.rows().length, 30);
});

test('laps: CSV round trip keeps types; no driver names in the columns', () => {
  const fm = fakeField();
  const rec = createLapRecorder(fm, { raceId: 'r1' });
  fm.complete(0, 1, 92000, { pit: true });
  rec.sync();
  const csv = toCsv(rec.rows());
  assert.strictEqual(csv.split('\n')[0], LAP_COLUMNS.join(','));
  assert.ok(!LAP_COLUMNS.some((c) => /name/i.test(c)), 'a player name could be a gamertag');
  assert.deepStrictEqual(fromCsv(csv), rec.rows());
});

test('laps: the synthetic race through the real pipeline gives one row per car per lap it completed', () => {
  let rec = null;
  replay(syntheticPackets(), {
    onTick: ({ tMs, pipeline }) => {
      if (!rec) rec = createLapRecorder(pipeline.fieldModel, { raceId: 'synthetic' });
      if (tMs % 1000 < 100) rec.sync();
    },
  });
  const rows = rec.rows();
  const keys = new Set(rows.map((r) => `${r.carIndex}:${r.lapNum}`));
  assert.strictEqual(keys.size, rows.length, 'no duplicates');
  assert.strictEqual(new Set(rows.map((r) => r.carIndex)).size, 22);
  assert.ok(rows.every((r) => r.lapMs > 60000 && r.lapMs < 120000), 'lap times are lap times');
  const ham = rows.filter((r) => r.carIndex === 5);
  assert.ok(ham.some((r) => r.pit), 'HAMILTON pits on lap 15/16');
});

// The calls a race made (for the calls audit): one row each time the call
// changes, on the player's lap at the time.
const snapWith = (action, kind, reason = '') => ({ strategy: { call: { action, kind, reason } } });

test('calls: a row when the call changes, not when its numbers tick; qualifying calls skipped', () => {
  const fm = fakeField();
  const rec = createCallRecorder(fm, { raceId: 'r1' });
  rec.sync(snapWith('PUSH', 'ok'));
  rec.sync(snapWith('PUSH', 'ok'));
  rec.sync(snapWith('PUSH', 'undercut'));
  fm.complete(0, 1, 90000);
  rec.sync(snapWith('BOX', 'cheap-stop', 'Safety car: a stop costs ~9s, not ~20s'));
  rec.sync(snapWith('BOX', 'cheap-stop', 'Safety car: a stop costs ~8s, not ~20s'));
  rec.sync({ strategy: { call: { action: 'PUSH', reason: 'On for P3' } } }); // qualifying: no kind
  rec.sync({ strategy: null });
  assert.deepStrictEqual(rec.rows(), [
    { raceId: 'r1', lapNum: 1, action: 'PUSH', kind: 'ok' },
    { raceId: 'r1', lapNum: 1, action: 'PUSH', kind: 'undercut' },
    { raceId: 'r1', lapNum: 2, action: 'BOX', kind: 'cheap-stop' },
  ]);
});

test('calls: a flashback takes back the calls made on the laps it undid', () => {
  const fm = fakeField();
  const rec = createCallRecorder(fm, { raceId: 'r1' });
  rec.sync(snapWith('PUSH', 'ok'));
  for (let lap = 1; lap <= 3; lap++) fm.complete(0, lap, 90000);
  rec.sync(snapWith('BOX', 'damage'));
  fm.cars[0].lapData.currentLapNum = 2; // back to lap 2
  rec.sync(snapWith('PUSH', 'ok'));
  assert.deepStrictEqual(rec.rows().map((r) => [r.lapNum, r.kind]), [[1, 'ok']], 'the BOX on lap 4 never happened; PUSH is still the call');
});

test('calls: CSV round trip', () => {
  const rows = [{ raceId: 'r1', lapNum: 3, action: 'BOX', kind: 'cheap-stop' }];
  assert.deepStrictEqual(fromCsv(toCsv(rows, CALL_SCHEMA), CALL_SCHEMA), rows);
});

test('calls: every race call in the synthetic race has a kind the audit grades or names as a rule', () => {
  let laps = null;
  let calls = null;
  replay(syntheticPackets(), {
    onTick: ({ tMs, snap, pipeline }) => {
      if (!laps) {
        laps = createLapRecorder(pipeline.fieldModel, { raceId: 'synthetic' });
        calls = createCallRecorder(pipeline.fieldModel, { raceId: 'synthetic' });
      }
      calls.sync(snap);
      if (tMs % 1000 < 100) laps.sync();
    },
  });
  laps.sync();
  const audit = auditCalls(calls.rows(), laps.rows());
  assert.ok(audit.calls.length >= 3, JSON.stringify(audit.calls));
  for (const c of audit.calls) assert.notStrictEqual(c.why, 'No test for this call yet', `${c.action} ${c.kind} on lap ${c.lapNum}`);
  assert.ok(audit.summary.right + audit.summary.wrong >= 1, JSON.stringify(audit.summary));
});
