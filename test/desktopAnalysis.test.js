const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');

// Race analysis (public/analysis.js): the desktop app's in-depth place for
// saved sessions. It reads the same session summaries the Debrief gets
// (src/engine/debrief.js summarize), so every number here is one of those.
function fakeApi() {
  const status = { version: '0.1.0', mode: 'live', replay: null, recording: null, settings: { httpPort: 8080, udpPort: 20777, share: false, phoneVoice: false }, pairUrl: null, addresses: [], clients: 1, dataDir: 'C:/data', analyzing: [] };
  const ok = async () => status;
  return { status: ok, setSettings: ok, record: ok, stopRecording: ok, replay: ok, live: ok, captures: async () => [], analyze: ok, deleteCapture: ok, deleteSession: ok, showCapture: ok, openReport: ok, openDataFolder: ok, openInBrowser: ok, speech: { start: ok, stop: ok }, on: () => () => {} };
}

const lap = (n, over = {}) => ({ lap: n, timeMs: 80000 + n * 10, s1: 25000, s2: 30000, s3: 25000, invalid: false, pit: false, neutralised: false, position: 10, compound: n <= 5 ? 17 : 18, tyreAge: n <= 5 ? n : n - 5, wearAvg: 10, fuelKg: 50, batteryPct: 60, ...over });
// A 12-lap Barcelona race: P15 to P7, a 5 s penalty on lap 3, a stop on lap 5 (medium to hard),
// the safety car on laps 8-9, the best lap on lap 10.
const barcelona = {
  id: 'bcn1', live: false, startedAt: Date.UTC(2026, 9, 17, 19, 30), sessionType: 15, sessionName: 'Race', isRace: true, track: 'Barcelona', totalLaps: 12,
  grid: 15, finish: 7, positionsGained: 8, official: true, points: 6,
  fieldBestSectors: [null, null, null], bestSectors: [25000, 30000, 25000],
  positionChart: { lapStart: 0, maxPos: 3, cars: [{ name: 'YOU', isPlayer: true, positions: [3, 2, 2, 1] }, { name: 'RIVAL', isPlayer: false, positions: [1, 1, 1, 2] }, { name: 'OTHER', isPlayer: false, positions: [2, 3, 3, 3] }] },
  bestLap: { lap: 10, ms: 78123 }, theoreticalBestMs: 77900, medianPaceMs: 80050, consistencyMs: 350, cleanLaps: 9, fieldBestMs: 77500,
  fastestLap: { name: 'RIVAL', ms: 77500, isPlayer: false }, pitStops: 1, penalties: [{ what: '5 s time penalty', lap: 3, timeS: 5 }], safetyCars: 1,
  stints: [{ compound: 17, fromLap: 1, toLap: 5, laps: 5 }, { compound: 18, fromLap: 6, toLap: 12, laps: 7 }],
  laps: [...Array(12)].map((_, i) => lap(i + 1, { ...(i + 1 === 5 ? { pit: true } : {}), ...(i + 1 === 8 || i + 1 === 9 ? { neutralised: true } : {}), ...(i + 1 === 10 ? { timeMs: 78123 } : {}) })),
  comparable: [2, 3, 4], field: [{ name: 'RIVAL', position: 1, bestMs: 77500, stops: 1, compounds: [17, 18], isPlayer: false, status: 3 }, { name: 'YOU', position: 7, bestMs: 78123, stops: 1, compounds: [17, 18], isPlayer: true, status: 3 }],
};
const spa = {
  ...barcelona, id: 'spa1', startedAt: Date.UTC(2026, 9, 20, 18, 0), sessionType: 8, sessionName: 'Qualifying 3', isRace: false, track: 'Spa', grid: null, finish: 3, positionsGained: null, official: false, points: null,
  pitStops: null, penalties: [], safetyCars: 0, stints: [{ compound: 16, fromLap: 1, toLap: 3, laps: 3 }], laps: [lap(1, { compound: 16 }), lap(2, { compound: 16 }), lap(3, { compound: 16 })], bestLap: { lap: 2, ms: 105400 }, positionChart: null,
};

async function openAnalysis(t, sessions = [barcelona, spa]) {
  const app = open(t, { before: (w) => { w.undercut = fakeApi(); } });
  await new Promise((r) => setTimeout(r, 10));
  app.connect();
  app.send({ ...raceSnapshots()[200], debrief: { sessions } });
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Race analysis')).click();
  const $$ = (sel) => [...doc.querySelectorAll(sel)];
  const text = (sel) => (doc.querySelector(sel) || {}).textContent || '';
  return { ...app, doc, $$, text };
}

test('analysis: every saved session is listed, and the newest opens', async (t) => {
  const app = await openAnalysis(t);
  assert.deepStrictEqual(app.$$('.ana__session').map((b) => b.querySelector('.ana__session-name').textContent), ['Barcelona · Race', 'Spa · Qualifying 3']);
  assert.strictEqual(app.$$('.ana__session[aria-current="true"]').length, 1);
  assert.match(app.text('.ana__session[aria-current="true"]'), /Barcelona/);
  assert.match(app.text('.ana__title'), /Barcelona/);
  assert.deepStrictEqual(app.errors, []);
});

test('analysis: the overview is the session\'s own numbers: result, best lap, stints in proportion', async (t) => {
  const app = await openAnalysis(t);
  assert.match(app.text('.ana__result'), /P7/);
  assert.match(app.text('.ana__result'), /from P15/);
  assert.match(app.text('.ana__result'), /\+8/);
  const stat = (label) => app.$$('.ana__stat').find((s) => s.querySelector('.ana__stat-label').textContent === label);
  assert.match(stat('Best lap').textContent, /1:18\.123/);
  assert.match(stat('Best lap').textContent, /lap 10/);
  assert.match(stat('Stops').textContent, /1/);
  const stints = app.$$('.ana__stint');
  assert.deepStrictEqual(stints.map((s) => s.style.flexGrow), ['5', '7'], 'each stint as long as its laps');
  assert.match(stints[0].textContent, /Medium/);
  assert.match(stints[1].textContent, /Hard/);
  assert.match(stints[1].textContent, /6.12/);
});

test('analysis: key moments in lap order: the start, the penalty, the stop, the safety car, the best lap', async (t) => {
  const app = await openAnalysis(t);
  const moments = app.$$('.ana__moment').map((m) => m.textContent);
  const find = (re) => moments.findIndex((m) => re.test(m));
  const order = [/Started P15/, /5 s time penalty/, /Pit stop.*Medium.*Hard/, /Safety car/, /Best lap.*1:18\.123/].map(find);
  assert.ok(order.every((i) => i >= 0), `all there: ${JSON.stringify(moments)}`);
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'in lap order');
  assert.match(moments[find(/Safety car/)], /Laps 8.9/);
});

test('analysis: picking another session shows it; Full debrief opens the Debrief on that session', async (t) => {
  const app = await openAnalysis(t);
  app.$$('.ana__session')[1].click();
  assert.match(app.text('.ana__title'), /Spa/);
  assert.match(app.text('.ana__result'), /P3/);
  assert.doesNotMatch(app.text('.ana__result'), /from P/, 'qualifying has no grid to gain from');
  app.$$('.ana__view').find((b) => b.textContent === 'Full debrief').click();
  assert.ok(app.doc.querySelector('.ana .w-deb'), 'the Debrief, inside Race analysis');
  assert.strictEqual(app.doc.querySelector('.ana .w-deb__session').value, 'spa1');
  assert.deepStrictEqual(app.errors, []);
});

test('analysis: before any session is saved it says so, instead of an empty page', async (t) => {
  const app = await openAnalysis(t, []);
  assert.match(app.text('.ana'), /No saved sessions yet/);
  assert.deepStrictEqual(app.errors, []);
});

test('analysis: works with no game running: saved sessions need no live car', async (t) => {
  const app = open(t, { before: (w) => { w.undercut = fakeApi(); } });
  await new Promise((r) => setTimeout(r, 10));
  app.connect();
  app.send({ source: 'live', capturing: false, connected: false, debrief: { sessions: [barcelona] } });
  [...app.window.document.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Race analysis')).click();
  assert.match(app.window.document.querySelector('.ana__title').textContent, /Barcelona/);
});

test('analysis: a stop flagged on both the in-lap and the out-lap is one pit stop', async (t) => {
  const twoLapStop = { ...barcelona, laps: barcelona.laps.map((l) => (l.lap === 6 ? { ...l, pit: true } : l)) };
  const app = await openAnalysis(t, [twoLapStop]);
  const stops = app.$$('.ana__moment').map((m) => m.textContent).filter((m) => /Pit stop/.test(m));
  assert.strictEqual(stops.length, 1, JSON.stringify(stops));
  assert.match(stops[0], /Lap 5.*Medium → Hard/);
});

test('analysis: sessions on disk past the 10 in memory are listed too, oldest last, without Full debrief (roadmap G3)', async (t) => {
  const monza = { ...barcelona, id: 'old1', startedAt: Date.UTC(2026, 8, 1), track: 'Monza' };
  const app = open(t, {
    before: (w) => {
      w.undercut = fakeApi();
      w.fetch = async (url) => (String(url).endsWith('/api/debrief/older') ? { ok: true, json: async () => ({ sessions: [monza, barcelona] }) } : { ok: false, json: async () => ({}) });
    },
  });
  await new Promise((r) => setTimeout(r, 10));
  app.connect();
  app.send({ ...raceSnapshots()[200], debrief: { sessions: [barcelona, spa] } });
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Race analysis')).click();
  await new Promise((r) => setTimeout(r, 20));
  const names = [...doc.querySelectorAll('.ana__session-name')].map((n) => n.textContent);
  assert.deepStrictEqual(names, ['Barcelona · Race', 'Spa · Qualifying 3', 'Monza · Race']);
  [...doc.querySelectorAll('.ana__session')][2].click();
  assert.match(doc.querySelector('.ana__title').textContent, /Monza/);
  assert.ok(![...doc.querySelectorAll('.ana__view')].some((b) => b.textContent === 'Full debrief'), 'the Debrief card only has the sessions in memory');
  assert.deepStrictEqual(app.errors, []);
});
