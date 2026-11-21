const test = require('node:test');
const assert = require('node:assert');
const PACKET_IDS = require('../src/udp/packetIds');
const { createPipeline } = require('../src/pipeline');
const { open, raceSnapshots } = require('./helpers/dashboard');

// The tyre sets you have left (the game's Tyre Sets packet, already parsed and fed to pit timing, but shown nowhere
// before 20 Nov 2026): a screen in the garage, and a widget for Custom screens.

const PLAYER = 1;
const set = (index, visualTyreCompound, o = {}) => ({ index, actualTyreCompound: 0, visualTyreCompound, wear: 0, available: true, recommendedSession: 0, lifeSpan: 20, usableLife: 20, lapDeltaTimeMs: 0, fitted: false, ...o });

test('snapshot: your sets that are left or fitted, each with its wear, laps of life and pace against the fitted set', () => {
  let t = 1_000_000;
  const p = createPipeline({ now: () => t });
  const H = { sessionUID: 5n, sessionTime: 10, playerCarIndex: PLAYER };
  p.dispatch(PACKET_IDS.SESSION, H, { sessionType: 5, trackLength: 5000, totalLaps: 0 });
  p.dispatch(PACKET_IDS.LAP_DATA, H, { cars: [0, 1].map((i) => ({ carPosition: i + 1, currentLapNum: 1, pitStatus: 2, lapDistance: 0 })) });
  p.dispatch(PACKET_IDS.TYRE_SETS, H, { carIdx: PLAYER, sets: [
    set(0, 16, { wear: 12, lifeSpan: 9, fitted: true }),
    set(1, 16, { lapDeltaTimeMs: -350 }),
    set(2, 17, { wear: 30, lifeSpan: 14, lapDeltaTimeMs: 420 }),
    set(3, 18, { available: false }), // used up or handed back: not yours to fit
  ] });
  p.dispatch(PACKET_IDS.TYRE_SETS, H, { carIdx: 0, sets: [set(0, 18, { fitted: true })] }); // another car's: not shown
  t += 100;
  assert.deepStrictEqual(p.tick().player.tyreSets, [
    { compound: 16, wear: 12, lapsLeft: 9, deltaMs: 0, fitted: true },
    { compound: 16, wear: 0, lapsLeft: 20, deltaMs: -350, fitted: false },
    { compound: 17, wear: 30, lapsLeft: 14, deltaMs: 420, fitted: false },
  ]);
});

// ---- the screen ----
const base = () => raceSnapshots().find((s) => s.player && s.analysis);
const garage = { available: false, track: 'Spa', circuit: null, kind: 'q', editable: true, inGarage: true, rows: [], off: 0, notes: null, source: null };
const sets = [
  { compound: 17, wear: 30, lapsLeft: 14, deltaMs: 420, fitted: false },
  { compound: 16, wear: 12, lapsLeft: 9, deltaMs: 0, fitted: true },
  { compound: 18, wear: 0, lapsLeft: 30, deltaMs: 900, fitted: false },
  { compound: 16, wear: 0, lapsLeft: 20, deltaMs: -350, fitted: false },
];
const snap = (tyreSets, setup = garage) => ({ ...base(), connected: true, setup, player: { ...base().player, tyreSets } });
const tabs = (app) => [...app.window.document.querySelectorAll('.tab')].map((b) => b.lastChild.textContent);
const rows = (app) => [...app.window.document.querySelectorAll('.w-ts__row')];

test('tyres screen: listed in the garage only; the fitted set first, then the rest softest first and freshest first', (t) => {
  const app = open(t, { storage: { 'raceEngineer.setupAuto': false } });
  app.connect();
  app.send(snap(sets, { ...garage, inGarage: false }));
  assert.ok(!tabs(app).includes('Tyres'), 'not out on track');
  app.send(snap(sets));
  assert.ok(tabs(app).includes('Tyres'));
  [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === 'Tyres').click();
  app.send(snap(sets));
  const r = rows(app);
  assert.strictEqual(r.length, 4);
  assert.deepStrictEqual(r.map((x) => x.querySelector('.compound').textContent), ['S', 'S', 'M', 'H']);
  assert.ok(r[0].classList.contains('is-fitted'));
  assert.match(r[0].textContent, /Fitted/);
  assert.match(r[0].textContent, /12%/);
  assert.match(r[0].textContent, /9 laps/);
  assert.match(r[1].textContent, /New/, 'no wear: a new set');
  assert.match(r[1].textContent, /0\.35s faster/);
  assert.match(r[2].textContent, /0\.42s slower/);
  assert.match(app.window.document.querySelector('.w-ts__sum').textContent, /^3 sets left: 1 soft, 1 medium, 1 hard$/);
  assert.deepStrictEqual(app.errors, []);
});

test('tyres screen: before the game has sent your sets it says when they come', (t) => {
  const app = open(t, { storage: { 'raceEngineer.setupAuto': false } });
  app.connect();
  app.send(snap(null));
  [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === 'Tyres').click();
  app.send(snap(null));
  assert.strictEqual(rows(app).length, 0);
  assert.match(app.window.document.querySelector('.w-ts__sum').textContent, /game sends your tyre sets/i);
  assert.deepStrictEqual(app.errors, []);
});
