const test = require('node:test');
const assert = require('node:assert');
const { auditCalls } = require('../src/analysis/callsAudit');

// The calls audit (roadmap A2): after the race, each call is graded against
// what then happened, on the lap dataset's rows. A call claims something, and
// is right or wrong by the one thing it claims:
//   PUSH (tyres OK)     the tyres hold: no two green laps in a row 1.5 s+ off the pace before
//   HOLD manage tyres   the cliff is near: a lap 1.5 s+ off within 3 laps after
//   BOX damage          the damage costs more to the flag than a stop does
//   BOX safety car/VSC  the stop costs less than one under green
//   BOX weather         the tyre it called for is quicker over the 3 laps after
// Following the rules (in the pits, under a safety car, a penalty) isn't graded.

const PACE = 80000;

// A race of `cars` cars, `totalLaps` laps, everyone at PACE. `player(lap)`
// overrides the player's (car 0) lap; `field(car, lap)` anyone else's.
function race({ cars = 5, totalLaps = 20, player = () => ({}), field = () => ({}) } = {}) {
  const rows = [];
  for (let c = 0; c < cars; c++) {
    for (let lap = 1; lap <= totalLaps; lap++) {
      rows.push({ raceId: 'r', totalLaps, carIndex: c, isPlayer: c === 0, lapNum: lap, lapMs: PACE, pit: false, neutralised: false, compound: 17, tyreAge: lap - 1, ...(c === 0 ? player(lap) : field(c, lap)) });
    }
  }
  return rows;
}

const call = (lapNum, action, kind) => ({ lapNum, action, kind, reason: '' });
const only = (laps, calls) => auditCalls(calls, laps).calls;

test('calls audit: PUSH is right while the tyres hold', () => {
  const [c] = only(race({ player: (lap) => ({ lapMs: PACE + 100 * lap }) }), [call(1, 'PUSH', 'ok')]);
  assert.strictEqual(c.verdict, 'right', c.why);
});

test('calls audit: PUSH is wrong when two green laps in a row fall 1.5 s off the pace before', () => {
  const [c] = only(race({ player: (lap) => ({ lapMs: lap >= 12 ? PACE + 2000 : PACE }) }), [call(1, 'PUSH', 'ok')]);
  assert.strictEqual(c.verdict, 'wrong');
  assert.match(c.why, /lap 12/);
});

test('calls audit: two slow laps that come back to pace on the same tyres were a fight, not the tyres (Spa, 20 Oct 2026)', () => {
  // Laps 13-14 ~2.5 s off while wheel to wheel with HADJAR and VERSTAPPEN, then lap 15 quicker than before.
  const [c] = only(race({ totalLaps: 15, player: (lap) => ({ lapMs: lap === 13 || lap === 14 ? PACE + 2500 : PACE }) }), [call(8, 'PUSH', 'ok')]);
  assert.notStrictEqual(c.verdict, 'wrong', c.why);
});

test('calls audit: one slow lap (traffic, a mistake) does not make PUSH wrong', () => {
  const [c] = only(race({ player: (lap) => ({ lapMs: lap === 12 ? PACE + 3000 : PACE }) }), [call(1, 'PUSH', 'ok')]);
  assert.strictEqual(c.verdict, 'right', c.why);
});

test('calls audit: a call answers only for its own laps, up to the next call', () => {
  const laps = race({ player: (lap) => ({ lapMs: lap >= 12 ? PACE + 2000 : PACE }) });
  const [push, hold] = only(laps, [call(1, 'PUSH', 'ok'), call(11, 'HOLD', 'tyres')]);
  assert.strictEqual(push.verdict, 'right', push.why);
  assert.strictEqual(hold.verdict, 'right', hold.why);
});

test('calls audit: pit laps, neutralised laps and a new set are not judged against the old best', () => {
  // Stop on laps 8-9, a safety car 10-11, and a harder, slower set after.
  const [c] = only(race({
    player: (lap) => ({
      lapMs: lap <= 7 ? PACE : lap <= 11 ? PACE + 20000 : PACE + 1600,
      pit: lap === 8 || lap === 9,
      neutralised: lap === 10 || lap === 11,
      compound: lap >= 9 ? 18 : 17,
    }),
  }), [call(1, 'PUSH', 'ok')]);
  assert.strictEqual(c.verdict, 'right', c.why);
});

test('calls audit: PUSH with no green lap after it cannot be judged', () => {
  const [c] = only(race({ totalLaps: 3, player: () => ({ neutralised: true }) }), [call(1, 'PUSH', 'ok')]);
  assert.strictEqual(c.verdict, 'unclear');
});

test('calls audit: HOLD for the tyres is wrong when three more green laps on the set stay on pace', () => {
  const [c] = only(race(), [call(5, 'HOLD', 'tyres')]);
  assert.strictEqual(c.verdict, 'wrong');
});

test('calls audit: following the rules is not graded', () => {
  const graded = only(race(), ['pit', 'neutralised', 'red-flag', 'penalty', 'too-late'].map((k, i) => call(i + 1, 'HOLD', k)));
  assert.deepStrictEqual(graded.map((c) => c.verdict), ['rule', 'rule', 'rule', 'rule', 'rule']);
});

// Damage on lap 6 costs 3 s a lap; the field's green stops (in + out lap) cost 20 s.
const damaged = (extra) => race({
  totalLaps: 20,
  player: (lap) => ({ lapMs: lap >= 6 ? PACE + 3000 : PACE }),
  // Car 1 stops on laps 10-11 under green, 20 s over the two laps.
  field: (c, lap) => (c === 1 && (lap === 10 || lap === 11) ? { pit: true, lapMs: PACE + 10000 } : {}),
  ...extra,
});

test('calls audit: BOX for damage is right when the loss to the flag beats a stop', () => {
  // 3 s a lap for 14 laps (call on lap 6 of 20) = 42 s > 20 s.
  const [c] = only(damaged(), [call(6, 'BOX', 'damage')]);
  assert.strictEqual(c.verdict, 'right', c.why);
  assert.match(c.why, /20(\.0)?s/, 'names the stop cost it compared against');
});

test('calls audit: BOX for damage is wrong when too few laps are left to win the stop back', () => {
  // 3 s a lap for 4 laps = 12 s < 20 s.
  const [c] = only(damaged(), [call(16, 'BOX', 'damage')]);
  assert.strictEqual(c.verdict, 'wrong', c.why);
});

test('calls audit: BOX for damage with no clean lap before it cannot be judged', () => {
  const [c] = only(damaged({ player: () => ({ lapMs: PACE + 3000 }) }), [call(1, 'BOX', 'damage')]);
  assert.strictEqual(c.verdict, 'unclear');
});

// A safety car on laps 8-10: everyone's laps 30 s slower.
const sc = (lap) => lap >= 8 && lap <= 10;
const scRace = (stopCost) => race({
  player: (lap) => ({ neutralised: sc(lap), pit: lap === 8 || lap === 9, lapMs: (sc(lap) ? PACE + 30000 : PACE) + (lap === 8 || lap === 9 ? stopCost / 2 : 0) }),
  field: (c, lap) => ({ neutralised: sc(lap), lapMs: sc(lap) ? PACE + 30000 : PACE, ...(c === 1 && (lap === 14 || lap === 15) ? { pit: true, lapMs: PACE + 10000 } : {}) }),
});

test('calls audit: BOX under a safety car is right when the stop costs less than a green one', () => {
  const [c] = only(scRace(9000), [call(8, 'BOX', 'cheap-stop')]);
  assert.strictEqual(c.verdict, 'right', c.why);
  assert.match(c.why, /9(\.0)?s/);
});

test('calls audit: BOX under a safety car is wrong when the stop cost as much as a green one', () => {
  const [c] = only(scRace(24000), [call(8, 'BOX', 'cheap-stop')]);
  assert.strictEqual(c.verdict, 'wrong', c.why);
});

test('calls audit: a cheap stop not taken cannot be judged from the laps', () => {
  const laps = scRace(9000).map((r) => (r.isPlayer ? { ...r, pit: false } : r));
  const [c] = only(laps, [call(8, 'BOX', 'cheap-stop')]);
  assert.strictEqual(c.verdict, 'unclear');
});

test('calls audit: the summary counts each verdict', () => {
  const { summary } = auditCalls([call(1, 'PUSH', 'ok'), call(10, 'HOLD', 'neutralised'), call(12, 'HOLD', 'tyres')], race());
  assert.deepStrictEqual(summary, { calls: 3, graded: 2, right: 1, wrong: 1, unclear: 0 });
});

test('calls audit: slow laps after a damage call are the damage, not the tyres', () => {
  // Suzuka: wing damage on lap 2, the call went back to PUSH, laps 4-5 were 2 s off.
  const laps = race({ player: (lap) => ({ lapMs: lap >= 4 ? PACE + 2000 : PACE }) });
  const [, , push] = only(laps, [call(1, 'PUSH', 'ok'), call(2, 'BOX', 'damage'), call(2, 'PUSH', 'ok')]);
  assert.notStrictEqual(push.verdict, 'wrong', push.why);
});

// BOX weather (inters or slicks) claims that tyre is quicker now: on the laps
// after the call, cars on it against cars on the other one, lap by lap.
const weatherCall = (lapNum, tyre) => ({ lapNum, action: 'BOX', kind: 'weather', reason: `Rain within ~1 lap - box for ${tyre}` });
// From lap 11 it rains: cars 1-2 are on inters at 78s, cars 3-4 stay on slicks at 82s.
const wetRace = () => race({
  field: (c, lap) => (lap >= 11 ? (c <= 2 ? { compound: 7, lapMs: 78000 } : { lapMs: 82000 }) : {}),
});

test('calls audit: BOX for inters is right when the cars on inters are quicker after it', () => {
  const [c] = only(wetRace(), [weatherCall(10, 'inters')]);
  assert.strictEqual(c.verdict, 'right', c.why);
  assert.match(c.why, /4\.0s/);
});

test('calls audit: BOX for slicks is wrong when the cars on inters are quicker (Austria, 19 Oct 2026)', () => {
  const [c] = only(wetRace(), [weatherCall(12, 'slicks')]);
  assert.strictEqual(c.verdict, 'wrong', c.why);
});

test('calls audit: a weather call with nobody on the other tyre to compare is unclear', () => {
  const [c] = only(race(), [weatherCall(10, 'inters')]);
  assert.strictEqual(c.verdict, 'unclear');
  assert.notStrictEqual(c.why, 'No test for this call yet');
});

test('calls audit: the standing-start lap 1 is not a clean lap to judge damage against (Silverstone sprint, 19 Oct 2026)', () => {
  // Damage called on lap 2; lap 1 was 3 s slower only because of the start.
  const [c] = only(damaged({ player: (lap) => ({ lapMs: lap === 1 ? PACE + 3000 : PACE }) }), [call(2, 'BOX', 'damage')]);
  assert.strictEqual(c.verdict, 'unclear', c.why);
});
