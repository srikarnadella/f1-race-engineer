const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../src/data/store');
const { createRaceTools } = require('../src/llm/tools');
const { syntheticPackets, replay } = require('./helpers/synthetic');

// Ask the race (roadmap L1): the local model never touches the data itself. It picks one of these
// tools; the engine runs fixed, read-only queries over race.db and returns the facts.
let fixture = null;
function raceDb() {
  if (fixture) return fixture;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tools-'));
  const file = path.join(dir, 'race.db');
  const store = openStore(file);
  replay(syntheticPackets(), { pipelineOptions: { store } }).flush();
  store.close();
  fixture = { dir, file };
  return fixture;
}
test.after(() => fixture && fs.rmSync(fixture.dir, { recursive: true, force: true }));

function open(t) {
  const tools = createRaceTools(raceDb().file);
  t.after(() => tools.close());
  return tools;
}

test('llm tools: each one is a named function with a JSON schema, and none takes SQL', (t) => {
  const tools = open(t);
  const names = tools.schemas.map((s) => s.function.name);
  assert.deepStrictEqual(names.sort(), ['calls', 'compare_laps', 'events', 'gaps', 'lap_times', 'sessions', 'stints']);
  for (const s of tools.schemas) {
    assert.strictEqual(s.type, 'function');
    assert.ok(s.function.description.length > 20, s.function.name);
    assert.strictEqual(s.function.parameters.type, 'object');
    assert.strictEqual(s.function.parameters.additionalProperties, false);
    for (const [k, p] of Object.entries(s.function.parameters.properties)) {
      assert.ok(['integer', 'string'].includes(p.type), `${s.function.name}.${k}`);
      assert.doesNotMatch(k, /sql|query/i);
    }
  }
});

test('llm tools: sessions lists the race, and lap_times returns its known laps', (t) => {
  const tools = open(t);
  const [s] = tools.run('sessions', {}).sessions;
  assert.ok(s.session_id && s.track && s.is_race, JSON.stringify(s));
  const db = new (require('node:sqlite').DatabaseSync)(raceDb().file, { readOnly: true });
  t.after(() => db.close());
  const expected = db.prepare('SELECT lap_num, lap_ms FROM lap JOIN car USING (session_id, car_idx) WHERE is_player = 1 ORDER BY lap_num').all();
  const got = tools.run('lap_times', { session_id: s.session_id }).laps;
  assert.ok(expected.length >= 3);
  assert.deepStrictEqual(got.map((l) => [l.lap, l.ms]), expected.map((l) => [l.lap_num, l.lap_ms]));
  assert.match(got[0].time, /^\d+:\d{2}\.\d{3}$/);
  // Another car by name.
  const other = db.prepare('SELECT driver FROM car WHERE is_player = 0 LIMIT 1').get().driver;
  assert.ok(tools.run('lap_times', { session_id: s.session_id, driver: other }).laps.length > 0);
});

test('llm tools: stints, gaps at a lap, calls and events answer from the same session', (t) => {
  const tools = open(t);
  const sid = tools.run('sessions', {}).sessions[0].session_id;
  assert.ok(tools.run('stints', { session_id: sid }).stints.length >= 1);
  const lap = tools.run('lap_times', { session_id: sid }).laps[1].lap;
  const g = tools.run('gaps', { session_id: sid, lap });
  assert.ok(g.cars.length > 1);
  assert.deepStrictEqual(g.cars.map((c) => c.position), [...g.cars.map((c) => c.position)].sort((a, b) => a - b));
  assert.ok(Array.isArray(tools.run('calls', { session_id: sid }).calls));
  assert.ok(Array.isArray(tools.run('events', { session_id: sid, lap_from: 1, lap_to: 99 }).events));
});

test('llm tools: compare_laps explains where one lap lost time to another', (t) => {
  const tools = open(t);
  const sid = tools.run('sessions', {}).sessions[0].session_id;
  const traced = tools.run('lap_times', { session_id: sid }).laps.filter((l) => l.has_telemetry);
  assert.ok(traced.length >= 2, 'the synthetic race keeps two traced laps');
  const [a, b] = traced;
  const c = tools.run('compare_laps', { session_id: sid, lap_a: a.lap, lap_b: b.lap });
  assert.strictEqual(c.lap_a.lap, a.lap);
  assert.strictEqual(c.lap_b.lap, b.lap);
  assert.ok(Math.abs(c.total_s - (b.ms - a.ms) / 1000) < 0.2, `${c.total_s} vs ${(b.ms - a.ms) / 1000}`);
  assert.ok(Array.isArray(c.corners) && c.corners.length <= 5);
  assert.deepStrictEqual(tools.run('compare_laps', { session_id: sid, lap_a: 999, lap_b: a.lap }), { error: 'No telemetry for lap 999' });
});

test('llm tools: the connection is read-only, and bad arguments are refused before any query', (t) => {
  const tools = open(t);
  assert.throws(() => tools.db.exec('DELETE FROM lap'), /readonly|read-only/i);
  assert.deepStrictEqual(tools.run('lap_times', { session_id: 1, sql: 'DROP TABLE lap' }), { error: 'lap_times takes no argument "sql"' });
  assert.deepStrictEqual(tools.run('lap_times', { session_id: '1; DROP TABLE lap' }), { error: 'lap_times: session_id must be an integer' });
  assert.deepStrictEqual(tools.run('lap_times', {}), { error: 'lap_times needs session_id' });
  assert.deepStrictEqual(tools.run('shell', {}), { error: 'No tool called shell' });
});
