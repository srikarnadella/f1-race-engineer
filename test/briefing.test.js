const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/data/store');
const { briefing } = require('../src/analysis/briefing');
const { createPipeline } = require('../src/pipeline');
const { createTrackMemory } = require('../src/state/trackMemory');
const { syntheticPackets, replay } = require('./helpers/synthetic');

// The pre-race briefing: what your own earlier sessions at this track say, so the grid is not the first time you hear it.
const s = (over) => ({ startedAt: 1_000, sessionType: 15, name: 'Race', isRace: true, totalLaps: 20, grid: 8, finish: 5, stops: 1, bestLapMs: 90000, ...over });

test('briefing: nothing to say at a track you have not driven', () => {
  const b = briefing({ sessions: [], memory: {} });
  assert.deepStrictEqual(b, { sessions: 0, races: 0, bestLapMs: null, bestFinish: null, last: null, stops: null, pitLossS: null, wear: [] });
});

test('briefing: sessions and races counted, the best lap and best finish across them, the last race with its grid and result', () => {
  const b = briefing({
    sessions: [
      s({ startedAt: 1, sessionType: 5, name: 'Qualifying', isRace: false, finish: null, grid: null, stops: null, bestLapMs: 88000 }),
      s({ startedAt: 2, finish: 7, grid: 9, bestLapMs: 90500 }),
      s({ startedAt: 3, finish: 3, grid: 6, bestLapMs: 89900 }),
    ],
    memory: {},
  });
  assert.strictEqual(b.sessions, 3);
  assert.strictEqual(b.races, 2);
  assert.strictEqual(b.bestLapMs, 88000, 'the fastest lap of any session here');
  assert.strictEqual(b.bestFinish, 3);
  assert.deepStrictEqual(b.last, { name: 'Race', startedAt: 3, grid: 6, finish: 3 });
});

test('briefing: the usual number of stops is the median of your long races, and a sprint-length race is left out', () => {
  const b = briefing({ sessions: [s({ stops: 1 }), s({ stops: 2 }), s({ stops: 2 }), s({ totalLaps: 5, stops: 0 })], memory: {} });
  assert.strictEqual(b.stops, 2);
  assert.strictEqual(briefing({ sessions: [s({ totalLaps: 5, stops: 0 })], memory: {} }).stops, null);
});

test('briefing: the pit loss and the wear per compound come from what the track memory learned, as medians', () => {
  const b = briefing({ sessions: [], memory: { pitLossMs: [20000, 22000, 21000], deg16: [90, 110, 100], deg18: [30], deg17: [] } });
  assert.strictEqual(b.pitLossS, 21);
  assert.deepStrictEqual(b.wear, [{ compound: 16, msPerLap: 100 }, { compound: 18, msPerLap: 30 }], 'only compounds it has measured, soft first');
});

test('briefing: a stopped or retired car has no finish to credit, and unknown lap times are ignored', () => {
  const b = briefing({ sessions: [s({ finish: 0, bestLapMs: 0 }), s({ finish: 4, bestLapMs: null })], memory: {} });
  assert.strictEqual(b.bestFinish, 4);
  assert.strictEqual(b.bestLapMs, null);
});

test('store: trackHistory gives one row per session at the track for the player, with best clean lap, grid, result and stops', () => {
  const store = openStore(':memory:');
  replay(syntheticPackets(), { pipelineOptions: { store } }).flush();
  const trackId = store.db.prepare('SELECT track_id FROM session').get().track_id;
  const rows = store.trackHistory(trackId);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].isRace, true);
  assert.ok(rows[0].bestLapMs > 0 && rows[0].totalLaps > 0);
  assert.ok('grid' in rows[0] && 'finish' in rows[0] && 'stops' in rows[0]);
  assert.deepStrictEqual(store.trackHistory(trackId + 1), []);
});

test('pipeline: the snapshot carries the briefing for the track, from the store and the track memory', () => {
  const store = openStore(':memory:');
  const memory = createTrackMemory();
  replay(syntheticPackets(), { pipelineOptions: { store, memory } }).flush();
  let seen = null;
  replay(syntheticPackets(), { pipelineOptions: { store, memory }, onTick: ({ snap }) => { if (snap && snap.briefing) seen = snap.briefing; } }).flush();
  assert.ok(seen, 'a briefing');
  assert.strictEqual(seen.sessions, 1);
  assert.ok(createPipeline().snapshot().briefing === undefined || createPipeline().snapshot().briefing === null, 'nothing without a store');
});

// ---- the screen ----
const { open, raceSnapshots } = require('./helpers/dashboard');
const base = () => raceSnapshots().find((s) => s.player && s.analysis);
const history = (over = {}) => ({ track: 'Spa', sessions: 3, races: 2, bestLapMs: 88000, bestFinish: 3, last: { name: 'Race', startedAt: Date.UTC(2026, 9, 20), grid: 6, finish: 3 }, stops: 2, pitLossS: 21, wear: [{ compound: 16, msPerLap: 100 }, { compound: 18, msPerLap: 30 }], ...over });
const text = (app) => app.window.document.querySelector('.w-brief').textContent.replace(/\s+/g, ' ');
const show = (t, briefing) => {
  const app = open(t);
  app.connect();
  app.send({ ...base(), connected: true, briefing, setup: { available: false, track: 'Spa', circuit: null, kind: 'r', editable: false, inGarage: true, rows: [], off: 0, notes: null, source: null, history: null } }); // the Briefing is listed in the garage
  [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === 'Briefing').click();
  return app;
};

test('briefing screen: your history at the track, the usual stops, the pit loss and the wear per tyre', (t) => {
  const app = show(t, history());
  const x = text(app);
  assert.match(x, /Spa/);
  assert.match(x, /Here before\s*3 sessions\s*2 races/);
  assert.match(x, /Best lap\s*1:28\.000/);
  assert.match(x, /Best finish\s*P3/);
  assert.match(x, /Last race\s*P6 → P3/);
  assert.match(x, /Usual stops\s*2/);
  assert.match(x, /Pit stop cost\s*21 s/);
  assert.match(x, /Soft wear\s*\+0\.100 s\s*a lap/);
  assert.match(x, /Hard wear\s*\+0\.030 s\s*a lap/);
  assert.deepStrictEqual(app.errors, []);
});

test('briefing screen: the figures are separate cards like the other screens\' tiles, and the screen has no panel of its own', (t) => {
  const app = show(t, history());
  const slot = app.window.document.querySelector('.card--brief');
  assert.ok(slot.classList.contains('card--bare'));
  assert.ok(slot.querySelector('.w-brief__head'));
  assert.ok(slot.querySelectorAll('.w-brief__cell').length >= 6);
});

test('briefing screen: the figures are a labelled grid, one cell each, not a column of sentences', (t) => {
  const app = show(t, history());
  const cells = [...app.window.document.querySelectorAll('.w-brief__cell')];
  assert.deepStrictEqual(cells.map((c) => c.querySelector('span').textContent), ['Here before', 'Best lap', 'Best finish', 'Last race', 'Usual stops', 'Pit stop cost', 'Soft wear', 'Hard wear']);
  assert.strictEqual(cells[1].querySelector('b').textContent, '1:28.000');
  assert.strictEqual(app.window.document.querySelectorAll('.w-brief__list li').length, 0);
});

test('briefing screen: a figure the store does not have is left out, not shown as a dash or a zero', (t) => {
  const app = show(t, history({ bestLapMs: null, stops: null, pitLossS: null, wear: [], last: null, bestFinish: null }));
  assert.deepStrictEqual([...app.window.document.querySelectorAll('.w-brief__cell span')].map((s) => s.textContent), ['Here before']);
});

test('briefing screen: a first visit says so, and a missing briefing (no store) does not break the page', (t) => {
  const first = show(t, history({ sessions: 0, races: 0, bestLapMs: null, bestFinish: null, last: null, stops: null, pitLossS: null, wear: [] }));
  assert.match(text(first), /first time at Spa/i);
  const none = show(t, undefined);
  assert.match(text(none), /nothing to compare/i);
  assert.deepStrictEqual(first.errors.concat(none.errors), []);
});
