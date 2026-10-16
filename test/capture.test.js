const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openLogWriter, readLog } = require('../src/capture/logFile');
const { createCaptureSession } = require('../src/capture/session');
const { analyzeCapture, toMarkdown } = require('../src/capture/analyze');
const { generate } = require('../src/sim/syntheticSession');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'f1re-'));
const collect = async (file, stats) => {
  const out = [];
  for await (const rec of readLog(file, stats)) out.push(rec);
  return out;
};

test('gzip log: round trip, and a capture killed mid-write still reads up to the cut', async () => {
  const dir = tmp();
  const file = path.join(dir, 'p.f1log.gz');
  const w = openLogWriter(file);
  for (let i = 0; i < 500; i++) w.write(JSON.stringify({ tMs: i, hex: Buffer.from([i & 0xff, 1, 2]).toString('hex') }));
  await w.close();
  const all = await collect(file);
  assert.strictEqual(all.length, 500);
  assert.deepStrictEqual([...all[499].buf], [499 & 0xff, 1, 2]);

  // Chop the end off, as a hard kill would (no gzip trailer).
  const bytes = fs.readFileSync(file);
  fs.writeFileSync(file, bytes.subarray(0, bytes.length - 12));
  const stats = { badLines: 0, truncated: false };
  const partial = await collect(file, stats);
  assert.ok(partial.length > 400, `only ${partial.length} recovered`);
  assert.strictEqual(stats.truncated, true);
});

test('capture session: markers are validated, and a tag re-sent with the same id is kept', async () => {
  const dir = tmp();
  const cap = createCaptureSession({ dir });
  assert.strictEqual(cap.addMarker({ id: 'a', tag: 'mark' }, { lap: 3 }), true);
  assert.strictEqual(cap.addMarker({ id: 'a', tag: 'lockup' }, { lap: 3 }), true);
  assert.strictEqual(cap.addMarker({ id: 'b', tag: '<script>' }, {}), true); // unknown tag -> plain mark
  assert.strictEqual(cap.addMarker({ id: 'x'.repeat(100), tag: 'mark' }, {}), false);
  assert.strictEqual(cap.addMarker({ tag: 'mark' }, {}), false);
  await cap.close();
  const lines = fs.readFileSync(path.join(dir, 'markers.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(lines.map((l) => `${l.id}:${l.tag}`), ['a:mark', 'a:lockup', 'b:mark']);
  for (const f of ['packets.f1log.gz', 'outputs.jsonl', 'meta.json']) assert.ok(fs.existsSync(path.join(dir, f)), f);
});

test('analyzer: checks the format, reads fuel and forecast meaning, and puts marks in context', async () => {
  const dir = tmp();
  // 40s of the synthetic race as a capture folder, with one driver mark.
  const w = openLogWriter(path.join(dir, 'packets.f1log.gz'));
  generate((tMs, buf) => {
    if (tMs <= 40000) w.write(JSON.stringify({ tMs, hex: buf.toString('hex') }));
  });
  await w.close();
  fs.writeFileSync(path.join(dir, 'markers.jsonl'), [
    JSON.stringify({ tMs: 20000, id: 'm', tag: 'mark' }),
    JSON.stringify({ tMs: 20300, id: 'm', tag: 'wrong-call', note: 'test' }),
  ].join('\n'));

  const r = await analyzeCapture(dir);
  const byName = Object.fromEntries(r.checks.map((c) => [c.name, c]));
  assert.strictEqual(byName['Packet format'].status, 'OK');
  assert.strictEqual(byName['MotionEx packet'].status, 'OK');
  assert.strictEqual(byName['Parser / engine warnings'].status, 'OK');
  assert.match(byName['Forecast timeOffset meaning'].detail, /"minutes from now" matches current weather 100%/);
  assert.strictEqual(r.markers.length, 1);
  assert.strictEqual(r.markers[0].tag, 'wrong-call');
  assert.strictEqual(r.markers[0].tMs, 20000);
  assert.ok(r.markers[0].replay.call, 'mark carries the call shown at that moment');
  assert.ok(r.markers[0].inputs.length > 0, 'mark carries the inputs before it');
  assert.ok(r.calibration.brakingFrontSlip.n > 0);
  assert.match(toMarkdown(r), /### 0:20 · wrong-call - test/);
});
