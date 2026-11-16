const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');

// The Setups library and the garage naming on a phone or tablet (a browser: no desktop app around it). It reads the library from
// the bridge and saves names, stars and notes over HTTP, but only with the key the pairing QR code carries.
const KEY = 'c'.repeat(32);
const K1 = 'aaaaaaaaaaaa';
const base = () => raceSnapshots().find((s) => s.player && s.analysis);
const values = { frontWing: 40, rearWing: 15, diffOn: 100, diffOff: 60, frontSuspension: 41, rearSuspension: 30, frontAntiRollBar: 5, rearAntiRollBar: 1, frontHeight: 23, rearHeight: 45, brakePressure: 98, brakeBias: 57, tyreFront: 29.5, tyreRear: 20.5, frontCamber: null, rearCamber: null, frontToe: null, rearToe: null, engineBraking: null, ballast: null };
const stats = { bestQ: 108209, medianQ: 109000, cleanLapsQ: 4, bestR: null, medianR: null, cleanLapsR: 0, raceLaps: 0, racePaceMs: null, avgRaceFuelKg: null, compounds: [16], trackTempMin: 23, trackTempMax: 26, weathers: [0] };
const mine = { key: K1, trackId: 10, orphan: false, name: 'Spa · 20 Oct · Qualifying', named: false, favorite: false, note: '', values, stats, sheetOff: null, vsSheet: null, firstAt: 1, lastAt: 5, sessions: [{ uid: 'u1', sessionId: 1, startedAt: 5, name: 'Qualifying', sessionType: 5, isRace: false, grid: null, finish: 3, cleanLaps: 4, bestMs: 108209, medianMs: 109000, compounds: [16], brakeBias: 57 }] };
const library = { sheet: null, tracks: [{ trackId: 10, track: 'Spa', circuit: 'Belgium', favorites: 0, lastAt: 5, reference: null, setups: [mine] }] };
const garage = (over = {}) => ({ available: false, track: 'Spa', circuit: null, kind: 'q', editable: true, inGarage: true, rows: [], off: 0, notes: null, source: null, history: null, current: { key: K1, trackId: 10, values, name: '', favorite: false }, ...over });

function phone(t, { key = KEY, extra = {}, fetchImpl } = {}) {
  const calls = [];
  const app = open(t, {
    url: `http://192.168.1.23:8080/${key ? `?k=${key}` : ''}`,
    storage: { 'raceEngineer.setupAuto': false },
    before: (w) => {
      w.fetch = fetchImpl || (async (url, init) => {
        const u = String(url);
        if (init && init.method === 'POST') { calls.push({ url: u, headers: init.headers, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
        if (u.includes('/api/setups')) return { ok: true, json: async () => library };
        return { ok: true, json: async () => ({}) };
      });
      Object.assign(w, extra);
    },
  });
  return { app, calls };
}
const tabs = (app) => [...app.window.document.querySelectorAll('.tab')].map((b) => b.lastChild.textContent);
const go = (app, label) => [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === label).click();
const settle = () => new Promise((r) => setTimeout(r, 30));
const inGarage = (app) => { app.connect(); app.send({ ...base(), connected: true, setup: garage() }); };

test('pairing: the key in the address is kept for this device and taken out of the address bar', (t) => {
  const { app } = phone(t);
  assert.strictEqual(app.window.localStorage.getItem('raceEngineer.pairKey'), KEY);
  assert.strictEqual(app.window.location.search, '', 'not left in the address (or in a screenshot, or a shared link)');
});

test('pairing: something that is not a key in the address is ignored', (t) => {
  const { app } = phone(t, { key: 'not-a-key' });
  assert.strictEqual(app.window.localStorage.getItem('raceEngineer.pairKey'), null);
});

test('saving: a paired phone sends the note with the key in a header, and a refusal comes back as its reason', async (t) => {
  const { app, calls } = phone(t);
  await app.window.RaceWidgets.saveSetupNote({ trackId: 10, key: K1, favorite: true });
  assert.strictEqual(calls[0].url, '/api/setups/note');
  assert.strictEqual(calls[0].headers['X-Undercut-Key'], KEY);
  assert.deepStrictEqual(calls[0].body, { trackId: 10, key: K1, favorite: true });
  app.window.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'a name is at most 60 characters' }) });
  await assert.rejects(() => app.window.RaceWidgets.saveSetupNote({ trackId: 10, key: K1, name: 'x' }), /at most 60 characters/);
});

test('saving: a device that never scanned the code cannot save and says how to', async (t) => {
  const { app, calls } = phone(t, { key: null });
  assert.strictEqual(app.window.RaceWidgets.canSaveSetups(), false);
  await assert.rejects(() => app.window.RaceWidgets.saveSetupNote({ trackId: 10, key: K1, favorite: true }), /scan the QR code/i);
  assert.deepStrictEqual(calls, []);
});

test('saving: in the desktop app the app saves, and no key or request is needed', async (t) => {
  const saved = [];
  const { app, calls } = phone(t, { key: null });
  app.window.undercut = { saveSetupNote: async (i) => { saved.push(i); return true; } }; // checked when it is used, so the app's own bridge to the PC is enough
  assert.strictEqual(app.window.RaceWidgets.canSaveSetups(), true);
  await app.window.RaceWidgets.saveSetupNote({ trackId: 10, key: K1, favorite: true });
  assert.strictEqual(saved.length, 1);
  assert.deepStrictEqual(calls, []);
});

test('phone: the Setups library is a screen of its own in the garage group, listed only in the garage', (t) => {
  const { app } = phone(t);
  app.connect();
  app.send({ ...base(), connected: true, setup: garage({ inGarage: false }) });
  assert.ok(!tabs(app).includes('Setups'));
  app.send({ ...base(), connected: true, setup: garage() });
  assert.ok(tabs(app).includes('Setups'));
  assert.deepStrictEqual(tabs(app).filter((x) => ['Setup', 'Setups', 'Briefing'].includes(x)).sort(), ['Briefing', 'Setup', 'Setups']);
});

test('phone: the library shows the tracks and setups, and a paired phone can star one', async (t) => {
  const { app, calls } = phone(t);
  inGarage(app);
  go(app, 'Setups');
  await settle();
  const doc = app.window.document;
  assert.match(doc.querySelector('.sl__title').textContent, /Spa/);
  assert.strictEqual(doc.querySelectorAll('.sl__row').length, 1);
  doc.querySelector('.sl__star').click();
  await settle();
  assert.deepStrictEqual(calls.at(-1).body, { trackId: 10, key: K1, values, favorite: true });
  assert.deepStrictEqual(app.errors, []);
});

test('phone: what only the PC can do is not offered: reading recordings, opening Race analysis', async (t) => {
  const lib = JSON.parse(JSON.stringify(library));
  const { app } = phone(t, { fetchImpl: async (u) => ({ ok: true, json: async () => (String(u).includes('/api/setups') ? lib : {}) }) });
  inGarage(app);
  go(app, 'Setups');
  await settle();
  const doc = app.window.document;
  assert.strictEqual(doc.querySelector('.sl__backfill'), null);
  doc.querySelector('.sl__toggle').click();
  assert.strictEqual(doc.querySelector('.sl__open'), null);
});

test('phone: a device that is not paired can look but not change anything, and is told how to pair', async (t) => {
  const { app } = phone(t, { key: null });
  inGarage(app);
  go(app, 'Setups');
  await settle();
  const doc = app.window.document;
  assert.strictEqual(doc.querySelectorAll('.sl__row').length, 1, 'it can look');
  assert.strictEqual(doc.querySelector('.sl__star'), null);
  assert.ok(!doc.querySelector('button.sl__name'));
  doc.querySelector('.sl__toggle').click();
  assert.strictEqual(doc.querySelector('.sl__note'), null);
  assert.match(doc.querySelector('.sl').textContent, /scan the QR code/i);
});

test('phone: the garage Setup screen can name and star the setup on the car, when paired, and not when not', async (t) => {
  const { app, calls } = phone(t);
  inGarage(app);
  go(app, 'Setup');
  const doc = app.window.document;
  assert.ok(!doc.querySelector('.w-su__mine').hidden);
  doc.querySelector('.w-su__star').click();
  await settle();
  assert.deepStrictEqual(calls.at(-1).body, { trackId: 10, key: K1, values, favorite: true });
  const other = phone(t, { key: null });
  inGarage(other.app);
  go(other.app, 'Setup');
  assert.ok(other.app.window.document.querySelector('.w-su__mine').hidden);
});
