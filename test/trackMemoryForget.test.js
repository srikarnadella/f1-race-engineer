const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createTrackMemory } = require('../src/state/trackMemory');
const { syntheticPackets, replay } = require('./helpers/synthetic');
const { start } = require('../src/index');

// Roadmap K1/K3: what a race taught the app is stored with the race it came from, so deleting the race
// takes its lessons with it. Nothing is left that only that race could have put there.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'undercut-mem-'));

test('track memory: a sample keeps the session it came from, and get still returns plain values', () => {
  const m = createTrackMemory();
  m.add(5, 'pitLossMs', 21000, 'A');
  m.add(5, 'pitLossMs', 22000);
  assert.deepStrictEqual(m.get(5, 'pitLossMs'), [21000, 22000]);
});

test('track memory: forgetting a session removes its samples at every track and kind, and only those', () => {
  const m = createTrackMemory();
  m.add(5, 'pitLossMs', 21000, 'A');
  m.add(5, 'stopShare', 0.6, 'A');
  m.add(9, 'degMs', 300, 'A');
  m.add(5, 'pitLossMs', 22000, 'B');
  m.add(5, 'pitLossMs', 23000); // from before sessions were kept: nobody to forget it by
  assert.strictEqual(m.forget('A'), 3);
  assert.deepStrictEqual(m.get(5, 'pitLossMs'), [22000, 23000]);
  assert.deepStrictEqual(m.get(5, 'stopShare'), []);
  assert.deepStrictEqual(m.get(9, 'degMs'), []);
  assert.strictEqual(m.forget('A'), 0, 'nothing left to forget');
});

test('track memory: forgetting is saved, a session id with no samples does not rewrite the file', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'tracks.json');
    const m = createTrackMemory(file);
    m.add(5, 'pitLossMs', 21000, 'A');
    m.add(5, 'pitLossMs', 22000, 'B');
    m.forget('A');
    assert.deepStrictEqual(createTrackMemory(file).get(5, 'pitLossMs'), [22000]);
    const before = fs.statSync(file).mtimeMs;
    m.forget('nobody');
    assert.strictEqual(fs.statSync(file).mtimeMs, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('track memory: a file written before samples carried a session (plain numbers) still loads', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'tracks.json');
    fs.writeFileSync(file, JSON.stringify({ 5: { pitLossMs: [20000, 21000] } }));
    const m = createTrackMemory(file);
    assert.deepStrictEqual(m.get(5, 'pitLossMs'), [20000, 21000]);
    m.add(5, 'pitLossMs', 22000, 'A');
    assert.deepStrictEqual(createTrackMemory(file).get(5, 'pitLossMs'), [20000, 21000, 22000]);
    assert.strictEqual(m.forget('A'), 1);
    assert.deepStrictEqual(m.get(5, 'pitLossMs'), [20000, 21000], 'the old ones stay');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('track memory: the latest 20 per kind are kept, whoever they came from', () => {
  const m = createTrackMemory();
  for (let k = 0; k < 25; k++) m.add(5, 'x', k, k % 2 ? 'A' : 'B');
  assert.deepStrictEqual(m.get(5, 'x'), Array.from({ length: 20 }, (_, k) => k + 5));
});

test('track memory: everything a whole race teaches is tagged with that race, so forgetting it leaves nothing', () => {
  const memory = createTrackMemory();
  const pipeline = replay(syntheticPackets(), { pipelineOptions: { memory } });
  pipeline.flush(); // the wear fits are saved when the session ends
  const taught = memory.all();
  assert.ok(Object.keys(taught).length > 0, 'the race taught something');
  const uid = String(pipeline.fieldModel.getSessionUID());
  assert.ok(memory.forget(uid) > 0);
  assert.deepStrictEqual(memory.all(), {}, 'nothing left');
});

test('bridge: deleting a saved session also forgets what it taught the track', async (t) => {
  const dataDir = tmp();
  fs.mkdirSync(path.join(dataDir, 'sessions'));
  const session = (id, uid) => zlib.gzipSync(JSON.stringify({ id, uid, startedAt: 1, field: [], traces: [], rivalBest: [], laps: [] }));
  fs.writeFileSync(path.join(dataDir, 'sessions', 'a.json.gz'), session('sa', '111'));
  fs.writeFileSync(path.join(dataDir, 'sessions', 'b.json.gz'), session('sb', '222'));
  // tracks.json as the app wrote it: one sample per session, tagged.
  fs.writeFileSync(path.join(dataDir, 'tracks.json'), JSON.stringify({ 5: { pitLossMs: [{ v: 21000, s: '111' }, { v: 22000, s: '222' }] } }));
  const log = console.log;
  console.log = () => {};
  t.after(() => { console.log = log; });
  const bridge = start({ httpPort: 0, udpPort: 0, udpHost: '127.0.0.1', dataDir });
  // The bridge holds race.db open: let it go before the folder is removed.
  t.after(async () => {
    await bridge.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  assert.strictEqual(bridge.deleteSession('sa'), true);
  const left = JSON.parse(fs.readFileSync(path.join(dataDir, 'tracks.json'), 'utf8'));
  assert.deepStrictEqual(left[5].pitLossMs.map((x) => x.v ?? x), [22000]);
});
