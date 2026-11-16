const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCaptureSession } = require('../src/capture/session');
const { listCaptures, dropPackets, oldRecordings, packetsFile } = require('../desktop/library');
const { syntheticPackets } = require('./helpers/synthetic');

// Roadmap Q7: recordings are the biggest thing on disk (2 GB against 29 MB of everything else). A recording's raw
// packets can go while its report, marks and meta stay, and the race itself stays in the race store.
const DAY = 86400000;

async function record(root, name, startedAt) {
  const dir = path.join(root, name);
  const c = createCaptureSession({ dir });
  for (const p of syntheticPackets().slice(0, 400)) c.recordPacket(p.buf);
  c.addMarker({ id: 'm1', tag: 'mark' }, { lap: 1 });
  await c.close();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ startedAt: new Date(startedAt).toISOString() }));
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ checks: [], laps: [{}], markers: [], capture: { durationS: 60 } }));
  return dir;
}
const tmpRoot = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'undercut-keep-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

test('retention: dropping a recording\'s packets frees them and keeps its report, marks and meta', async (t) => {
  const root = tmpRoot(t);
  const dir = await record(root, '2026-10-01_100000', Date.UTC(2026, 9, 1));
  const before = (await listCaptures(root))[0].bytes;
  const freed = await dropPackets(root, '2026-10-01_100000');
  assert.ok(freed > 0 && freed <= before);
  assert.strictEqual(packetsFile(dir), null);
  for (const f of ['report.json', 'meta.json', 'markers.jsonl']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  const [c] = await listCaptures(root);
  assert.strictEqual(c.name, '2026-10-01_100000', 'still listed');
  assert.strictEqual(c.packets, false);
  assert.strictEqual(c.bytes, before - freed, 'the size shown is what is left');
  assert.ok(c.report, 'its report still opens');
  assert.strictEqual(c.marks, 1);
});

test('retention: a recording with its packets says so, and dropping twice or a missing one is an error', async (t) => {
  const root = tmpRoot(t);
  await record(root, 'a', Date.UTC(2026, 9, 1));
  assert.strictEqual((await listCaptures(root))[0].packets, true);
  await dropPackets(root, 'a');
  await assert.rejects(dropPackets(root, 'a'), /no packets/i);
  await assert.rejects(dropPackets(root, 'nope'), /no such|no packets/i);
  await assert.rejects(dropPackets(root, '../x'), /No such recording/);
});

test('retention: a folder with no packets and no report is still not a recording', async (t) => {
  const root = tmpRoot(t);
  fs.mkdirSync(path.join(root, 'menu-test'));
  fs.writeFileSync(path.join(root, 'menu-test', 'meta.json'), '{}');
  assert.deepStrictEqual(await listCaptures(root), []);
});

test('retention: only recordings older than N days, that still have packets, are offered', async (t) => {
  const root = tmpRoot(t);
  const now = Date.UTC(2026, 10, 15);
  await record(root, 'old', now - 45 * DAY);
  await record(root, 'recent', now - 5 * DAY);
  await record(root, 'older-dropped', now - 90 * DAY);
  await dropPackets(root, 'older-dropped');
  const found = await oldRecordings(root, 30, now);
  assert.deepStrictEqual(found.map((x) => x.name), ['old']);
  assert.ok(found[0].bytes > 0);
  assert.deepStrictEqual(await oldRecordings(root, 3, now).then((l) => l.map((x) => x.name).sort()), ['old', 'recent']);
});
