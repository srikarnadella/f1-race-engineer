const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');

// Race analysis, Strategy (public/analysis.js, roadmap R4): every call graded as the calls audit grades
// it (/api/debrief/audit, the same grading as `npm run backtest`), and each of your stops priced against
// every other car's stop in the same race.
function fakeApi() {
  const status = { version: '0.1.0', mode: 'live', replay: null, recording: null, settings: { httpPort: 8080, udpPort: 20777, share: false, phoneVoice: false }, pairUrl: null, addresses: [], clients: 1, dataDir: 'C:/data', analyzing: [] };
  const ok = async () => status;
  return { status: ok, setSettings: ok, record: ok, stopRecording: ok, replay: ok, live: ok, captures: async () => [], analyze: ok, deleteCapture: ok, deleteSession: ok, showCapture: ok, openReport: ok, openDataFolder: ok, openInBrowser: ok, speech: { start: ok, stop: ok }, on: () => () => {} };
}

// Ten laps; the stop is lap 5 (medium to hard): P8 before it, P11 after the out-lap.
const lap = (n, over = {}) => ({ lap: n, timeMs: 80000, s1: 25000, s2: 30000, s3: 25000, invalid: false, pit: false, neutralised: false, position: n < 5 ? 8 : 11, compound: n <= 5 ? 17 : 18, tyreAge: n, wearAvg: 10, fuelKg: 50, batteryPct: 60, ...over });
const race = {
  id: 'r1', live: false, startedAt: Date.UTC(2026, 9, 17), sessionType: 15, sessionName: 'Race', isRace: true, track: 'Barcelona', totalLaps: 10,
  grid: 9, finish: 7, positionsGained: 2, official: true, points: 6, fieldBestSectors: [], bestSectors: [], positionChart: null,
  bestLap: { lap: 3, ms: 80000 }, theoreticalBestMs: null, medianPaceMs: 80000, consistencyMs: 100, cleanLaps: 8, fieldBestMs: 79000,
  fastestLap: null, pitStops: 1, penalties: [], safetyCars: 0, stints: [], comparable: [], field: [],
  laps: [...Array(10)].map((_, i) => lap(i + 1, i + 1 === 5 ? { pit: true, position: 12 } : {})),
};
const quali = { ...race, id: 'q1', sessionType: 8, sessionName: 'Qualifying', isRace: false };
const AUDIT = {
  summary: { calls: 4, graded: 3, right: 2, wrong: 1, unclear: 0 },
  calls: [
    { lapNum: 3, action: 'PUSH', kind: 'ok', verdict: 'right', why: 'Gained 1.2s on NORRIS' },
    { lapNum: 5, action: 'BOX', kind: 'pit', verdict: 'rule', why: 'In the pits' },
    { lapNum: 9, action: 'HOLD', kind: 'tyres', verdict: 'wrong', why: 'No cliff in the next 3 laps' },
    { lapNum: 10, action: 'PUSH', kind: 'undercut', verdict: 'right', why: 'Undercut on PIASTRI worked' },
  ],
  // Yours 21.5 s; the others' green-flag stops 22.0 and 22.6 s (typical 22.3 s); one under the safety car.
  stops: [
    { carIndex: 11, isPlayer: true, lapNum: 5, green: true, costMs: 21500 },
    { carIndex: 1, isPlayer: false, lapNum: 7, green: true, costMs: 22000 },
    { carIndex: 2, isPlayer: false, lapNum: 8, green: true, costMs: 22600 },
    { carIndex: 3, isPlayer: false, lapNum: 9, green: false, costMs: 9000 },
  ],
};

async function openStrategy(t, sessions = [race]) {
  const app = open(t, {
    before: (w) => {
      w.undercut = fakeApi();
      w.fetch = async (url) => (String(url).includes('/api/debrief/audit') ? { ok: true, json: async () => AUDIT } : { ok: false, json: async () => ({}) });
    },
  });
  await new Promise((r) => setTimeout(r, 10));
  app.connect();
  app.send({ ...raceSnapshots()[200], debrief: { sessions } });
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Race analysis')).click();
  const tab = [...doc.querySelectorAll('.ana__view')].find((b) => b.textContent === 'Strategy');
  if (tab) tab.click();
  await new Promise((r) => setTimeout(r, 20));
  const $$ = (sel) => [...doc.querySelectorAll(sel)];
  const text = (sel) => (doc.querySelector(sel) || {}).textContent || '';
  return { ...app, doc, $$, text, tab };
}

test('strategy: the verdict on the calls in one line, rule-following not counted', async (t) => {
  const app = await openStrategy(t);
  assert.match(app.text('.str__verdict'), /2 of 3 graded calls were right/);
  assert.match(app.text('.str__verdict'), /1 wrong/);
  assert.deepStrictEqual(app.errors, []);
});

test('strategy: each of your stops, what it cost against the others\' stops, and where you rejoined', async (t) => {
  const app = await openStrategy(t);
  const stops = app.$$('.str__stop');
  assert.strictEqual(stops.length, 1);
  const row = stops[0].textContent;
  assert.match(row, /Lap 5/);
  assert.match(row, /Medium → Hard/);
  assert.match(row, /21\.5 s/);
  assert.match(row, /0\.8 s quicker than the others' typical 22\.3 s/);
  assert.match(row, /P8 → P11/);
  // Every green-flag stop in the race on one axis, yours marked; the safety-car one isn't comparable.
  assert.strictEqual(app.$$('.str__dot').length, 3);
  assert.strictEqual(app.$$('.str__dot.is-you').length, 1);
});

test('strategy: every call in lap order, filterable by its grade', async (t) => {
  const app = await openStrategy(t);
  assert.deepStrictEqual(app.$$('.str__call').map((c) => c.dataset.lap), ['3', '5', '9', '10']);
  app.$$('.str__filter').find((b) => b.textContent.startsWith('Wrong')).click();
  const shown = app.$$('.str__call');
  assert.strictEqual(shown.length, 1);
  assert.match(shown[0].textContent, /HOLD.*No cliff in the next 3 laps/);
});

test('strategy: only races have calls to review; qualifying has no Strategy view', async (t) => {
  const app = await openStrategy(t, [quali]);
  assert.strictEqual(app.tab, undefined);
  assert.deepStrictEqual(app.errors, []);
});

test('strategy: a race saved before calls were kept with it says so, and still shows the stops and rejoins', async (t) => {
  const app = open(t, {
    before: (w) => {
      w.undercut = fakeApi();
      w.fetch = async () => ({ ok: true, json: async () => ({ calls: [], summary: { calls: 0, graded: 0, right: 0, wrong: 0, unclear: 0 }, stops: [] }) });
    },
  });
  await new Promise((r) => setTimeout(r, 10));
  app.connect();
  app.send({ ...raceSnapshots()[200], debrief: { sessions: [race] } });
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Race analysis')).click();
  [...doc.querySelectorAll('.ana__view')].find((b) => b.textContent === 'Strategy').click();
  await new Promise((r) => setTimeout(r, 20));
  assert.match(doc.querySelector('.str__verdict').textContent, /saved before/);
  assert.doesNotMatch(doc.querySelector('.str__verdict').textContent, /followed the rules/);
  const stop = doc.querySelector('.str__stop').textContent;
  assert.match(stop, /P8 → P11/);
  assert.match(stop, /saved before/);
  assert.doesNotMatch(doc.querySelector(".str").textContent, /null|undefined/);
});
