const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');

// Race analysis, Pace (public/analysis.js): the race lap by lap from the saved session summary.
// The fixture's laps are built so every expected number can be worked out by hand.
function fakeApi() {
  const status = { version: '0.1.0', mode: 'live', replay: null, recording: null, settings: { httpPort: 8080, udpPort: 20777, share: false, phoneVoice: false }, pairUrl: null, addresses: [], clients: 1, dataDir: 'C:/data', analyzing: [] };
  const ok = async () => status;
  return { status: ok, setSettings: ok, record: ok, stopRecording: ok, replay: ok, live: ok, captures: async () => [], analyze: ok, deleteCapture: ok, deleteSession: ok, showCapture: ok, openReport: ok, openDataFolder: ok, openInBrowser: ok, speech: { start: ok, stop: ok }, on: () => () => {} };
}

// 12 laps. Mediums laps 1-5, the stop on lap 5: 80.0 s + 0.100 s per lap of tyre age, wear 3% a lap.
// Hards laps 6-12: 79.5 s + 0.050 s per lap of age, wear 2% a lap; laps 8-9 under the safety car.
// Lap 1 is the standing start (2 s slower), so degradation is fitted from lap 2.
function laps() {
  const out = [];
  for (let n = 1; n <= 12; n++) {
    const hard = n >= 6;
    const age = hard ? n - 5 : n;
    let timeMs = hard ? 79500 + 50 * age : 80000 + 100 * age;
    if (n === 1) timeMs += 2000;
    if (n === 5) timeMs += 20000; // the in-lap
    if (n === 8 || n === 9) timeMs += 25000;
    out.push({ lap: n, timeMs, s1: 25000 + n, s2: 30000 + n, s3: timeMs - 55000 - 2 * n, invalid: false, pit: n === 5, neutralised: n === 8 || n === 9, position: 10, compound: hard ? 18 : 17, tyreAge: age, wearAvg: hard ? 2 * age : 3 * age, fuelKg: 40 - 1.5 * n, batteryPct: 60 });
  }
  return out;
}
const session = {
  id: 'p1', live: false, startedAt: Date.UTC(2026, 9, 17), sessionType: 15, sessionName: 'Race', isRace: true, track: 'Barcelona', totalLaps: 12, grid: 10, finish: 8, positionsGained: 2, official: true, points: 4,
  fieldBestSectors: [], bestSectors: [25002, 30002, 24596], positionChart: null, bestLap: { lap: 6, ms: 79550 }, theoreticalBestMs: 79600, medianPaceMs: 79800, consistencyMs: 250, cleanLaps: 9, fieldBestMs: 79000,
  fastestLap: null, pitStops: 1, penalties: [], safetyCars: 1, stints: [{ compound: 17, fromLap: 1, toLap: 5, laps: 5 }, { compound: 18, fromLap: 6, toLap: 12, laps: 7 }], laps: laps(), comparable: [], field: [],
};

async function openPace(t) {
  const app = open(t, { before: (w) => { w.undercut = fakeApi(); } });
  await new Promise((r) => setTimeout(r, 10));
  app.connect();
  app.send({ ...raceSnapshots()[200], debrief: { sessions: [session] } });
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Race analysis')).click();
  [...doc.querySelectorAll('.ana__view')].find((b) => b.textContent === 'Pace').click();
  const $$ = (sel) => [...doc.querySelectorAll(sel)];
  return { ...app, doc, $$ };
}

test('pace: every lap on the chart, the ones that don\'t count for pace marked as what they were', async (t) => {
  const app = await openPace(t);
  const dots = app.$$('.pace__lap');
  assert.strictEqual(dots.length, 12);
  const kind = (n) => dots.find((d) => d.dataset.lap === String(n)).dataset.kind;
  assert.deepStrictEqual([kind(1), kind(2), kind(5), kind(8), kind(6)], ['start', 'clean', 'pit', 'sc', 'best']);
  assert.deepStrictEqual(app.errors, []);
});

test('pace: each stint\'s pace, degradation and wear, fitted on its clean laps', async (t) => {
  const app = await openPace(t);
  const rows = app.$$('.pace__stint').map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent));
  assert.strictEqual(rows.length, 2);
  // Mediums: clean laps 2-4 (1 is the start, 5 the in-lap) at 80.2, 80.3, 80.4.
  assert.deepStrictEqual(rows[0].slice(0, 6), ['Medium', '1–5', '1:20.300', '1:20.200', '+0.100 s/lap', '3.0%/lap']);
  // Hards: laps 6, 7, 10, 11, 12 (8-9 under the safety car).
  assert.deepStrictEqual(rows[1].slice(0, 6), ['Hard', '6–12', '1:19.750', '1:19.550', '+0.050 s/lap', '2.0%/lap']);
});

test('pace: the lap table sorts by any column and downloads as CSV', async (t) => {
  const app = await openPace(t);
  const firstLap = () => app.doc.querySelector('.pace__table tbody tr td').textContent;
  assert.strictEqual(firstLap(), '1');
  app.$$('.pace__table th button').find((b) => b.textContent.startsWith('Time')).click();
  assert.strictEqual(firstLap(), '6', 'fastest first');
  app.$$('.pace__table th button').find((b) => b.textContent.startsWith('Time')).click();
  assert.strictEqual(firstLap(), '9', 'then slowest first (lap 9, under the safety car)');
  assert.ok(app.$$('.pace button').some((b) => /CSV/.test(b.textContent)));
});
