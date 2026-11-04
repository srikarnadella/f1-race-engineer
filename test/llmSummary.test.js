const test = require('node:test');
const assert = require('node:assert');
const { raceSummary } = require('../src/llm/insights');

// "Summarize the race": the engine picks the points and writes each one from numbers it already worked
// out, so the model words a summary it can't get wrong.
const lap = (n, ms, extra = {}) => ({ lap: n, ms, time: '', position: 5, tyre: 'medium', pit: false, safety_car: false, valid: true, ...extra });
const PARTS = {
  session: { type: 'Race', track: 'Barcelona', grid: 15, finish: 7 },
  laps: [lap(1, 90000), lap(2, 78114), lap(3, 76692), lap(4, 77000), lap(5, 100000, { pit: true })],
  stops: { stops: [{ lap_in: 9, cost_s: 21.4, green: true, vs_field_s: 0.4 }], field: { median_s: 21, stops: 3 } },
  losses: { worst: [{ lap: 5, text: 'Lap 5 was 2.35 s slower than your typical lap. On that lap: a collision with ANTONELLI.' }], consistency: {} },
  pace: { you: { rank: 2, of: 4, off_quickest_s: 0.4 } },
  calls: { summary: { calls: 3, graded: 2, right: 1, wrong: 1, unclear: 0 } },
  coaching: { advice: [{ text: 'Brake 8 m later into corner 4.' }] },
};

test('race summary: the result, the best lap, the stops, the pace, the costliest lap, the calls and one thing to work on', () => {
  const r = raceSummary(PARTS);
  assert.strictEqual(r.points.length, 7);
  assert.match(r.points[0], /started P15 and finished P7, 8 places gained/);
  assert.match(r.points[1], /Best lap: lap 3, 1:16\.692/);
  assert.match(r.points[2], /Stop on lap 9: cost 21\.4 s, 0\.4 s slower than the 3 green-flag stops/);
  assert.match(r.points[3], /2nd of 4 on race pace, 0\.40 s off the quickest/);
  assert.match(r.points[4], /Costliest lap: Lap 5 was 2\.35 s slower/);
  assert.match(r.points[5], /1 of the 2 calls.*graded were right/);
  assert.match(r.points[6], /Work on: Brake 8 m later into corner 4/);
  assert.ok(r.text.startsWith('The race in points:'));
  for (const p of r.points) assert.ok(r.text.includes(p));
});

test('race summary: what is not there is left out, never filled in', () => {
  const r = raceSummary({ session: { type: 'Race', track: 'Spa', grid: 3, finish: 3 }, laps: PARTS.laps, stops: { stops: [], field: { median_s: null, stops: 0 } }, losses: null, pace: null, calls: null, coaching: null });
  assert.strictEqual(r.points.length, 3); // the result, the best lap and no stop
  assert.match(r.points[0], /started P3 and finished P3/);
  assert.doesNotMatch(r.points[0], /places/);
  assert.match(r.points[2], /no pit stop/i);
});

test('race summary: a steady race says no lap cost much, a qualifying session has no stops or calls to speak of', () => {
  const steady = raceSummary({ ...PARTS, losses: { worst: [], consistency: {} } });
  assert.match(steady.points.find((p) => /cost you more than/.test(p)), /No lap cost you more than 0\.7 s/);
  const quali = raceSummary({ ...PARTS, session: { type: 'Short qualifying', track: 'Spa', grid: null, finish: 19 }, stops: { stops: [], field: { median_s: null, stops: 0 } }, calls: { summary: { calls: 0, graded: 0, right: 0, wrong: 0, unclear: 0 } } });
  assert.match(quali.points[0], /finished P19/);
  assert.ok(!quali.points.some((p) => /calls/.test(p)));
});
