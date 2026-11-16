const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/data/store');
const { buildLibrary, identity } = require('../src/analysis/setupLibrary');
const { setupExtras } = require('../src/analysis/setupCompare');
const { syntheticPackets, replay } = require('./helpers/synthetic');

// The names, stars and notes live in their own table, apart from the sessions, so re-reading a recording or deleting a race
// can never take one away.
const V = (over = {}) => ({ frontWing: 40, rearWing: 15, diffOn: 100, diffOff: 60, frontSuspension: 41, rearSuspension: 30, frontAntiRollBar: 5, rearAntiRollBar: 1, frontHeight: 23, rearHeight: 45, brakePressure: 98, brakeBias: 57, tyreFront: 29.5, tyreRear: 20.5, ...over });
const KEY = identity(V());

test('notes: save a name, a star and a note, read them back, and change one field without losing the others', () => {
  const store = openStore(':memory:');
  store.saveSetupNote({ trackId: 10, key: KEY, values: V(), name: 'Wing-light quali' });
  store.saveSetupNote({ trackId: 10, key: KEY, favorite: true });
  store.saveSetupNote({ trackId: 10, key: KEY, note: 'loose at Eau Rouge' });
  const [n] = store.setupNotes();
  assert.deepStrictEqual([n.trackId, n.key, n.name, n.favorite, n.note], [10, KEY, 'Wing-light quali', true, 'loose at Eau Rouge']);
  assert.deepStrictEqual(n.values, V());
  assert.ok(n.updatedAt > 0);
  store.saveSetupNote({ trackId: 10, key: KEY, name: '' });
  assert.strictEqual(store.setupNotes()[0].name, '', 'a name can be cleared');
  assert.strictEqual(store.setupNotes()[0].favorite, true);
});

test('notes: bad input is refused and changes nothing', () => {
  const store = openStore(':memory:');
  store.saveSetupNote({ trackId: 10, key: KEY, values: V(), name: 'Keep' });
  const bad = [
    { trackId: 'x', key: KEY },
    { trackId: 10, key: 'not a key' },
    { trackId: 10, key: KEY, name: 'x'.repeat(61) },
    { trackId: 10, key: KEY, note: 'x'.repeat(501) },
    { trackId: 10, key: KEY, favorite: 'yes' },
    { trackId: 10, key: KEY, values: { frontWing: 'a lot' } },
    null,
  ];
  for (const b of bad) assert.throws(() => store.saveSetupNote(b), /./, JSON.stringify(b));
  assert.strictEqual(store.setupNotes()[0].name, 'Keep');
});

test('notes: a name is trimmed, and a note keeps its line breaks', () => {
  const store = openStore(':memory:');
  store.saveSetupNote({ trackId: 10, key: KEY, values: V(), name: '  Race setup  ', note: 'line one\nline two' });
  assert.strictEqual(store.setupNotes()[0].name, 'Race setup');
  assert.strictEqual(store.setupNotes()[0].note, 'line one\nline two');
});

test('notes: they are kept when the same session is written again (re-reading a recording) and when it is deleted', () => {
  const store = openStore(':memory:');
  const pipeline = replay(syntheticPackets(), { pipelineOptions: { store } });
  pipeline.flush();
  const [s] = store.setupLibrarySessions();
  const key = identity(s.runs[0].setup);
  store.saveSetupNote({ trackId: s.trackId, key, values: s.runs[0].setup, name: 'Mine', favorite: true });
  pipeline.flush(); // the same session written again
  assert.strictEqual(store.setupNotes().length, 1);
  const uid = store.db.prepare('SELECT session_uid FROM session').get().session_uid;
  store.deleteSession(uid);
  assert.strictEqual(store.setupLibrarySessions().length, 0);
  assert.strictEqual(store.setupNotes()[0].name, 'Mine');
  const lib = buildLibrary({ sessions: store.setupLibrarySessions(), notes: store.setupNotes() });
  assert.strictEqual(lib[0].setups[0].orphan, true, 'still there, with no sessions left');
});

test('library rows: each session with its player\'s runs, laps with fuel and compound, weather, grid and result', () => {
  const store = openStore(':memory:');
  replay(syntheticPackets(), { pipelineOptions: { store } }).flush();
  const [s] = store.setupLibrarySessions();
  assert.ok(s.uid && s.trackId != null && s.track && s.startedAt > 0);
  assert.strictEqual(typeof s.isRace, 'boolean');
  assert.ok(s.runs.length >= 1 && 'frontWing' in s.runs[0].setup);
  assert.ok(s.laps.length > 0 && 'fuelKg' in s.laps[0] && 'compound' in s.laps[0] && 'valid' in s.laps[0]);
  assert.ok(Array.isArray(s.weather));
  assert.ok('grid' in s && 'finish' in s);
});

test('recorded setups now carry camber, toe, engine braking and ballast', () => {
  const store = openStore(':memory:');
  replay(syntheticPackets(), { pipelineOptions: { store } }).flush();
  const run = JSON.parse(store.db.prepare('SELECT setup FROM setup_run').get().setup);
  for (const k of ['frontCamber', 'rearCamber', 'frontToe', 'rearToe', 'engineBraking', 'ballast']) assert.ok(k in run, k);
});

test('setupExtras: the extra values from the car, rounded, and null for what the game did not send', () => {
  const x = setupExtras({ frontCamber: -3.4999, rearCamber: -2, frontToe: 0.0500001, rearToe: 0.2, engineBraking: 50, ballast: 6 });
  assert.deepStrictEqual(x, { frontCamber: -3.5, rearCamber: -2, frontToe: 0.05, rearToe: 0.2, engineBraking: 50, ballast: 6 });
  assert.deepStrictEqual(setupExtras({ frontCamber: -3 }).rearToe, null);
});

test('the store waits for a busy file instead of failing, so a backfill and a live save can share it', () => {
  const store = openStore(':memory:');
  assert.ok(Number(store.db.prepare('PRAGMA busy_timeout').get().timeout) >= 3000);
});

test('pipeline: the garage screen\'s current setup carries its saved name and star once the notes cache is refreshed', () => {
  const store = openStore(':memory:');
  const pipeline = replay(syntheticPackets().slice(0, 4000), { pipelineOptions: { store } });
  const cur = pipeline.snapshot().setup.current;
  assert.ok(cur && /^[0-9a-f]{12}$/.test(cur.key), 'the car\'s setup has a key');
  assert.deepStrictEqual([cur.name, cur.favorite], ['', false]);
  store.saveSetupNote({ trackId: cur.trackId, key: cur.key, values: cur.values, name: 'Mine', favorite: true });
  assert.strictEqual(pipeline.tick().setup.current.favorite, false, 'read once, not on every tick');
  pipeline.invalidateNotes();
  const after = pipeline.tick().setup.current;
  assert.deepStrictEqual([after.name, after.favorite], ['Mine', true]);
});
