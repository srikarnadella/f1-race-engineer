const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');

// The Setups place (public/setups.js): every setup you ran at each track with its stats, names and stars, links to the
// races, and a side-by-side compare. It shows what the setup library (src/analysis/setupLibrary.js) built and writes only
// names, stars and notes (through the app's saveSetupNote).
const K1 = 'aaaaaaaaaaaa';
const K2 = 'bbbbbbbbbbbb';
const K3 = 'cccccccccccc';
const values = (over = {}) => ({ frontWing: 40, rearWing: 15, diffOn: 100, diffOff: 60, frontSuspension: 41, rearSuspension: 30, frontAntiRollBar: 5, rearAntiRollBar: 1, frontHeight: 23, rearHeight: 45, brakePressure: 98, brakeBias: 57, tyreFront: 29.5, tyreRear: 20.5, frontCamber: -3.5, rearCamber: -2, frontToe: 0.05, rearToe: 0.2, engineBraking: 50, ballast: 6, ...over });
const stats = (over = {}) => ({ bestQ: 108209, medianQ: 109000, cleanLapsQ: 4, bestR: null, medianR: null, cleanLapsR: 0, raceLaps: 0, racePaceMs: null, avgRaceFuelKg: null, compounds: [16], trackTempMin: 23, trackTempMax: 26, weathers: [0], ...over });
const run = (over = {}) => ({ uid: 'uid-spa-q', sessionId: 1, startedAt: Date.UTC(2026, 9, 20, 18, 0), name: 'Short qualifying', sessionType: 5, isRace: false, grid: null, finish: 3, cleanLaps: 4, bestMs: 108209, medianMs: 109000, compounds: [16], brakeBias: 57, ...over });
const setup = (over = {}) => ({ key: K1, trackId: 10, values: values(), orphan: false, autoName: 'Spa · 20 Oct · Qualifying', name: 'Spa · 20 Oct · Qualifying', named: false, favorite: false, note: '', updatedAt: null, firstAt: 1, lastAt: Date.UTC(2026, 9, 20, 18, 0), sessions: [run()], stats: stats(), sheetOff: { q: 1, r: 1 }, vsSheet: { q: rows(), r: rows() }, ...over });
function rows() {
  return Object.keys(values()).filter((k) => !['frontCamber', 'rearCamber', 'frontToe', 'rearToe', 'engineBraking', 'ballast'].includes(k)).map((k) => ({ key: k, label: k, current: values()[k], target: String(values()[k]), ok: k !== 'frontWing', change: k === 'frontWing' ? 4 : 0 }));
}
const spa = (setups) => ({
  trackId: 10, track: 'Spa', circuit: 'Belgium', favorites: setups.filter((s) => s.favorite).length, lastAt: Date.UTC(2026, 9, 20, 18, 0),
  reference: { q: rows().map((r) => ({ key: r.key, label: r.label, target: r.target })), r: rows().map((r) => ({ key: r.key, label: r.label, target: r.target })), notes: 'lico hell' }, setups,
});
const silverstone = () => ({ trackId: 7, track: 'Silverstone', circuit: 'Great Britain', favorites: 0, lastAt: Date.UTC(2026, 9, 10), reference: null, setups: [setup({ key: K3, trackId: 7, name: 'Silverstone · 10 Oct · Race', autoName: 'Silverstone · 10 Oct · Race' })] });

function fakeApi(calls) {
  const status = { version: '0.1.0', mode: 'live', replay: null, recording: null, settings: { httpPort: 8080, udpPort: 20777, share: false, phoneVoice: false }, pairUrl: null, addresses: [], clients: 1, dataDir: 'C:/data', analyzing: [], backfill: null };
  const ok = async () => status;
  return {
    status: ok, setSettings: ok, record: ok, stopRecording: ok, replay: ok, live: ok, captures: async () => [], analyze: ok, deleteCapture: ok, deleteSession: ok, showCapture: ok, openReport: ok, openDataFolder: ok, openInBrowser: ok, speech: { start: ok, stop: ok }, on: (ev, fn) => { if (ev === 'status') calls.emitStatus = (s) => fn({ ...status, ...s }); return () => {}; },
    saveSetupNote: async (input) => { calls.saved.push(JSON.parse(JSON.stringify(input))); return true; }, // plain objects: the page's own prototypes differ from this file's
    backfillSetups: async () => { calls.backfills++; return { read: 3, skipped: 1 }; },
  };
}

// state.library is what /api/setups answers with; the fake fetch serves it, and anything else is empty.
async function openSetups(t, { library = { sheet: 'F1 26', tracks: [spa([setup({ key: K2, values: values({ frontWing: 44 }), name: 'Wing-heavy', named: true, favorite: true, lastAt: 5, sessions: [run({ uid: 'uid-spa-r', name: 'Race', sessionType: 15, isRace: true, grid: 6, finish: 3, startedAt: Date.UTC(2026, 9, 20, 19, 0) })], stats: stats({ racePaceMs: 111221, raceLaps: 12, bestR: 109978, cleanLapsR: 12, avgRaceFuelKg: 41.2 }) }), setup()]), silverstone()] }, debriefs = [{ id: 'deb1', uid: 'uid-spa-r', track: 'Spa', sessionName: 'Race', startedAt: Date.UTC(2026, 9, 20, 19, 0) }] } = {}) {
  const calls = { saved: [], backfills: 0, fetches: 0 };
  const app = open(t, { before: (w) => {
    w.undercut = fakeApi(calls);
    w.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/setups')) { calls.fetches++; return { ok: true, json: async () => state.library }; }
      if (u.includes('/api/debrief/older')) return { ok: true, json: async () => ({ sessions: [] }) };
      return { ok: true, json: async () => ({}) };
    };
  } });
  const state = { library };
  await new Promise((r) => setTimeout(r, 10));
  app.connect();
  app.send({ ...raceSnapshots()[200], debrief: { sessions: debriefs } });
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Setups')).click();
  await new Promise((r) => setTimeout(r, 30));
  const $$ = (sel) => [...doc.querySelectorAll(sel)];
  const text = (sel) => (doc.querySelector(sel) || {}).textContent || '';
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const type = (el, value) => { el.value = value; el.dispatchEvent(new app.window.Event('input', { bubbles: true })); };
  return { ...app, doc, $$, text, calls, state, settle, type };
}

test('setups: the tracks are listed most recent first with how many setups each has, and the first opens', async (t) => {
  const app = await openSetups(t);
  assert.deepStrictEqual(app.$$('.sl__track').map((b) => b.querySelector('.sl__track-name').textContent), ['Spa', 'Silverstone']);
  assert.deepStrictEqual(app.$$('.sl__track').map((b) => b.querySelector('.sl__track-count').textContent), ['2', '1']);
  assert.strictEqual(app.$$('.sl__track[aria-current="true"]').length, 1);
  assert.match(app.text('.sl__title'), /Spa/);
  assert.match(app.text('.sl__meta'), /Belgium/);
  assert.match(app.text('.sl__meta'), /2 setups/);
  assert.strictEqual(app.$$('.sl__row').length, 2);
  assert.deepStrictEqual(app.errors, []);
});

test('setups: a track with a favorite is marked in the list', async (t) => {
  const app = await openSetups(t);
  assert.ok(app.$$('.sl__track')[0].classList.contains('has-favorite'));
  assert.ok(!app.$$('.sl__track')[1].classList.contains('has-favorite'));
});

test('setups: picking another track shows its setups', async (t) => {
  const app = await openSetups(t);
  app.$$('.sl__track')[1].click();
  assert.match(app.text('.sl__title'), /Silverstone/);
  assert.strictEqual(app.$$('.sl__row').length, 1);
  assert.match(app.text('.sl__name'), /Silverstone · 10 Oct · Race/);
});

test('setups: each setup shows its numbers with the conditions beside them, and says plainly when a number is missing', async (t) => {
  const app = await openSetups(t);
  const rows = app.$$('.sl__row');
  const unnamed = rows.find((r) => r.querySelector('.sl__name').textContent === 'Spa · 20 Oct · Qualifying');
  const t1 = unnamed.textContent.replace(/\s+/g, ' ');
  assert.match(t1, /1:48\.209/);
  assert.match(t1, /23–26/);
  assert.match(t1, /Soft/);
  assert.match(t1, /1 of 14 differ/i);
  assert.match(t1, /Race pace[^]*not enough laps|Race pace[^]*–/i, 'no race laps: it does not invent a pace');
  const named = rows.find((r) => r.querySelector('.sl__name').textContent === 'Wing-heavy');
  const t2 = named.textContent.replace(/\s+/g, ' ');
  assert.match(t2, /1:51\.221/);
  assert.match(t2, /12 laps/);
  assert.match(t2, /not corrected for fuel/i);
});

test('setups: favorites are listed first and marked', async (t) => {
  const app = await openSetups(t);
  assert.deepStrictEqual(app.$$('.sl__name').map((n) => n.textContent), ['Wing-heavy', 'Spa · 20 Oct · Qualifying']);
  const star = (i) => app.$$('.sl__row')[i].querySelector('.sl__star');
  assert.strictEqual(star(0).getAttribute('aria-pressed'), 'true');
  assert.strictEqual(star(1).getAttribute('aria-pressed'), 'false');
  assert.ok(app.$$('.sl__row')[0].classList.contains('is-favorite'));
});

test('setups: starring a setup saves it with its values, and the list is read again', async (t) => {
  const app = await openSetups(t);
  const before = app.calls.fetches;
  app.$$('.sl__row')[1].querySelector('.sl__star').click();
  await app.settle();
  assert.deepStrictEqual(app.calls.saved.at(-1), { trackId: 10, key: K1, values: values(), favorite: true });
  assert.ok(app.calls.fetches > before, 'read again so the list is what the store holds');
});

test('setups: clicking a name lets you rename it; Enter saves it, Escape does not', async (t) => {
  const app = await openSetups(t);
  const row = () => app.$$('.sl__row')[1];
  row().querySelector('.sl__name').click();
  const input = row().querySelector('.sl__rename');
  assert.ok(input, 'an input in place of the name');
  assert.strictEqual(input.value, 'Spa · 20 Oct · Qualifying');
  assert.strictEqual(input.maxLength, 60);
  app.type(input, '  Low-wing quali ');
  input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await app.settle();
  assert.deepStrictEqual(app.calls.saved.at(-1), { trackId: 10, key: K1, values: values(), name: 'Low-wing quali' });
  const n = app.calls.saved.length;
  row().querySelector('.sl__name').click();
  const again = row().querySelector('.sl__rename');
  app.type(again, 'Something else');
  again.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await app.settle();
  assert.strictEqual(app.calls.saved.length, n, 'Escape saves nothing');
  assert.ok(!row().querySelector('.sl__rename'));
  assert.match(app.text('.sl__title'), /Spa/, 'Escape did not take you out of the place');
});

test('setups: an empty name puts the generated one back', async (t) => {
  const app = await openSetups(t);
  app.$$('.sl__row')[0].querySelector('.sl__name').click(); // the named, starred one
  const input = app.$$('.sl__row')[0].querySelector('.sl__rename');
  app.type(input, '   ');
  input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await app.settle();
  assert.strictEqual(app.calls.saved.at(-1).name, '');
});

test('setups: the note is saved when you leave the box, and a failed save says so instead of pretending', async (t) => {
  const app = await openSetups(t);
  app.$$('.sl__row')[1].querySelector('.sl__toggle').click();
  const box = app.$$('.sl__row')[1].querySelector('.sl__note');
  assert.strictEqual(box.maxLength, 500);
  app.type(box, 'loose at Eau Rouge');
  box.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await app.settle();
  assert.deepStrictEqual(app.calls.saved.at(-1), { trackId: 10, key: K1, values: values(), note: 'loose at Eau Rouge' });
  app.window.undercut.saveSetupNote = async () => { throw new Error("Error invoking remote method 'saveSetupNote': Error: setup note: a name is at most 60 characters"); };
  app.$$('.sl__row')[1].querySelector('.sl__star').click();
  await app.settle();
  assert.match(app.text('.sl__status'), /at most 60 characters/);
});

test('setups: Favorites only hides the rest, and the choice can be undone', async (t) => {
  const app = await openSetups(t);
  const filter = () => app.doc.querySelector('.sl__filter'); // the page is drawn again after each change
  filter().click();
  assert.strictEqual(filter().getAttribute('aria-pressed'), 'true');
  assert.strictEqual(app.$$('.sl__row').length, 1);
  assert.strictEqual(app.$$('.sl__track').length, 1, 'only tracks with a favorite');
  filter().click();
  assert.strictEqual(app.$$('.sl__row').length, 2);
});

test('setups: opening a setup shows its values against the sheet, green where right and red where off, with which way to go', async (t) => {
  const app = await openSetups(t);
  const row = app.$$('.sl__row')[1];
  assert.ok(!row.querySelector('.sl__detail') || row.querySelector('.sl__detail').hidden);
  row.querySelector('.sl__toggle').click();
  const cells = [...row.querySelectorAll('.sl__cell')];
  assert.ok(cells.length >= 14);
  const fw = cells.find((c) => c.querySelector('span').textContent === 'frontWing' || /front wing/i.test(c.querySelector('span').textContent));
  assert.ok(fw.classList.contains('is-off'), 'front wing is off against the sheet');
  assert.match(fw.textContent, /\+4/);
  assert.ok(cells.some((c) => c.classList.contains('is-ok')));
  assert.match(row.textContent, /Camber/i);
  assert.match(row.textContent, /Engine braking/i);
});

test('setups: each run lists the session, its result and laps, and links to the race when its debrief is there', async (t) => {
  const app = await openSetups(t);
  const named = app.$$('.sl__row')[0];
  named.querySelector('.sl__toggle').click();
  const r = named.querySelector('.sl__run');
  assert.match(r.textContent, /Race/);
  assert.match(r.textContent, /P6/);
  assert.match(r.textContent, /P3/);
  const open = r.querySelector('.sl__open');
  assert.ok(open && !open.disabled);
  let shown = null;
  // Caught on the way in, so the test does not also open Race analysis (which needs whole debriefs).
  app.window.addEventListener('undercut:show', (e) => { shown = e.detail; e.stopImmediatePropagation(); }, true);
  open.click();
  assert.strictEqual(shown, 'analysis');
  assert.strictEqual(app.window.RaceDesktop.analysisSession, 'deb1', 'Race analysis opens on that race');
  await app.settle(); // let the place that opened finish its own reads before the page is torn down
});

test('setups: a session whose debrief was removed keeps its stats and says so instead of a dead link', async (t) => {
  const app = await openSetups(t, { debriefs: [] });
  app.$$('.sl__row')[0].querySelector('.sl__toggle').click();
  const open = app.$$('.sl__row')[0].querySelector('.sl__open');
  assert.ok(open.disabled);
  assert.match(open.textContent + open.title, /removed/i);
});

test('setups: two ticked setups are compared side by side, with only the differing values marked', async (t) => {
  const app = await openSetups(t);
  assert.ok(!app.doc.querySelector('.sl__compare'));
  const pick = (i) => app.$$('.sl__pick')[i].click(); // the page is drawn again after each tick
  pick(0);
  assert.ok(!app.doc.querySelector('.sl__compare'), 'one is not a comparison');
  pick(1);
  const cmp = app.doc.querySelector('.sl__compare');
  assert.ok(cmp);
  const diffs = [...cmp.querySelectorAll('tr.is-diff')];
  assert.deepStrictEqual(diffs.map((r) => r.children[0].textContent), ['Front wing']);
  assert.match(diffs[0].textContent, /40/);
  assert.match(diffs[0].textContent, /44/);
  assert.ok(cmp.querySelectorAll('tr').length > 10, 'every value is listed, the differing ones marked');
  pick(1);
  assert.ok(!app.doc.querySelector('.sl__compare'));
});

test('setups: a third tick replaces the oldest rather than comparing three', async (t) => {
  const lib = { sheet: null, tracks: [spa([setup(), setup({ key: K2, values: values({ frontWing: 44 }) }), setup({ key: K3, values: values({ frontWing: 50 }) })])] };
  const app = await openSetups(t, { library: lib });
  for (const i of [0, 1, 2]) app.$$('.sl__pick')[i].click();
  assert.strictEqual(app.$$('.sl__pick:checked').length, 2);
  assert.ok(!app.$$('.sl__pick')[0].checked, 'the oldest tick was dropped');
});

test('setups: the sheet\'s own values for the track sit above the list, qualifying and race', async (t) => {
  const app = await openSetups(t);
  assert.ok(app.doc.querySelector('.sl__ref'));
  assert.match(app.text('.sl__ref'), /Sheet/i);
  assert.match(app.text('.sl__ref'), /lico hell/);
  app.$$('.sl__track')[1].click();
  assert.ok(!app.doc.querySelector('.sl__ref') || app.doc.querySelector('.sl__ref').hidden, 'no sheet entry for that track: no reference');
});

test('setups: with nothing yet it says how to fill the library, and the button reads your recordings and reports what it did', async (t) => {
  const app = await openSetups(t, { library: { sheet: null, tracks: [] } });
  assert.match(app.text('.sl'), /no setups yet/i);
  const btn = app.doc.querySelector('.sl__backfill');
  assert.ok(btn);
  btn.click();
  await app.settle();
  assert.strictEqual(app.calls.backfills, 1);
  assert.match(app.text('.sl__status'), /3 recordings/);
  assert.match(app.text('.sl__status'), /1 .*skipped|1 .*no longer/i);
});

test('setups: while recordings are being read the button is off and shows the progress', async (t) => {
  const app = await openSetups(t, { library: { sheet: null, tracks: [] } });
  const btn = () => app.doc.querySelector('.sl__backfill');
  assert.strictEqual(btn().disabled, false);
  app.calls.emitStatus({ backfill: { done: 2, total: 5 } });
  assert.strictEqual(btn().disabled, true);
  assert.match(btn().textContent, /2 of 5/);
  const before = app.calls.fetches;
  app.calls.emitStatus({ backfill: null });
  await app.settle();
  assert.strictEqual(btn().disabled, false);
  assert.ok(app.calls.fetches > before, 'when it finishes the library is read again');
});

test('setups: when the library cannot be read it says why rather than showing an empty page', async (t) => {
  const app = await openSetups(t, { library: { error: 'The setup library comes from the race store, which a replay does not use.' } });
  assert.match(app.text('.sl'), /race store/);
  assert.deepStrictEqual(app.errors, []);
});

test('setups: names and notes are only ever shown as text, never as markup', async (t) => {
  const evil = '<img src=x onerror=alert(1)>';
  const app = await openSetups(t, { library: { sheet: null, tracks: [spa([setup({ name: evil, named: true, note: evil })])] } });
  assert.strictEqual(app.$$('.sl__row img').length, 0);
  assert.strictEqual(app.text('.sl__name'), evil);
});

test('setups: arriving from a race opens its track and its setup, ready to read', async (t) => {
  const calls = { saved: [], backfills: 0, fetches: 0 };
  const app = open(t, { before: (w) => {
    w.undercut = fakeApi(calls);
    w.RaceDesktopFocus = null;
    w.fetch = async (url) => (String(url).includes('/api/setups') ? { ok: true, json: async () => ({ sheet: null, tracks: [spa([setup(), setup({ key: K2, values: values({ frontWing: 44 }), name: 'Wing-heavy' })]), silverstone()] }) } : { ok: true, json: async () => ({ sessions: [] }) });
  } });
  await new Promise((r) => setTimeout(r, 10));
  app.connect();
  app.send({ ...raceSnapshots()[200], debrief: { sessions: [] } });
  app.window.RaceDesktop.setupsFocus = { trackId: 7, key: K3 };
  [...app.window.document.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Setups')).click();
  await new Promise((r) => setTimeout(r, 30));
  assert.match(app.window.document.querySelector('.sl__title').textContent, /Silverstone/);
  assert.ok(!app.window.document.querySelector('.sl__detail').hidden, 'the setup is open');
  assert.strictEqual(app.window.RaceDesktop.setupsFocus, null, 'used once');
});

test('setups: a setup set in the garage that no clean lap was driven on says so, and every row says when it was last run', async (t) => {
  const none = setup({ key: K3, stats: stats({ bestQ: null, medianQ: null, cleanLapsQ: 0, compounds: [] }), sessions: [run({ cleanLaps: 0, bestMs: null })] });
  const app = await openSetups(t, { library: { sheet: null, tracks: [spa([setup(), none])] } });
  const rows = app.$$('.sl__row');
  assert.ok(!/No clean laps yet/i.test(rows[0].textContent));
  assert.match(rows[1].textContent, /No clean laps yet/i);
  assert.match(rows[0].textContent, /Last run/i);
});

// ---- the sheet's setups as the recommended defaults ----
const rec = (kind, over = {}) => ({
  key: `sheet-${kind}`, trackId: 10, recommended: true, kind, orphan: false, name: kind === 'q' ? 'Recommended · Qualifying' : 'Recommended · Race', autoName: 'x', named: true, favorite: false, note: '', updatedAt: null,
  firstAt: null, lastAt: null, sessions: [], values: values({ frontWing: kind === 'q' ? 30 : 42, brakeBias: 56, frontCamber: null, rearCamber: null, frontToe: null, rearToe: null, engineBraking: null, ballast: null }), valueText: { brakeBias: '56-57' },
  stats: stats({ bestQ: null, medianQ: null, cleanLapsQ: 0, compounds: [], trackTempMin: null, trackTempMax: null, weathers: [] }), sheetOff: null, vsSheet: null, ...over,
});

test('setups: the sheet\'s setups are the recommended defaults: first in the list, open, labelled, with nothing to rename or save', async (t) => {
  const app = await openSetups(t, { library: { sheet: 'F1 26', tracks: [spa([rec('q'), rec('r'), setup()])] } });
  const rows = app.$$('.sl__row');
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows.map((r) => r.classList.contains('is-recommended')), [true, true, false]);
  assert.match(rows[0].textContent, /Recommended default/i);
  assert.ok(!/not driven yet/i.test(rows[0].textContent), 'no explanatory line under the name');
  assert.ok(!rows[0].querySelector('.sl__star'), 'a default is not starred or renamed');
  assert.ok(!rows[0].querySelector('.sl__note'));
  assert.ok(!rows[0].querySelector('button.sl__name'));
  assert.strictEqual(rows[0].querySelector('.sl__name').textContent, 'Recommended · Qualifying');
  assert.ok(rows[2].querySelector('.sl__star'), 'your own setup still can be');
});

test('setups: a recommended default shows the sheet\'s values with a range as a range, and no values the sheet lacks', async (t) => {
  const app = await openSetups(t, { library: { sheet: 'F1 26', tracks: [spa([rec('q')])] } });
  const row = app.$$('.sl__row')[0];
  assert.ok(!row.querySelector('.sl__detail').hidden, 'its values are showing without opening it');
  const cell = (label) => [...row.querySelectorAll('.sl__cell')].find((c) => c.querySelector('span').textContent === label);
  assert.strictEqual(cell('Front wing').querySelector('b').textContent, '30');
  assert.strictEqual(cell('Brake bias (as run)').querySelector('b').textContent, '56-57');
  assert.strictEqual(cell('Front camber').querySelector('b').textContent, '–', 'the sheet has no camber: a dash, not a zero');
});

test('setups: a recommended default can be compared with one of your own', async (t) => {
  const app = await openSetups(t, { library: { sheet: 'F1 26', tracks: [spa([rec('q'), setup()])] } });
  app.$$('.sl__pick')[0].click();
  app.$$('.sl__pick')[1].click();
  const diffs = [...app.doc.querySelectorAll('.sl__compare tr.is-diff')].map((r) => r.children[0].textContent);
  assert.ok(diffs.includes('Front wing'), diffs.join(','));
  assert.deepStrictEqual(app.errors, []);
});

test('setups: a track you have not driven is listed from the sheet, after the ones you have', async (t) => {
  const undriven = { trackId: 0, track: 'Melbourne', circuit: 'Australia', favorites: 0, lastAt: 0, reference: null, setups: [rec('q', { trackId: 0 })] };
  const app = await openSetups(t, { library: { sheet: 'F1 26', tracks: [spa([rec('q'), setup()]), undriven] } });
  assert.deepStrictEqual(app.$$('.sl__track-name').map((n) => n.textContent), ['Spa', 'Melbourne']);
  app.$$('.sl__track')[1].click();
  assert.match(app.text('.sl__title'), /Melbourne/);
  assert.match(app.text('.sl__meta'), /0 sessions|no sessions/i);
});

test('setups: Home counts only your own setups, not the sheet\'s defaults', async (t) => {
  const app = await openSetups(t, { library: { sheet: 'F1 26', tracks: [spa([rec('q'), rec('r'), setup()])] } });
  app.$$('.place__back')[0].click();
  await app.settle();
  const state = [...app.doc.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Setups')).querySelector('.home__state').textContent;
  assert.match(state, /^1 setup\b/);
});
