const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../src/data/store');
const { createRaceTools } = require('../src/llm/tools');
const { insight, INSIGHT_KINDS, RULES } = require('../src/llm/ask');
const { buildChart, CHART_KINDS } = require('../src/llm/charts');
const { syntheticPackets, replay } = require('./helpers/synthetic');

// The insight buttons: the engine's own findings, put on screen with no model at all, so what the user
// reads can't be misjudged by a small model. And the lap-by-lap "time lost" chart that goes with them.
let fixture = null;
function tools(t) {
  if (!fixture) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-buttons-'));
    const file = path.join(dir, 'race.db');
    const store = openStore(file);
    replay(syntheticPackets(), { pipelineOptions: { store } }).flush();
    store.close();
    fixture = { dir, file };
  }
  const tl = createRaceTools(fixture.file);
  t.after(() => tl.close());
  return tl;
}
test.after(() => fixture && fs.rmSync(fixture.dir, { recursive: true, force: true }));

test('insight buttons: the eight the engine works out, each with a title', () => {
  assert.deepStrictEqual(Object.keys(INSIGHT_KINDS), ['summary', 'pit_stops', 'tyres', 'lost_time', 'race_pace', 'calls', 'history', 'handling']);
  for (const k of Object.values(INSIGHT_KINDS)) assert.ok(k.title && k.tool);
});

test('insight: the engine\'s findings as lines, no model involved', (t) => {
  const tl = tools(t);
  const sid = tl.run('sessions', {}).sessions[0].session_id;
  const r = insight(tl, sid, 'summary');
  assert.strictEqual(r.title, 'Race summary');
  assert.match(r.lines[0], /^You (started|finished) P\d+/);
  assert.ok(r.lines.every((l) => !l.endsWith(':')), 'no bare headings');
  assert.deepStrictEqual(r.charts, []);
});

test('insight: tyres and lost time bring their chart; the others have none', (t) => {
  const tl = tools(t);
  const sid = tl.run('sessions', {}).sessions[0].session_id;
  for (const [kind, chart] of [['tyres', 'stint_pace'], ['lost_time', 'lap_delta']]) {
    const r = insight(tl, sid, kind);
    if (r.error) continue; // the synthetic race may be too short for the tool; the error is then said, not hidden
    assert.deepStrictEqual(r.charts.map((c) => c.kind), [chart]);
  }
  assert.deepStrictEqual(insight(tl, sid, 'pit_stops').charts, []);
});

test('insight: a tool that cannot answer says why instead of an empty card, and an unknown button is refused', (t) => {
  const tl = tools(t);
  const sid = tl.run('sessions', {}).sessions[0].session_id;
  const r = insight(tl, sid, 'lost_time');
  assert.ok(r.error || r.lines.length, 'either an answer or the reason');
  assert.throws(() => insight(tl, sid, 'make_something_up'), /Not an insight/);
});

// --- Time lost, lap by lap ---
const lap = (n, s, extra = {}) => ({ lap: n, ms: Math.round(s * 1000), time: '', position: 5, tyre: 'medium', tyre_age: n, pit: false, safety_car: false, valid: true, ...extra });
const LAPS = [lap(1, 90), ...[2, 3, 4, 5, 6, 7, 8].map((n) => lap(n, 80 + (n % 2) * 0.1)), lap(9, 82.4), lap(10, 100, { pit: true }), lap(11, 98, { pit: true }), lap(12, 80), lap(13, 80.1)];
const fake = { run: (name) => (name === 'lap_times' ? { laps: LAPS } : name === 'events' ? { events: [] } : name === 'lap_losses' ? { text: 'Consistency: typical 1:20.050.\nLaps that cost the most time:\n- Lap 9 was 2.35 s slower than your typical lap.', error: undefined } : { error: 'unused' }) };

test('lap delta: offered as a chart, one point a racing lap, the seconds slower than your typical lap', () => {
  assert.ok(CHART_KINDS.includes('lap_delta'));
  const c = buildChart(fake, 1, 'lap_delta', {});
  assert.strictEqual(c.kind, 'lap_delta');
  assert.strictEqual(c.y.zero, true);
  assert.deepStrictEqual(c.series[0].points.map((p) => p[0]), [2, 3, 4, 5, 6, 7, 8, 9, 12, 13], 'no start lap, no stop laps');
  const nine = c.series[0].points.find((p) => p[0] === 9)[1];
  assert.ok(nine > 2.2 && nine < 2.4, `lap 9 was ${nine} s off`);
  assert.deepStrictEqual(c.marks.map((m) => m.x), [10, 11]);
  assert.match(c.finding, /Lap 9 was 2\.\d\d s slower than your typical lap/);
});

test('lap delta: too few clean laps is an error, not an empty chart', () => {
  const few = { run: (name) => (name === 'lap_times' ? { laps: [lap(1, 90), lap(2, 80)] } : {}) };
  assert.match(buildChart(few, 1, 'lap_delta', {}).error, /clean laps/);
});

// --- The model's own rules carry the uncertainty ---
test('the model is told this rests on one recording and may not hold in other races', () => {
  assert.match(RULES, /one recording/i);
});
