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

// --- U2: the gap chart's trend, with the range it could really be ---
// Fake tools: your laps and theirs, with the gap to the leader of each at every line.
const lapRow = (lap, gap, extra = {}) => ({ lap, ms: 90000, time: '1:30.000', position: 5, tyre: 'medium', tyre_age: lap, pit: false, safety_car: false, valid: true, has_telemetry: false, gap_to_leader_s: gap, ...extra });
function gapTools(gaps, { pit = [], sc = [] } = {}) {
  const mine = gaps.map(([lap, g]) => lapRow(lap, 20 + g, { pit: pit.includes(lap), safety_car: sc.includes(lap) }));
  const theirs = gaps.map(([lap]) => lapRow(lap, 20));
  return { run: (name, a) => (name === 'lap_times' ? { laps: a.driver ? theirs : mine } : { error: 'unused' }) };
}
// 0.3 s a lap, with a little scatter that doesn't repeat.
const wobble = [0.05, -0.08, 0.06, -0.03, 0.09, -0.07, 0.02, -0.05, 0.08, -0.04, 0.03, -0.06];

test('gap chart: a gap that grows lap after lap has its trend drawn with the range it could be', () => {
  const gaps = wobble.slice(0, 10).map((w, i) => [5 + i, 2 + 0.3 * i + w]);
  const c = buildChart(gapTools(gaps), 1, 'gap_to_driver', { driver: 'LECLERC' });
  const b = c.bands[0];
  assert.deepStrictEqual([b.from, b.to], [5, 14]);
  assert.strictEqual(b.band.length, 10);
  assert.ok(b.slope > 0.25 && b.slope < 0.35, `slope ${b.slope}`);
  assert.ok(b.slopeLo < b.slope && b.slope < b.slopeHi);
  for (const [, lo, hi] of b.band) assert.ok(lo < hi);
  assert.match(c.finding, /lost 0\.\d{2} s a lap to LECLERC over laps 5-14 \(80% sure it was between 0\.\d{2} and 0\.\d{2} s\)/);
});

test('gap chart: a stop splits the trend - the longest run of laps with neither car stopping is the one fitted', () => {
  // Laps 2-6 grow, lap 7 is your stop (the gap jumps), laps 8-19 shrink: the fitted run is 8-19.
  const gaps = [...[2, 3, 4, 5, 6].map((l, i) => [l, 1 + 0.3 * i]), [7, 24], ...wobble.map((w, i) => [8 + i, 20 - 0.4 * i + w])];
  const c = buildChart(gapTools(gaps, { pit: [7] }), 1, 'gap_to_driver', { driver: 'LECLERC' });
  assert.deepStrictEqual([c.bands[0].from, c.bands[0].to], [8, 19]);
  assert.ok(c.bands[0].slope < 0);
  assert.match(c.finding, /gained 0\.\d{2} s a lap on LECLERC over laps 8-19/);
});

test('gap chart: safety-car laps are not racing laps either', () => {
  const gaps = [...[2, 3, 4].map((l, i) => [l, 1 + 0.3 * i]), [5, 3], ...wobble.slice(0, 7).map((w, i) => [6 + i, 5 + 0.2 * i + w])];
  const c = buildChart(gapTools(gaps, { sc: [5] }), 1, 'gap_to_driver', { driver: 'LECLERC' });
  assert.strictEqual(c.bands[0].from, 6);
});

test('gap chart: too few clean laps in a row is no trend, and the chart is as it was', () => {
  const gaps = [[2, 1], [3, 1.3], [4, 1.6], [5, 24], [6, 24.2], [7, 24.5]];
  const c = buildChart(gapTools(gaps, { pit: [5] }), 1, 'gap_to_driver', { driver: 'LECLERC' });
  assert.strictEqual(c.bands, undefined);
  assert.doesNotMatch(c.finding, /80% sure/);
});

test('gap chart: a trend that could be nothing says there is no clear trend, not a direction', () => {
  const flat = [0.2, -0.25, 0.15, -0.3, 0.1, -0.2, 0.25, -0.15, 0.05, -0.1];
  const c = buildChart(gapTools(flat.map((g, i) => [5 + i, 3 + g])), 1, 'gap_to_driver', { driver: 'LECLERC' });
  assert.ok(c.bands[0].slopeLo < 0 && 0 < c.bands[0].slopeHi);
  assert.match(c.finding, /no clear trend/);
  assert.doesNotMatch(c.finding, /lost|gained/);
});
