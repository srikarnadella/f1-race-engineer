// Bugs found in the races of 16 Nov 2026 (Madrid short qualifying + race, Singapore short sprint shootout + sprint),
// from the sessions and radio the app kept in race.db. Each test is the behaviour the race showed was missing.
const test = require('node:test');
const assert = require('node:assert');
const PACKET_IDS = require('../src/udp/packetIds');
const { TRACKS } = require('../src/udp/gameIds');
const { createFieldModel } = require('../src/state/fieldModel');
const { createInsightEngine } = require('../src/engine/insightEngine');
const { createRaceAnalysis } = require('../src/engine/raceAnalysis');
const { createFocus } = require('../src/engine/focus');
const { buildSnapshot } = require('../src/server/snapshot');
const { sessionName } = require('../src/state/race');
const { strategyOptions } = require('../src/analysis/strategyOptions');
const { computeAdjustments } = require('../src/engine/adjustments');
const { mapLoss } = require('../src/analysis/mapLoss');

const PLAYER = 2;
const header = (sessionTime, sessionUID = 1n) => ({ sessionUID, sessionTime, playerCarIndex: PLAYER });
function lapCars(overrides = {}) {
  return Array.from({ length: 5 }, (_, i) => ({
    carPosition: i + 1, currentLapNum: 10, lastLapTimeInMS: 90000, deltaToCarInFrontInMS: i === 0 ? 0 : 1000, pitStatus: 0, lapDistance: 2000,
    ...(overrides[i] || {}),
  }));
}
const race = (fm, over = {}) => {
  fm.dispatch(PACKET_IDS.SESSION, header(1), { sessionType: 15, totalLaps: 30, trackLength: 5000, trackId: 17, safetyCarStatus: 0, ...over });
  fm.dispatch(PACKET_IDS.CAR_STATUS, header(1), { cars: Array.from({ length: 5 }, () => ({ fuelRemainingLaps: 1, tyresAgeLaps: 10 })) });
};

test('Madrid is game track 42 (both Madrid sessions were filed as "track")', () => {
  assert.strictEqual(TRACKS[42], 'Madrid');
});

test('fuel: a margin the game loaded on purpose is not a warning; running short is (Singapore sprint: 19 "only 0.1 laps of margin")', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  fm.dispatch(PACKET_IDS.SESSION, header(1), { sessionType: 15, totalLaps: 7, trackLength: 4928 });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(2), { cars: lapCars({ [PLAYER]: { currentLapNum: 2 } }) });
  for (const margin of [0.3, 0.2, 0.1, 0.0]) {
    fm.dispatch(PACKET_IDS.CAR_STATUS, header(2), { cars: Array.from({ length: 5 }, () => ({ fuelRemainingLaps: margin })) });
    assert.ok(!ie.evaluate().some((i) => i.id === 'fuel-risk'), `no card at +${margin}`);
  }
  fm.dispatch(PACKET_IDS.CAR_STATUS, header(3), { cars: Array.from({ length: 5 }, () => ({ fuelRemainingLaps: -0.3 })) });
  assert.strictEqual(ie.evaluate().find((i) => i.id === 'fuel-risk').severity, 'critical');
});

test('a card whose words flip back and forth keeps its wording until the new words hold 5 s (Singapore: 9 "medium" <-> "medium to high" in 5 s)', () => {
  let t = 0;
  const fm = createFieldModel({ clock: () => t });
  const ie = createInsightEngine(fm);
  race(fm);
  const at = (ms, reason) => {
    t = ms;
    fm.dispatch(PACKET_IDS.LAP_DATA, header(ms / 1000), { cars: lapCars({ [PLAYER]: { deltaToCarInFrontInMS: 600 } }) });
    const c = ie.evaluate({ battle: { call: { mode: 'ATTACK', target: 'GASLY', reason } } }).find((i) => i.id === 'battle-call');
    return c && c.message;
  };
  const A = 'pass chance medium into corner 2';
  const B = 'pass chance medium to high into corner 2';
  for (const ms of [0, 2500, 5000]) at(ms, A);
  assert.strictEqual(at(5000, A), `Attack GASLY - ${A}`);
  // Flicking between the two every second: one change at most, not one a second.
  const said = [];
  for (let ms = 6000; ms <= 12000; ms += 1000) said.push(at(ms, ms % 2000 ? B : A));
  const changes = said.filter((m, i) => m !== (i ? said[i - 1] : `Attack GASLY - ${A}`)).length;
  assert.ok(changes <= 1, `changed ${changes} times: ${said.join(' | ')}`);
  // Then A holds: within 5 s it is what is said, and it stays.
  const held = said[said.length - 1];
  for (let ms = 13000; ms <= 18000; ms += 1000) at(ms, A);
  assert.strictEqual(at(18000, A), `Attack GASLY - ${A}`, `was ${held}`);
  // After a quiet spell a new reading is said at once.
  assert.strictEqual(at(25000, B), `Attack GASLY - ${B}`);
});

test('a more severe card is said at once, not held', () => {
  let t = 0;
  const fm = createFieldModel({ clock: () => t });
  const ie = createInsightEngine(fm);
  race(fm);
  const at = (ms, gap) => {
    t = ms;
    fm.dispatch(PACKET_IDS.LAP_DATA, header(ms / 1000), { cars: lapCars({ 3: { deltaToCarInFrontInMS: gap } }) });
    return ie.evaluate().find((i) => i.id === 'under-attack');
  };
  at(0, 800);
  at(1000, 800);
  const c = at(2000, 300);
  assert.strictEqual(c.severity, 'advisory');
  assert.match(c.message, /right behind you/);
});

test('the defend card has one wording, whoever writes it (Singapore: "Defend from X - 0.5s" and "X is 0.5s behind - defend" took turns)', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  race(fm);
  fm.dispatch(PACKET_IDS.LAP_DATA, header(2), { cars: lapCars({ 3: { deltaToCarInFrontInMS: 700 } }) });
  assert.match(ie.evaluate().find((i) => i.id === 'under-attack').message, /^Defend from P4 - 0\.7s behind/);
});

test('closing-ahead compares the gap a lap apart, so the gap swinging round the lap is not pace (Singapore: "closing by 2.9s/lap", gap 1.3-1.5s)', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  race(fm);
  // A 90 s lap: the gap breathes 0.4 s with where you are on the lap (faster car on the straights), no trend.
  for (let t = 0; t <= 200; t += 0.5) {
    const gap = 1500 + 400 * Math.sin((2 * Math.PI * t) / 90);
    fm.dispatch(PACKET_IDS.LAP_DATA, header(t), { cars: lapCars({ [PLAYER]: { deltaToCarInFrontInMS: gap } }) });
    assert.ok(!ie.evaluate().some((i) => i.id === 'closing-ahead'), `no closing call at ${t}s`);
  }
});

test('closing-ahead still calls a real closing rate once there is a lap of gap history', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  race(fm);
  for (let t = 0; t <= 100; t += 0.5) {
    const gap = 3000 - (t / 90) * 300 + 400 * Math.sin((2 * Math.PI * t) / 90);
    fm.dispatch(PACKET_IDS.LAP_DATA, header(t), { cars: lapCars({ [PLAYER]: { deltaToCarInFrontInMS: gap } }) });
  }
  assert.match(ie.evaluate().find((i) => i.id === 'closing-ahead').message, /by 0\.3s\/lap/);
});

test('ERS on the last lap: the radio leaves the battery figure out (Singapore: rewritten every 5 s, 50% -> 100% -> 80%)', () => {
  const player = { lapData: { currentLapNum: 7 }, status: { ersStoreEnergy: 0.6 * 4e6, ersDeployMode: 1 }, setup: {}, ersHistory: [] };
  const tip = computeAdjustments({ issues: [], player, lapsLeft: 0.8 }).suggestions.find((s) => s.kind === 'ers');
  assert.match(tip.radio, /^Last lap - empty the battery, \w+ mode$/);
  assert.match(tip.why, /battery ~60%/, 'the Adjust card still has the figure');
});

test('qualifying: back out of the garage mid-session, the push lap is not a pit lap (Madrid: the 1:32.311 best was marked PIT)', () => {
  const fm = createFieldModel();
  fm.dispatch(PACKET_IDS.SESSION, header(0), { sessionType: 8, trackLength: 5411 });
  const me = (t, o) => fm.dispatch(PACKET_IDS.LAP_DATA, header(t), { cars: lapCars({ [PLAYER]: { currentLapNum: 4, lastLapTimeInMS: 93538, ...o } }) });
  // Lap 3 done, in-lap begun as lap 4, then back to the garage.
  me(1, { pitStatus: 0, lapDistance: 300 });
  me(2, { pitStatus: 2, lapDistance: 300 });
  // Out again: the car joins near the end of the lap, still lap 4, and crosses the line to start the push lap.
  me(3, { pitStatus: 1, lapDistance: 4900 });
  me(4, { pitStatus: 0, lapDistance: 5300 });
  me(5, { pitStatus: 0, lapDistance: 30 });
  me(6, { pitStatus: 0, lapDistance: 5000 });
  me(7, { currentLapNum: 5, lastLapTimeInMS: 92311, pitStatus: 0, lapDistance: 20 });
  const lap4 = fm.getCar(PLAYER).lapHistory.find((l) => l.lapNum === 4);
  assert.deepStrictEqual([lap4.lapMs, lap4.pit], [92311, false]);
});

test('retired under a safety car: the screens let go of the safety car (Madrid: stuck on it after the crash)', () => {
  const fm = createFieldModel();
  race(fm, { safetyCarStatus: 1, totalLaps: 20 });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(2), { cars: lapCars({ [PLAYER]: { currentLapNum: 2, resultStatus: 2 } }) });
  const ie = createInsightEngine(fm);
  const ra = createRaceAnalysis(fm);
  const focus = createFocus(() => 0);
  assert.notStrictEqual(buildSnapshot(fm, ie, ra, focus).focus.reason, 'Session over', 'still racing under the safety car');
  // Terminal damage: out of the race. The game sends no classification until the rest of the race is run.
  fm.dispatch(PACKET_IDS.LAP_DATA, header(3), { cars: lapCars({ [PLAYER]: { currentLapNum: 2, resultStatus: 4 } }) });
  const snap = buildSnapshot(fm, ie, ra, focus);
  assert.deepStrictEqual([snap.focus.screen, snap.focus.reason], ['debrief', 'Session over']);
  assert.strictEqual(snap.analysis.options, null, 'no stay-out / box options for a car that is out');
});

test('a race on a sprint weekend is the Sprint, and the race after it is the Race (Singapore: the 7-lap sprint was filed as "Race")', () => {
  const weekend = 777;
  assert.strictEqual(sessionName({ sessionType: 15, weekendLinkIdentifier: weekend }), 'Race', 'no shootout seen: a race');
  assert.strictEqual(sessionName({ sessionType: 13, weekendLinkIdentifier: weekend }), 'Short sprint shootout');
  assert.strictEqual(sessionName({ sessionType: 15, weekendLinkIdentifier: weekend }), 'Sprint');
  assert.strictEqual(sessionName({ sessionType: 16, weekendLinkIdentifier: weekend }), 'Race');
  assert.strictEqual(sessionName({ sessionType: 15, weekendLinkIdentifier: 778 }), 'Race', 'another weekend');
});

test('safety-car options read as words: "box for wets", not "box: wet:" (Madrid VSC)', () => {
  const o = strategyOptions({
    situation: 'VSC', lapsLeft: 19, player: { status: { visualTyreCompound: 7, tyresAgeLaps: 1 }, lapData: { carPosition: 8 } },
    tyreSets: [
      { visualTyreCompound: 7, available: true, fitted: true, wear: 3, lifeSpan: 16, usableLife: 16, lapDeltaTimeMs: 0 },
      { visualTyreCompound: 8, available: true, fitted: false, wear: 0, lifeSpan: 30, usableLife: 30, lapDeltaTimeMs: 1600 },
    ],
    rejoin: { position: 22, positionsLost: 14 }, stopLossMs: 12000, normalLossMs: 20000, wetConditions: true,
  });
  assert.ok(o, 'two options');
  assert.doesNotMatch(o.headline, /box: /);
  assert.match(o.headline, /box for wets/);
});

test('the chequered flag is said once (Singapore: twice, 11 s apart)', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  race(fm);
  fm.dispatch(PACKET_IDS.LAP_DATA, header(2), { cars: lapCars() });
  fm.dispatch(PACKET_IDS.EVENT, header(2), { code: 'CHQF', name: 'Chequered Flag' });
  assert.strictEqual(ie.evaluate().filter((i) => i.message === 'Chequered Flag').length, 1);
  fm.dispatch(PACKET_IDS.EVENT, header(13), { code: 'CHQF', name: 'Chequered Flag' });
  const all = ie.evaluate().filter((i) => /^event-/.test(i.id) && i.message === 'Chequered Flag');
  assert.strictEqual(all.length, 1);
});

// ---------- the map: where on the lap the time goes ----------
const N = 25;
const splitsWith = (base, extra = {}) => Array.from({ length: N }, (_, k) => base + (extra[k] || 0));
const carWith = (laps, { pit = [], name = 'NORRIS' } = {}) => ({
  participant: { name },
  miniSectors: laps.map((splits, i) => ({ lapNum: i + 2, splits })),
  lapHistory: laps.map((s, i) => ({ lapNum: i + 2, lapMs: s.reduce((a, b) => a + b, 0), pit: pit.includes(i + 2), neutralised: false })),
});

test('map: your last lap against your laps before it, slice by slice', () => {
  const me = carWith([splitsWith(3600), splitsWith(3600), splitsWith(3600, { 4: 50 }), splitsWith(3600, { 4: 250, 10: -80 })]);
  const m = mapLoss({ player: me, ahead: null, corners: [{ corner: 3, startM: 760 }, { corner: 5, startM: 2050 }], trackLength: 5000 });
  assert.strictEqual(m.laps.sectors.length, N);
  assert.strictEqual(m.laps.sectors[4], 250, 'lost against the median of the laps before (3600)');
  assert.strictEqual(m.laps.sectors[10], -80);
  assert.strictEqual(m.laps.sectors[0], 0);
  // Slice 4 is 800-1000 m: corner 3 starts just before it.
  assert.deepStrictEqual(m.laps.worst, { sector: 4, ms: 250, corner: 3 });
  assert.strictEqual(m.ahead, null);
});

test('map: against the car ahead, your recent laps vs theirs; pit laps left out', () => {
  const me = carWith([splitsWith(3600, { 7: 120 }), splitsWith(3600, { 7: 120 }), splitsWith(3600, { 7: 120 })]);
  const them = carWith([splitsWith(3600), splitsWith(9000)], { pit: [3], name: 'GASLY' });
  const m = mapLoss({ player: me, ahead: them, corners: [], trackLength: 5000 });
  assert.strictEqual(m.ahead.name, 'GASLY');
  assert.strictEqual(m.ahead.sectors[7], 120);
  assert.strictEqual(m.ahead.sectors[3], 0, 'their pit lap is not in it');
  assert.deepStrictEqual(m.ahead.worst, { sector: 7, ms: 120, corner: null });
});

test('map: nothing to compare yet is null, not zeros', () => {
  const m = mapLoss({ player: carWith([splitsWith(3600)]), ahead: carWith([]), corners: [], trackLength: 5000 });
  assert.strictEqual(m.laps, null, 'one lap: nothing before it');
  assert.strictEqual(m.ahead, null, 'no laps for them');
});
