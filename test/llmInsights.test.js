const test = require('node:test');
const assert = require('node:assert');
const { stintReport, stopReview, lapLosses, fieldPace, trackHistory, callsReview } = require('../src/llm/insights');

// Ask the race, more insights: what the engine works out from the recording and hands the model as
// sentences. Pure functions over the tool-shaped rows, each with the numbers it rests on and, where a
// number is an estimate, the range it could be (public/spread.js).
const lap = (n, s, extra = {}) => ({ lap: n, ms: Math.round(s * 1000), time: '', position: 5, tyre: 'medium', tyre_age: n, pit: false, safety_car: false, valid: true, ...extra });

// --- Tyres: a stint at a time ---
// Stint 1 (medium, laps 1-9): lap 1 the start, laps 2-8 getting 0.1 s slower a lap, lap 9 the in-lap.
// Stint 2 (hard, laps 10-16): the out-lap, then six laps level at 79.0.
const LAPS = [
  lap(1, 90), ...[0, 1, 2, 3, 4, 5, 6].map((i) => lap(2 + i, 80 + 0.1 * i)), lap(9, 100, { pit: true }),
  lap(10, 98, { pit: true, tyre: 'hard' }), ...[11, 12, 13, 14, 15, 16].map((n) => lap(n, 79, { tyre: 'hard' })),
];
const STINTS = [{ stint: 1, tyre: 'medium', from_lap: 1, to_lap: 9 }, { stint: 2, tyre: 'hard', from_lap: 10, to_lap: 16 }];

test('tyres: each stint with its clean laps, average and best, and what the pace did over it', () => {
  const r = stintReport(LAPS, STINTS);
  const [a, b] = r.stints;
  assert.deepStrictEqual([a.tyre, a.clean_laps, a.average, a.best_lap.lap, a.best_lap.time], ['medium', 7, '1:20.300', 2, '1:20.000']);
  assert.ok(Math.abs(a.pace_change.per_lap_s - 0.1) < 1e-9 && a.pace_change.clear);
  assert.match(a.text, /slower by 0\.10 s a lap/);
  assert.deepStrictEqual([b.tyre, b.clean_laps, b.average], ['hard', 6, '1:19.000']);
  assert.strictEqual(b.pace_change.clear, false);
  assert.match(b.text, /no clear change in pace/i);
  // The whole report reads as one answer: how many stints, then each.
  assert.match(r.text, /^You ran 2 stints\./);
  assert.ok(r.text.includes(a.text) && r.text.includes(b.text));
});

test('tyres: no stints is said, not left blank', () => {
  assert.match(stintReport([lap(1, 90)], []).text, /no tyre stints/i);
});

test('tyres: a stint with too few clean laps has an average but says it cannot tell how the pace changed', () => {
  const r = stintReport([lap(1, 90), lap(2, 80), lap(3, 80.4), lap(4, 80.2)], [{ stint: 1, tyre: 'soft', from_lap: 1, to_lap: 4 }]);
  assert.strictEqual(r.stints[0].pace_change, undefined);
  assert.match(r.stints[0].text, /too few clean laps to say how the pace changed/i);
});

test('tyres: a pace that is getting quicker (a car that is lighter) is said as quicker, with the range as sizes', () => {
  const quick = [lap(1, 90), ...[0, 1, 2, 3, 4, 5].map((i) => lap(2 + i, 80 - 0.08 * i + (i % 2 ? 0.01 : -0.01)))];
  const s = stintReport(quick, [{ stint: 1, tyre: 'soft', from_lap: 1, to_lap: 7 }]).stints[0];
  assert.ok(s.pace_change.per_lap_s < 0 && s.pace_change.clear);
  assert.match(s.text, /quicker by 0\.0\d s a lap over the stint \(80% sure it was between 0\.0\d and 0\.0\d s/);
});

// --- Pit stops: priced against the field's ---
test('pit stops: yours priced against the cars that stopped under the same flag, with the places it moved you', () => {
  const stops = [
    { carIndex: 5, isPlayer: true, lapNum: 9, green: true, costMs: 21400 },
    { carIndex: 2, isPlayer: false, lapNum: 8, green: true, costMs: 20000 },
    { carIndex: 3, isPlayer: false, lapNum: 11, green: true, costMs: 21000 },
    { carIndex: 4, isPlayer: false, lapNum: 12, green: true, costMs: 23000 },
    { carIndex: 6, isPlayer: false, lapNum: 9, green: false, costMs: 9000 }, // under a safety car: not the green-flag price
  ];
  const laps = [lap(7, 80, { position: 5 }), lap(8, 80, { position: 5 }), lap(9, 100, { position: 6, pit: true }), lap(10, 98, { position: 9, pit: true, tyre: 'hard' }), lap(11, 79, { position: 8, tyre: 'hard' })];
  const r = stopReview({ stops, laps, stints: STINTS });
  assert.strictEqual(r.stops.length, 1);
  const s = r.stops[0];
  assert.deepStrictEqual([s.lap_in, s.lap_out, s.cost_s, s.green, s.field_median_s, s.field_stops, s.vs_field_s], [9, 10, 21.4, true, 21, 3, 0.4]);
  assert.deepStrictEqual([s.tyre_from, s.tyre_to, s.position_before, s.position_after], ['medium', 'hard', 5, 9]);
  assert.match(s.text, /in on lap 9, out on lap 10, medium to hard/);
  assert.match(s.text, /cost 21\.4 s/);
  assert.match(s.text, /0\.4 s slower than the 3 green-flag stops/);
  assert.match(s.text, /P5 at the end of lap 8 and P9 at the end of lap 10, 4 places lost/);
});

test('pit stops: under a safety car the stop is said to be a cheaper one, not compared as if it were slow', () => {
  const stops = [{ carIndex: 5, isPlayer: true, lapNum: 9, green: false, costMs: 9500 }, { carIndex: 2, isPlayer: false, lapNum: 4, green: true, costMs: 21000 }];
  const s = stopReview({ stops, laps: [lap(8, 80), lap(9, 90, { pit: true }), lap(10, 90, { pit: true })], stints: STINTS }).stops[0];
  assert.strictEqual(s.green, false);
  assert.match(s.text, /under a safety car or VSC/);
  assert.doesNotMatch(s.text, /slower than the/);
});

test('pit stops: no stop, and no other stops to compare with, are both said plainly', () => {
  assert.match(stopReview({ stops: [], laps: [lap(2, 80)], stints: [] }).text, /made no pit stop/i);
  const alone = stopReview({ stops: [{ carIndex: 5, isPlayer: true, lapNum: 9, green: true, costMs: 21400 }], laps: [lap(8, 80), lap(9, 90, { pit: true })], stints: STINTS });
  assert.strictEqual(alone.stops[0].field_median_s, null);
  assert.doesNotMatch(alone.stops[0].text, /green-flag stops/);
});

// --- Laps that cost time, and why ---
test('lap losses: the laps furthest off your typical, each with what was recorded on it', () => {
  const laps = [lap(1, 90), ...[2, 3, 4, 6, 7, 8, 10, 11, 12].map((n) => lap(n, 80 + (n % 3) * 0.05)),
    lap(5, 82.4), lap(9, 81.0, { valid: false }), lap(13, 80.5)];
  const events = [{ lap: 5, code: 'COLL', what: 'Collision', driver: 'ANTONELLI', other_driver: 'YOU', involves_you: true, by_you: false }, { lap: 13, code: 'OVTK', what: 'Overtake', driver: 'HAMILTON', other_driver: 'YOU', involves_you: true, by_you: false }];
  const issues = [{ lap_num: 9, distance_m: 1200, kind: 'front_lock', wheel: 'front-left' }];
  const r = lapLosses({ laps, events, issues });
  assert.deepStrictEqual(r.worst.map((x) => x.lap), [5, 9]); // lap 13 is 0.5 s off: under the 0.7 s that counts as a loss
  const [a, b] = r.worst;
  assert.ok(a.lost_s > 2.3 && a.lost_s < 2.5);
  assert.match(a.text, /Lap 5 was 2\.\d\d s slower than your typical lap.*a collision with ANTONELLI/);
  assert.match(b.text, /invalid.*track limits/i);
  assert.match(b.text, /front-wheel locking \(front-left\) at 1\.2 km/);
  assert.ok(r.consistency.typical && r.consistency.within_half_s_pct >= 70);
});

test('lap losses: a slow lap with nothing recorded against it says so, and does not invent a cause', () => {
  const laps = [lap(1, 90), ...[2, 3, 4, 5, 6, 7, 8].map((n) => lap(n, 80)), lap(9, 81.5)];
  const r = lapLosses({ laps, events: [], issues: [] });
  assert.match(r.worst[0].text, /no collision, penalty, pass or locking was recorded/i);
});

test('lap losses: a steady race has no laps that cost time, and says how consistent it was', () => {
  const laps = [lap(1, 90), ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => lap(n, 80 + (n % 2) * 0.1))];
  const r = lapLosses({ laps, events: [], issues: [] });
  assert.deepStrictEqual(r.worst, []);
  assert.match(r.text, /no lap cost you more than 0\.7 s/i);
});

test('lap losses: too few clean laps to know what typical is', () => {
  assert.match(lapLosses({ laps: [lap(1, 90), lap(2, 80)], events: [], issues: [] }).error, /clean laps/);
});

// --- Race pace across the field ---
test('field pace: every car\'s typical clean lap, you ranked among them, and who set the fastest lap', () => {
  const car = (driver, you, base, n = 8, extra = {}) => ({ driver, you, laps: [lap(1, base + 5), ...Array.from({ length: n }, (_, i) => lap(2 + i, base + (i % 2) * 0.1)), lap(10, base + 20, { pit: true })], ...extra });
  const r = fieldPace([car('VERSTAPPEN', false, 79.0), car('LECLERC', false, 79.6), car('YOU', true, 79.4), car('SAINZ', false, 80.2), car('TINY', false, 81, 3)]);
  assert.deepStrictEqual(r.ranking.map((x) => x.driver), ['VERSTAPPEN', 'YOU', 'LECLERC', 'SAINZ']); // TINY ran under five clean laps
  assert.strictEqual(r.you.rank, 2);
  assert.ok(Math.abs(r.you.off_quickest_s - 0.4) < 0.01);
  assert.match(r.text, /2nd.*YOU|YOU.*2nd/);
  assert.strictEqual(r.fastest_lap.driver, 'VERSTAPPEN');
  // The answer to "who had the best race pace" comes first, and the fastest single lap is not mistaken for it
  // (a 1.7B model read "the fastest lap of the race: NORRIS" as the answer when the pace leader was PIASTRI).
  assert.match(r.text, /^The quickest race pace \(typical clean lap\) was VERSTAPPEN, 1:19\.050\./);
  assert.match(r.text, /fastest single lap of the race \(one lap, not race pace\)/i);
});

// --- The calls, and your other races here ---
test('calls review: the verdict counts and each call that was graded', () => {
  const audit = { summary: { calls: 3, graded: 2, right: 1, wrong: 1, unclear: 0 }, calls: [
    { lapNum: 4, action: 'PUSH', kind: 'push', reason: 'Tyres and fuel OK', verdict: 'right', why: '5 green laps, none fell away' },
    { lapNum: 9, action: 'BOX', kind: 'damage', reason: 'Front wing damage', verdict: 'wrong', why: 'Damage cost 0.4 s a lap, 4.0 s to the flag; a stop costs 21.0 s' },
    { lapNum: 10, action: 'PIT', kind: 'in-pit', reason: 'In the pit lane', verdict: 'rule', why: 'Following the rules' }] };
  const r = callsReview(audit);
  assert.match(r.text, /1 of the 2 calls it could grade were right and 1 wrong/);
  assert.deepStrictEqual(r.graded.map((c) => [c.lap, c.verdict]), [[4, 'right'], [9, 'wrong']]);
  assert.match(r.text, /lap 9 BOX .*wrong.*Damage cost/i);
});

test('calls review: a session with no calls recorded says that', () => {
  assert.match(callsReview({ summary: { calls: 0, graded: 0, right: 0, wrong: 0, unclear: 0 }, calls: [] }).text, /no engineer calls/i);
});

test('track history: this race against your others at the same track, by pace and by best lap', () => {
  const races = [
    { sessionId: 1, date: '2026-10-16', type: 'Race', grid: 18, finish: 18, bestMs: 78500, typicalMs: 80100 },
    { sessionId: 2, date: '2026-10-17', type: 'Race', grid: 15, finish: 7, bestMs: 76692, typicalMs: 78114 },
    { sessionId: 3, date: '2026-11-02', type: 'Race', grid: 10, finish: 5, bestMs: 77000, typicalMs: 77900 },
  ];
  const r = trackHistory({ track: 'Barcelona', races, sessionId: 2 });
  assert.strictEqual(r.races.length, 3);
  assert.deepStrictEqual([r.this_race.best_rank, r.this_race.pace_rank], [1, 2]);
  assert.match(r.text, /3 races at Barcelona/);
  assert.match(r.text, /this race was your best lap there/i);
  assert.match(r.text, /your typical lap went from 1:20\.100 to 1:17\.900/);
});

test('track history: one race at the track is no history', () => {
  assert.match(trackHistory({ track: 'Spa', races: [{ sessionId: 1, date: '2026-10-20', type: 'Race', bestMs: 80000, typicalMs: 81000 }], sessionId: 1 }).text, /only race/i);
});
