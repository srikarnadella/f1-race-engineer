const test = require('node:test');
const assert = require('node:assert');
const { buildChart, chartFor, CHART_KINDS } = require('../src/llm/charts');

// The stint-pace chart: your clean laps coloured by stint, each stint's trend drawn with the range it
// could be, and the finding saying what the pace did stint by stint (src/llm/insights.js stintReport).
const lap = (n, s, extra = {}) => ({ lap: n, ms: Math.round(s * 1000), time: '', position: 5, tyre: 'medium', tyre_age: n, pit: false, safety_car: false, valid: true, ...extra });
const LAPS = [
  lap(1, 90), ...[0, 1, 2, 3, 4, 5, 6].map((i) => lap(2 + i, 80 + 0.1 * i)), lap(9, 100, { pit: true }),
  lap(10, 98, { pit: true, tyre: 'hard' }), ...[11, 12, 13, 14, 15, 16].map((n) => lap(n, 79 + (n % 2 ? 0.05 : -0.05), { tyre: 'hard' })),
];
const STINTS = [{ stint: 1, tyre: 'medium', from_lap: 1, to_lap: 9 }, { stint: 2, tyre: 'hard', from_lap: 10, to_lap: 16 }];
const tools = { run: (name) => (name === 'lap_times' ? { laps: LAPS } : name === 'stints' ? { stints: STINTS } : { error: 'unused' }) };

test('stint pace: offered as a chart', () => {
  assert.ok(CHART_KINDS.includes('stint_pace'));
});

test('stint pace: one line per stint of clean laps only, a trend and its range for each long enough to fit', () => {
  const c = buildChart(tools, 1, 'stint_pace', {});
  assert.strictEqual(c.kind, 'stint_pace');
  assert.deepStrictEqual(c.series.map((s) => s.name), ['Medium, laps 2-8', 'Hard, laps 11-16']);
  assert.deepStrictEqual(c.series[0].points.map((p) => p[0]), [2, 3, 4, 5, 6, 7, 8], 'no start lap, no stop laps');
  assert.deepStrictEqual(c.series[1].points.map((p) => p[0]), [11, 12, 13, 14, 15, 16]);
  assert.deepStrictEqual(c.bands.map((b) => [b.from, b.to]), [[2, 8], [11, 16]]);
  assert.ok(Math.abs(c.bands[0].slope - 0.1) < 1e-9);
  assert.notStrictEqual(c.series[0].tone, c.series[1].tone, 'each stint its own colour');
});

test('stint pace: the finding says what the pace did in each stint', () => {
  const c = buildChart(tools, 1, 'stint_pace', {});
  assert.match(c.finding, /Medium \(laps 2-8\): slower by 0\.10 s a lap/);
  assert.match(c.finding, /Hard \(laps 11-16\): no clear change/);
});

test('stint pace: a session with no stints or no clean laps is an error, not an empty chart', () => {
  const none = { run: (name) => (name === 'lap_times' ? { laps: [lap(1, 90)] } : { stints: [{ stint: 1, tyre: 'soft', from_lap: 1, to_lap: 1 }] }) };
  assert.match(buildChart(none, 1, 'stint_pace', {}).error, /clean laps/);
});

test('stint pace: the chart a question about wear or stints is about', () => {
  assert.deepStrictEqual(chartFor('How did my tyres hold up?'), { kind: 'stint_pace', args: {} });
  assert.deepStrictEqual(chartFor('What was the tyre degradation in each stint?'), { kind: 'stint_pace', args: {} });
  assert.strictEqual(chartFor('When did I pit, and what tyres did I go onto?'), null, 'a stop question is not a wear chart');
  assert.deepStrictEqual(chartFor('Where did I lose time on lap 22?'), { kind: 'lap_compare', args: { lap_b: 22 } }, 'laps named still compare laps');
});
