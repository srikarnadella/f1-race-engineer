const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../src/data/store');
const { createRaceTools } = require('../src/llm/tools');
const { buildChart, chartFor, CHART_KINDS } = require('../src/llm/charts');
const { syntheticPackets, replay } = require('./helpers/synthetic');

// Ask the race, charts: built by the engine from race.db, never drawn from numbers a model wrote.
// Each chart says what it shows in one line, worked out from the same data.
let fixture = null;
function setup(t) {
  if (!fixture) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-charts-'));
    const file = path.join(dir, 'race.db');
    const store = openStore(file);
    replay(syntheticPackets(), { pipelineOptions: { store } }).flush();
    store.close();
    fixture = { dir, file };
  }
  const tools = createRaceTools(fixture.file);
  t.after(() => tools.close());
  const sid = tools.run('sessions', {}).sessions[0].session_id;
  const laps = tools.run('lap_times', { session_id: sid }).laps;
  const rival = tools.run('results', { session_id: sid }).results.find((r) => !r.you).driver;
  return { tools, sid, laps, rival };
}
test.after(() => fixture && fs.rmSync(fixture.dir, { recursive: true, force: true }));

test('charts: your lap times, one point per lap in seconds, the pit and safety-car laps marked, and what it shows', (t) => {
  const { tools, sid, laps } = setup(t);
  const c = buildChart(tools, sid, 'lap_times', {});
  assert.strictEqual(c.kind, 'lap_times');
  assert.deepStrictEqual(c.series[0].points, laps.map((l) => [l.lap, l.ms / 1000]));
  assert.strictEqual(c.series[0].you, true);
  assert.match(c.finding, /Best lap \d+/);
  assert.ok(c.title && c.x.label && c.y.label);
});

test('charts: positions lap by lap, P1 at the top, against another driver when asked', (t) => {
  const { tools, sid, laps, rival } = setup(t);
  const c = buildChart(tools, sid, 'positions', { driver: rival });
  assert.strictEqual(c.y.invert, true);
  assert.deepStrictEqual(c.series[0].points, laps.map((l) => [l.lap, l.position]));
  assert.strictEqual(c.series[1].name, rival);
  assert.match(c.finding, /P\d+ to P\d+/);
});

test('charts: the gap to a driver lap by lap, from both cars\' gaps to the leader', (t) => {
  const { tools, sid, laps, rival } = setup(t);
  const theirs = tools.run('lap_times', { session_id: sid, driver: rival }).laps;
  const c = buildChart(tools, sid, 'gap_to_driver', { driver: rival });
  const lap = c.series[0].points[0][0];
  const mine = laps.find((l) => l.lap === lap);
  const them = theirs.find((l) => l.lap === lap);
  assert.ok(Math.abs(c.series[0].points[0][1] - (mine.gap_to_leader_s - them.gap_to_leader_s)) < 0.001);
  assert.match(c.finding, new RegExp(rival));
});

test('charts: two laps\' speed over the lap, the corners that cost time marked', (t) => {
  const { tools, sid, laps } = setup(t);
  const traced = laps.filter((l) => l.has_telemetry);
  const c = buildChart(tools, sid, 'lap_compare', { lap_a: traced[0].lap, lap_b: traced[1].lap });
  assert.strictEqual(c.series.length, 2);
  assert.strictEqual(c.series[0].points.length, c.series[1].points.length);
  assert.ok(c.series[0].points.length <= 500, 'thinned for drawing');
  assert.match(c.finding, /slower|faster/);
  assert.deepStrictEqual(buildChart(tools, sid, 'lap_compare', { lap_a: 999, lap_b: traced[0].lap }), { error: 'No telemetry for one of those laps' });
});

test('charts: the engine picks the chart a question is about; unknown kinds are refused', (t) => {
  const { tools, sid, laps, rival } = setup(t);
  const traced = laps.filter((l) => l.has_telemetry);
  assert.strictEqual(chartFor(`Where did I lose time on lap ${traced[1].lap} compared with lap ${traced[0].lap}?`, { rival: null }).kind, 'lap_compare');
  assert.strictEqual(chartFor('Show me my lap times', {}).kind, 'lap_times');
  assert.strictEqual(chartFor('How did my position change through the race?', {}).kind, 'positions');
  assert.deepStrictEqual(chartFor(`How did my gap to ${rival} change?`, { rival }), { kind: 'gap_to_driver', args: { driver: rival } });
  assert.strictEqual(chartFor('Who won the race?', {}), null, 'no chart for a fact');
  assert.deepStrictEqual(buildChart(tools, sid, 'pie', {}), { error: `No chart called pie; there are ${CHART_KINDS.join(', ')}` });
});
