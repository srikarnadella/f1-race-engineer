const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { openStore } = require('../src/data/store');
const { syntheticPackets, replay } = require('./helpers/synthetic');
const { start } = require('../src/index');

// Roadmap K2: each saved race has a "learn from this" switch. Switching it off makes the app forget what the
// race taught the tracks, and the choice sticks even if the race is processed again.
function raceInto(store) {
  const pipeline = replay(syntheticPackets(), { pipelineOptions: { store } });
  pipeline.flush();
  return String(pipeline.fieldModel.getSessionUID());
}
const learnCol = (db, uid) => db.prepare('SELECT learn FROM session WHERE session_uid = ?').get(uid).learn;

test('learn: a stored race learns by default, and the switch is read back', () => {
  const store = openStore(':memory:');
  const uid = raceInto(store);
  assert.strictEqual(store.learns(uid), true);
  assert.strictEqual(store.setLearn(uid, false), true);
  assert.strictEqual(store.learns(uid), false);
  assert.strictEqual(store.setLearn(uid, true), true);
  assert.strictEqual(store.learns(uid), true);
  assert.strictEqual(store.setLearn('nope', false), false, 'no such race');
  assert.strictEqual(store.learns('nope'), null);
  store.close();
});

test('learn: processing the same race again keeps the switch where the user left it', () => {
  const store = openStore(':memory:');
  const uid = raceInto(store);
  store.setLearn(uid, false);
  raceInto(store); // same game session id: replaces the race's rows
  assert.strictEqual(learnCol(store.db, uid), 0);
  store.close();
});

test('learn: a file from before the switch gains it, on for every race already in it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-'));
  try {
    const file = path.join(dir, 'race.db');
    const s = openStore(file);
    const uid = raceInto(s);
    s.db.exec('ALTER TABLE session DROP COLUMN learn');
    s.db.exec('PRAGMA user_version = 2');
    s.close();
    const up = openStore(file);
    assert.strictEqual(learnCol(up.db, uid), 1);
    up.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bridge: switching a saved race off forgets what it taught; the other races keep theirs', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercut-learn-'));
  fs.mkdirSync(path.join(dataDir, 'sessions'));
  const seed = openStore(path.join(dataDir, 'race.db'));
  const uid = raceInto(seed);
  seed.close();
  const debrief = (id, u) => zlib.gzipSync(JSON.stringify({ id, uid: u, startedAt: 1, field: [], traces: [], rivalBest: [], laps: [] }));
  fs.writeFileSync(path.join(dataDir, 'sessions', 'a.json.gz'), debrief('sa', uid));
  fs.writeFileSync(path.join(dataDir, 'sessions', 'b.json.gz'), debrief('sb', '222'));
  fs.writeFileSync(path.join(dataDir, 'tracks.json'), JSON.stringify({ 5: { pitLossMs: [{ v: 21000, s: uid }, { v: 22000, s: '222' }] } }));
  const log = console.log;
  console.log = () => {};
  const bridge = start({ httpPort: 0, udpPort: 0, udpHost: '127.0.0.1', dataDir });
  t.after(async () => {
    console.log = log;
    await bridge.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  assert.strictEqual(bridge.learns('sa'), true);
  assert.strictEqual(bridge.setLearn('sa', false), true);
  assert.strictEqual(bridge.learns('sa'), false);
  const left = JSON.parse(fs.readFileSync(path.join(dataDir, 'tracks.json'), 'utf8'));
  assert.deepStrictEqual(left[5].pitLossMs.map((x) => x.v), [22000]);
  assert.strictEqual(bridge.setLearn('sb', false), false, 'a session that is not in the race store has no switch');
  assert.strictEqual(bridge.setLearn('missing', false), false);
});
