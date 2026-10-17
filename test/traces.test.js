const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRecorder } = require('../src/capture/recorder');
const { readLog } = require('../src/capture/logFile');
const { startReplay } = require('../src/capture/replay');
const { createLapTraceRecorder, createMiniSectorTracker, MINI_SECTORS } = require('../src/state/lapTrace');
const { syntheticPackets } = require('./helpers/synthetic');

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'f1-')), name);

for (const ext of ['.f1log', '.f1log.gz']) {
  test(`recorder -> log (${ext}): every packet back byte for byte, in order, with its time`, async () => {
    const file = tmp(`r${ext}`);
    const packets = syntheticPackets().slice(0, 500);
    const real = Date.now;
    let t = 1000;
    Date.now = () => t;
    try {
      const rec = createRecorder(file, 1000);
      for (const p of packets) {
        t = 1000 + p.tMs;
        rec.record(p.buf);
      }
      await rec.close();
    } finally {
      Date.now = real;
    }
    const back = [];
    for await (const row of readLog(file)) back.push(row);
    assert.strictEqual(back.length, packets.length);
    back.forEach((row, i) => {
      assert.strictEqual(row.tMs, packets[i].tMs);
      assert.ok(row.buf.equals(packets[i].buf), `packet ${i}`);
    });
  });
}

test('replay: the recording goes through the parser once per pass, in order', async () => {
  const file = tmp('p.f1log');
  const packets = syntheticPackets().slice(0, 300).map((p) => ({ ...p, tMs: 0 })); // no waiting
  const rec = createRecorder(file, Date.now());
  for (const p of packets) rec.record(p.buf);
  await rec.close();
  const seen = [];
  let loops = 0;
  await startReplay({ filePath: file, loop: false, onLoopStart: () => loops++, onPacket: (id, header) => seen.push([id, header.frameIdentifier]) });
  assert.strictEqual(loops, 1);
  // Every packet the synthetic race sends is one the pipeline reads.
  assert.deepStrictEqual(seen, packets.map((p) => [p.buf[6], p.buf.readUInt32LE(19)]));
});

// A lap driven at constant speed: Lap Data and telemetry every `stepM` metres.
function* drive(lapNum, { from = 0, to = 1000, stepM = 5, msPerM = 20, pit = () => 0, invalidAt = null } = {}) {
  for (let d = from; d <= to; d += stepM) {
    yield [{ currentLapNum: lapNum, lapDistance: d, currentLapTimeInMS: d * msPerM, lastLapTimeInMS: 20000, pitStatus: pit(d), currentLapInvalid: invalidAt != null && d >= invalidAt ? 1 : 0 }, { speed: 180, throttle: 1, brake: 0, steer: 0, gear: 6 }];
  }
}

test('lap trace: a lap driven forwards is handed over once, sampled every 2 m', () => {
  const rec = createLapTraceRecorder();
  for (const [lap, tel] of drive(2, { stepM: 1 })) rec.update(lap, tel);
  for (const [lap, tel] of drive(3, { to: 10 })) rec.update(lap, tel);
  const [trace, ...more] = rec.take();
  assert.strictEqual(more.length, 0);
  assert.strictEqual(trace.lapNum, 2);
  assert.strictEqual(trace.startedAtLine, true);
  assert.strictEqual(trace.invalid, false);
  assert.strictEqual(trace.points.length, 501);
  for (let i = 1; i < trace.points.length; i++) assert.strictEqual(trace.points[i][0] - trace.points[i - 1][0], 2);
  assert.deepStrictEqual(rec.take(), [], 'taken once');
});

test('lap trace: a flashback mid-lap keeps the re-run, not the abandoned part', () => {
  const rec = createLapTraceRecorder();
  for (const [lap, tel] of drive(2, { to: 700 })) rec.update(lap, tel);
  for (const [lap, tel] of drive(2, { from: 400, msPerM: 25 })) rec.update(lap, tel); // back to 400 m, slower
  rec.update({ currentLapNum: 3, lapDistance: 1, currentLapTimeInMS: 10, lastLapTimeInMS: 22000, pitStatus: 0 }, { speed: 180, throttle: 1, brake: 0, steer: 0, gear: 6 });
  const [trace] = rec.take();
  const distances = trace.points.map((p) => p[0]);
  assert.deepStrictEqual(distances, [...distances].sort((a, b) => a - b), 'distance only goes forwards');
  assert.strictEqual(trace.points.find((p) => p[0] === 600)[1], 600 * 25, 'the re-run time at 600 m');
});

test('lap trace: a flashback back across the line drops the lap now in the future', () => {
  const rec = createLapTraceRecorder();
  for (const [lap, tel] of drive(2)) rec.update(lap, tel);
  for (const [lap, tel] of drive(3, { to: 50 })) rec.update(lap, tel);
  for (const [lap, tel] of drive(2, { from: 900 })) rec.update(lap, tel); // back into lap 2
  assert.deepStrictEqual(rec.take(), []);
});

test('lap trace: pit lane is not recorded; a lap that went off track is marked invalid', () => {
  const rec = createLapTraceRecorder();
  for (const [lap, tel] of drive(2, { pit: (d) => (d > 800 ? 1 : 0), invalidAt: 300 })) rec.update(lap, tel);
  for (const [lap, tel] of drive(3, { to: 10 })) rec.update(lap, tel);
  const [trace] = rec.take();
  assert.ok(trace.points.every((p) => p[0] <= 800));
  assert.strictEqual(trace.invalid, true);
});

test('lap trace: at most 3 laps wait to be collected', () => {
  const rec = createLapTraceRecorder();
  for (let n = 2; n <= 7; n++) for (const [lap, tel] of drive(n)) rec.update(lap, tel);
  assert.deepStrictEqual(rec.take().map((t) => t.lapNum), [4, 5, 6]);
});

// A lap (or its first `toM` metres) of a `lengthM` track, as Lap Data every 17 m.
function miniLap(tracker, car, lapNum, lengthM, msAt, toM = lengthM) {
  for (let d = 0; d < toM; d += 17) tracker.update(0, car, { currentLapNum: lapNum, lapDistance: d, currentLapTimeInMS: msAt(d), lastLapTimeInMS: 0 }, lengthM);
}

test('mini-sectors: 25 slices that add up to the lap time; lap 1 skipped', () => {
  const L = 5000;
  const msAt = (d) => Math.round(d * 18 + 300 * Math.sin(d / 500));
  const tracker = createMiniSectorTracker();
  const car = {};
  miniLap(tracker, car, 1, L, msAt);
  miniLap(tracker, car, 2, L, msAt);
  tracker.update(0, car, { currentLapNum: 3, lapDistance: 2, currentLapTimeInMS: 40, lastLapTimeInMS: msAt(L) }, L);
  assert.strictEqual(car.miniSectors.length, 1, 'lap 1 (standing start) is not timed');
  const { lapNum, splits } = car.miniSectors[0];
  assert.strictEqual(lapNum, 2);
  assert.strictEqual(splits.length, MINI_SECTORS);
  assert.strictEqual(splits.reduce((a, b) => a + b, 0), msAt(L));
  // Each boundary is interpolated, so a slice is within a sample's time of the truth.
  splits.slice(0, -1).forEach((s, k) => assert.ok(Math.abs(s - (msAt((k + 1) * 200) - msAt(k * 200))) <= 17 * 18 + 1, `slice ${k}: ${s}`));
});

test('mini-sectors: the lap in progress shows only slices already run; a flashback clears the ones after it', () => {
  const L = 5000;
  const tracker = createMiniSectorTracker();
  const car = {};
  miniLap(tracker, car, 2, L, (d) => d * 18);
  miniLap(tracker, car, 3, L, (d) => d * 18, 1100); // 1100 m into lap 3: 5 slices of 200 m
  const before = tracker.partial(0).splits.filter((s) => s != null).length;
  assert.strictEqual(before, 5);
  tracker.update(0, car, { currentLapNum: 3, lapDistance: 450, currentLapTimeInMS: 450 * 18 }, L); // flashback to 450 m
  assert.strictEqual(tracker.partial(0).splits.filter((s) => s != null).length, 2);
});
