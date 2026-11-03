const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');

// Race analysis, Head to head (public/analysis.js): you against any car, lap by lap and slice by
// slice of the lap, from /api/debrief/field (every car's mini-sector splits; their sum is the lap).
function fakeApi() {
  const status = { version: '0.1.0', mode: 'live', replay: null, recording: null, settings: { httpPort: 8080, udpPort: 20777, share: false, phoneVoice: false }, pairUrl: null, addresses: [], clients: 1, dataDir: 'C:/data', analyzing: [] };
  const ok = async () => status;
  return { status: ok, setSettings: ok, record: ok, stopRecording: ok, replay: ok, live: ok, captures: async () => [], analyze: ok, deleteCapture: ok, deleteSession: ok, showCapture: ok, openReport: ok, openDataFolder: ok, openInBrowser: ok, speech: { start: ok, stop: ok }, on: () => () => {} };
}

// A 5 km lap in five 1 km slices of 16 s. You lose 0.2 s in the second slice every lap;
// VERSTAPPEN loses 0.1 s in the fourth. So he is 0.1 s a lap faster, and you know where.
const laps = (from, to, bump) => Array.from({ length: to - from + 1 }, (_, i) => {
  const splits = [16000, 16000, 16000, 16000, 16000].map((v, k) => v + (bump[k] || 0));
  return { lap: from + i, ms: splits.reduce((a, b) => a + b, 0), splits };
});
const FIELD = {
  trackLength: 5000,
  cars: [
    { carIndex: 3, name: 'LECLERC', position: 8, isPlayer: false, stops: 1, compounds: [16, 17], bestMs: 80250, laps: laps(2, 3, { 0: 50, 1: 50, 2: 50, 3: 50, 4: 50 }) },
    { carIndex: 11, name: 'YOU', position: 7, isPlayer: true, stops: 1, compounds: [17, 18], bestMs: 80200, laps: laps(2, 5, { 1: 200 }) },
    { carIndex: 1, name: 'VERSTAPPEN', position: 6, isPlayer: false, stops: 2, compounds: [17, 18, 17], bestMs: 80100, laps: laps(2, 6, { 3: 100 }) },
  ],
};
const session = { id: 'h1', live: false, startedAt: Date.UTC(2026, 9, 17), sessionType: 15, sessionName: 'Race', isRace: true, track: 'Barcelona', totalLaps: 12, grid: 10, finish: 7, positionsGained: 3, official: true, points: 6, fieldBestSectors: [], bestSectors: [], positionChart: null, bestLap: { lap: 3, ms: 80200 }, theoreticalBestMs: null, medianPaceMs: 80200, consistencyMs: 100, cleanLaps: 4, fieldBestMs: 80100, fastestLap: null, pitStops: 1, penalties: [], safetyCars: 0, stints: [], laps: [], comparable: [], field: [] };

async function openH2H(t, reply = () => FIELD) {
  const app = open(t, {
    before: (w) => {
      w.undercut = fakeApi();
      w.fetch = async (url) => {
        const u = new URL(String(url), 'http://x');
        return u.pathname.endsWith('/api/debrief/field') ? { ok: true, json: async () => reply(u) } : { ok: false, json: async () => ({}) };
      };
    },
  });
  await new Promise((r) => setTimeout(r, 10));
  app.connect();
  app.send({ ...raceSnapshots()[200], debrief: { sessions: [session] } });
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Race analysis')).click();
  [...doc.querySelectorAll('.ana__view')].find((b) => b.textContent === 'Head to head').click();
  await new Promise((r) => setTimeout(r, 20));
  const $$ = (sel) => [...doc.querySelectorAll(sel)];
  const text = (sel) => (doc.querySelector(sel) || {}).textContent || '';
  return { ...app, doc, $$, text };
}

test('head to head: opens on the car that finished just ahead, any other car one pick away', async (t) => {
  const app = await openH2H(t);
  const pick = app.doc.querySelector('.h2h__pick');
  assert.deepStrictEqual([...pick.options].map((o) => o.textContent), ['P6 VERSTAPPEN', 'P8 LECLERC']);
  assert.strictEqual(pick.value, '1');
  assert.match(app.text('.h2h__verdict'), /VERSTAPPEN was 0\.100 s a lap faster than you over 4 laps/);
  assert.deepStrictEqual(app.errors, []);
});

test('head to head: lap by lap, only the laps you both completed', async (t) => {
  const app = await openH2H(t);
  const bars = app.$$('.h2h__lap');
  assert.deepStrictEqual(bars.map((b) => [b.dataset.lap, b.dataset.diff]), [['2', '100'], ['3', '100'], ['4', '100'], ['5', '100']]);
});

test('head to head: where on the lap the time goes, biggest loss first', async (t) => {
  const app = await openH2H(t);
  const worst = app.$$('.h2h__worst li').map((li) => li.textContent);
  assert.match(worst[0], /1\.0–2\.0 km.*lose 0\.20 s/);
  assert.match(worst[worst.length - 1], /3\.0–4\.0 km.*gain 0\.10 s/);
  assert.strictEqual(app.$$('.h2h__slice').length, 5);
});

test('head to head: picking another car compares with that one', async (t) => {
  const app = await openH2H(t);
  const pick = app.doc.querySelector('.h2h__pick');
  pick.value = '3';
  pick.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.match(app.text('.h2h__verdict'), /LECLERC was 0\.050 s a lap slower than you over 2 laps/);
});

test('head to head: says so when the session has no lap timing to compare', async (t) => {
  const app = await openH2H(t, () => ({ error: 'No such session' }));
  assert.match(app.text('.h2h'), /No such session/);
  assert.deepStrictEqual(app.errors, []);
});
