const test = require('node:test');
const assert = require('node:assert');
const { fieldRules } = require('../src/analysis/fieldRules');
const { open, raceSnapshots } = require('./helpers/dashboard');
const { createFieldModel } = require('../src/state/fieldModel');
const { createRaceAnalysis } = require('../src/engine/raceAnalysis');
const { qualifying } = require('../src/analysis/qualifying');

// Online lobbies can mix cars on the 2025 rules (DRS) and the 2026 rules (active aero, Overtake mode). The game says which
// per car in Car Telemetry 2 (regulations2026); this shows it, but only when the field really is mixed.
const car = (regs2026) => ({ regs2026 });

test('field rules: counts the cars on each rule set, mixed only when both are in the field', () => {
  assert.deepStrictEqual(fieldRules([car(true), car(true), car(true)]), { cars2026: 3, cars2025: 0, unknown: 0, mixed: false });
  assert.deepStrictEqual(fieldRules([car(false), car(false)]), { cars2026: 0, cars2025: 2, unknown: 0, mixed: false });
  assert.deepStrictEqual(fieldRules([car(true), car(false), car(false), car(null)]), { cars2026: 1, cars2025: 2, unknown: 1, mixed: true });
  assert.deepStrictEqual(fieldRules([]), { cars2026: 0, cars2025: 0, unknown: 0, mixed: false });
  assert.deepStrictEqual(fieldRules(undefined), { cars2026: 0, cars2025: 0, unknown: 0, mixed: false });
});

test('field rules: each car in the field list carries its own flag, from Car Telemetry 2', () => {
  const PACKET_IDS = require('../src/udp/packetIds');
  const fm = createFieldModel();
  const header = (t) => ({ sessionUID: 1n, sessionTime: t, frameIdentifier: t, playerCarIndex: 0 });
  fm.dispatch(PACKET_IDS.SESSION, header(0), { trackId: 17, totalLaps: 20, trackLength: 4318, sessionType: 15 });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(1), { cars: Array.from({ length: 4 }, (_, i) => ({ carPosition: i + 1, currentLapNum: 3, lapDistance: 1000 - i * 20, pitStatus: 0, driverStatus: 4, lastLapTimeInMS: 90000, currentLapTimeInMS: 40000, deltaToCarInFrontInMS: 800, totalDistance: 9000 - i * 20, numPitStops: 0, resultStatus: 2 })) });
  fm.dispatch(PACKET_IDS.CAR_TELEMETRY_2, header(2), { cars: [true, false, true, false].map((r) => ({ regulations2026: r, overtakeAvailable: false })) });
  const { field } = createRaceAnalysis(fm).compute();
  assert.deepStrictEqual(field.map((c) => c.regs2026), [true, false, true, false]);
});

test('field rules: qualifying order rows carry it too', () => {
  const cars = [0, 1, 2].map((i) => ({ carIndex: i, participant: { name: `D${i}` }, telemetry: { speed: 100 }, telemetry2: { regulations2026: i !== 1 }, lapData: { pitStatus: 0, driverStatus: 4, lapDistance: 100, lastLapTimeInMS: 0, currentLapInvalid: 0 }, sessionHistory: { bestLapNum: 1, laps: [{ lapMs: 90000 + i * 100, valid: true }] } }));
  const q = qualifying({ session: { sessionType: 5, trackLength: 5000, sessionTimeLeft: 300 }, cars, player: cars[0], delta: { bestLapTimeInMS: 90000 } });
  assert.deepStrictEqual(q.order.map((e) => e.regs2026), [true, false, true]);
});

const base = () => raceSnapshots().find((s) => s.player && s.analysis && s.field && s.field.length > 3);
const withRules = (rules, flags) => {
  const s = base();
  return { ...s, connected: true, rules, field: s.field.map((c, i) => ({ ...c, regs2026: flags[i % flags.length] })), nearby: s.nearby.map((c, i) => ({ ...c, regs2026: flags[i % flags.length] })) };
};

test('mixed field: a chip in the header and a \'25 or \'26 tag by each name in the tables, only when the lobby is mixed', (t) => {
  const app = open(t);
  app.connect();
  app.send(withRules({ cars2026: 12, cars2025: 8, unknown: 0, mixed: true }, [true, false]));
  const chip = app.$('rules');
  assert.strictEqual(chip.hidden, false);
  assert.match(chip.textContent, /Mixed/);
  assert.match(chip.title, /12 cars on the 2026 rules, 8 on the 2025 rules/);
  [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === 'Battle').click();
  const names = () => ['aName', 'bName'].map((k) => app.window.document.querySelector(`[data-ref="${k}"]`).textContent);
  assert.ok(names().some((n) => /'2[56]$/.test(n)), `the car ahead and behind carry their rules: ${names().join(' | ')}`);
  app.send(withRules({ cars2026: 20, cars2025: 0, unknown: 0, mixed: false }, [true]));
  assert.strictEqual(app.$('rules').hidden, true, 'a field of one rule set says nothing');
  assert.ok(names().every((n) => !/'2[56]/.test(n)), names().join(' | '));
  assert.deepStrictEqual(app.errors, []);
});

test('mixed field: a snapshot with no rules (nothing from the game yet) shows nothing and does not fail', (t) => {
  const app = open(t);
  app.connect();
  const s = base();
  delete s.rules;
  app.send({ ...s, connected: true });
  assert.strictEqual(app.$('rules').hidden, true);
  assert.deepStrictEqual(app.errors, []);
});

test('mixed field: the qualifying order and the Around-you table carry the tags too, and only in a mixed field', (t) => {
  const order = [
    { name: 'LECLERC', isPlayer: false, position: 1, bestMs: 105000, gapMs: 0, status: 'garage', compound: 16, cutLine: false, regs2026: true },
    { name: 'YOU', isPlayer: true, position: 2, bestMs: 105400, gapMs: 400, status: 'flying', compound: 16, cutLine: false, regs2026: false },
  ];
  const q = { kind: 'qualifying', name: 'Q1', status: 'garage', lapInvalid: false, timeLeftS: 300, position: 2, bestMs: 105400, poleMs: 105000, gapToPoleMs: 400, cut: null, projected: null, lapGone: false, toLine: null, runs: 1, traffic: { ahead: null, behind: null }, order, pushing: 1 };
  const app = open(t);
  app.connect();
  const s = base();
  app.send({ ...s, connected: true, analysis: { ...s.analysis, quali: q }, rules: { cars2026: 1, cars2025: 1, unknown: 0, mixed: true } });
  [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === 'Order').click();
  const names = () => [...app.window.document.querySelectorAll('.w-qo tbody tr')].map((r) => r.children[1].textContent);
  assert.deepStrictEqual(names(), ["LECLERC'26", "YOU'25"]);
  app.send({ ...s, connected: true, analysis: { ...s.analysis, quali: q }, rules: { cars2026: 2, cars2025: 0, unknown: 0, mixed: false } });
  assert.deepStrictEqual(names(), ['LECLERC', 'YOU']);
  assert.deepStrictEqual(app.errors, []);
});

// The hint on a rival who is close behind follows the RIVAL's rules: a 2025 car behind a 2026 car attacks with DRS, a 2026
// car behind a 2025 car with Overtake mode. (The car ahead is judged on your own rules: you are the one attacking.)
const behindCar = (over) => ({ ...base().nearby[0], gapToPlayerMs: 500, pitStatus: 0, lapsToDrs: null, overtakeAvailable: false, ...over });
const sendBattle = (app, you2026, rival, mixed) => {
  const s = base();
  app.send({ ...s, connected: true, session: { ...s.session, safetyCarStatus: 0 }, rules: { cars2026: 1, cars2025: 1, unknown: 0, mixed }, analysis: { ...s.analysis, regs2026: you2026 }, nearby: [behindCar(rival)] });
  return app.window.document.querySelector('[data-ref="bExtra"]').textContent;
};

test('mixed field: a 2025 car close behind a 2026 car is a DRS threat, and a 2026 car behind a 2025 car has Overtake mode', (t) => {
  const app = open(t);
  app.connect();
  [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === 'Battle').click();
  assert.match(sendBattle(app, true, { regs2026: false }, true), /DRS/);
  assert.match(sendBattle(app, false, { regs2026: true, overtakeAvailable: true }, true), /Overtake mode on you/);
  assert.doesNotMatch(sendBattle(app, true, { regs2026: true, overtakeAvailable: false }, true), /DRS/);
});

test('mixed field: in an ordinary field, or when the rival\'s rules are unknown, it is judged on your rules as before', (t) => {
  const app = open(t);
  app.connect();
  [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === 'Battle').click();
  assert.doesNotMatch(sendBattle(app, true, { regs2026: null }, false), /DRS/);
  assert.match(sendBattle(app, false, { regs2026: null }, false), /DRS/);
});

test('mixed field: a field the game does not call mixed ignores a stray flag on one car and keeps your rules', (t) => {
  const app = open(t);
  app.connect();
  [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === 'Battle').click();
  assert.doesNotMatch(sendBattle(app, true, { regs2026: false }, false), /DRS/);
});
