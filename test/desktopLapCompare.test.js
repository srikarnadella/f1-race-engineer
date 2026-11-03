const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');

// Race analysis, Lap vs lap (public/analysis.js): two laps side by side on one distance axis,
// from /api/debrief/compare (src/engine/debrief.js compare -> src/analysis/lapCompare.js).
// The bridge here is a fake that answers like the real one: A is the reference, B the lap explained.
function fakeApi() {
  const status = { version: '0.1.0', mode: 'live', replay: null, recording: null, settings: { httpPort: 8080, udpPort: 20777, share: false, phoneVoice: false }, pairUrl: null, addresses: [], clients: 1, dataDir: 'C:/data', analyzing: [] };
  const ok = async () => status;
  return { status: ok, setSettings: ok, record: ok, stopRecording: ok, replay: ok, live: ok, captures: async () => [], analyze: ok, deleteCapture: ok, deleteSession: ok, showCapture: ok, openReport: ok, openDataFolder: ok, openInBrowser: ok, speech: { start: ok, stop: ok }, on: () => () => {} };
}

const LAPS = [{ lap: 4, timeMs: 80612, neutralised: false }, { lap: 7, timeMs: 80450, neutralised: false }, { lap: 10, timeMs: 80100, neutralised: false }];
const RIVALS = [{ id: 'r3', name: 'HAMILTON', timeMs: 79800 }];
const D = [...Array(401)].map((_, k) => k * 5); // a 2 km lap on the 5 m grid
const channel = (fn) => D.map(fn);
// Two corners: B loses 0.31 s into the first (at 600 m) and gains 0.05 s in the second (at 1500 m).
function compareReply(a, b) {
  const rival = typeof b === 'string' && b.startsWith('r');
  const ref = rival ? { lapNum: 9, lapMs: 79800, rival: 'HAMILTON', id: b } : { lapNum: a == null ? 10 : Number(a), lapMs: 80100 };
  const mine = rival ? { lapNum: Number(a), lapMs: 80450 } : { lapNum: b == null ? 4 : Number(b), lapMs: 80612 };
  const lap = (slow) => ({ speed: channel((d) => (d > 550 && d < 700 ? 120 - slow : 280)), throttle: channel((d) => (d > 550 && d < 650 ? 0 : 1)), brake: channel((d) => (d > 550 && d < 620 ? 0.9 : 0)), gear: channel((d) => (d > 550 && d < 700 ? 3 : 7)), steer: channel((d) => (d > 600 && d < 700 ? -0.4 : 0)) });
  return {
    laps: LAPS, rivals: RIVALS, lapA: ref, lapB: mine, totalS: 0.512, stepM: 5,
    trace: { d: D, delta: channel((d) => (d < 600 ? 0 : d < 700 ? 0.31 : 0.512)), a: lap(0), b: lap(10) },
    miniSectors: [],
    corners: [
      { corner: 1, atM: 560, fromM: 480, toM: 720, timeS: 0.31, entryKmh: 0, apexKmh: -10, exitKmh: -4, brakePointM: -15, refApexKmh: 120, summary: 'Corner 1 (0.6 km): lost 0.31s - braked 15 m earlier, 10 km/h slower at the apex' },
      { corner: 2, atM: 1500, fromM: 1420, toM: 1700, timeS: -0.05, entryKmh: 2, apexKmh: 3, exitKmh: 1, brakePointM: 5, refApexKmh: 150, summary: 'Corner 2 (1.5 km): gained 0.05s - braked 5 m later' },
    ],
    headline: ['Corner 1 (0.6 km): lost 0.31s - braked 15 m earlier, 10 km/h slower at the apex'],
    consistency: [],
  };
}

const session = { id: 'bcn1', live: false, startedAt: Date.UTC(2026, 9, 17), sessionType: 15, sessionName: 'Race', isRace: true, track: 'Barcelona', totalLaps: 12, grid: 15, finish: 7, positionsGained: 8, official: true, points: 6, fieldBestSectors: [], bestSectors: [], positionChart: null, bestLap: { lap: 10, ms: 80100 }, theoreticalBestMs: null, medianPaceMs: 80400, consistencyMs: 300, cleanLaps: 3, fieldBestMs: 79800, fastestLap: null, pitStops: 0, penalties: [], safetyCars: 0, stints: [{ compound: 17, fromLap: 1, toLap: 12, laps: 12 }], laps: [], comparable: [4, 7, 10], field: [] };

async function openLapVsLap(t, reply = compareReply) {
  const requests = [];
  const app = open(t, {
    before: (w) => {
      w.undercut = fakeApi();
      w.fetch = async (url) => {
        const u = new URL(String(url), 'http://x');
        if (!u.pathname.endsWith('/api/debrief/compare')) return { ok: false, json: async () => ({}) };
        requests.push(u);
        return { ok: true, json: async () => reply(u.searchParams.get('a'), u.searchParams.get('b')) };
      };
    },
  });
  await new Promise((r) => setTimeout(r, 10));
  app.connect();
  app.send({ ...raceSnapshots()[200], debrief: { sessions: [session] } });
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Race analysis')).click();
  [...doc.querySelectorAll('.ana__view')].find((b) => b.textContent === 'Lap vs lap').click();
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await settle();
  const $$ = (sel) => [...doc.querySelectorAll(sel)];
  const text = (sel) => (doc.querySelector(sel) || {}).textContent || '';
  const pick = async (which, value) => {
    const sel = doc.querySelector(`.lvl__pick[data-pick="${which}"]`);
    sel.value = value;
    sel.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await settle();
  };
  return { ...app, doc, $$, text, requests, pick, settle };
}

test('lap vs lap: opens on another lap against your best, and says by how much', async (t) => {
  const app = await openLapVsLap(t);
  assert.strictEqual(app.requests[0].searchParams.get('session'), 'bcn1');
  assert.match(app.text('.lvl__verdict'), /Lap 4 was 0\.512 s slower than lap 10/);
  assert.match(app.text('.lvl__legend'), /Lap 10/);
  assert.match(app.text('.lvl__legend'), /Lap 4/);
  assert.deepStrictEqual(app.errors, []);
});

test('lap vs lap: every channel on one distance axis, both laps in each', async (t) => {
  const app = await openLapVsLap(t);
  const charts = app.$$('.lvl__chart');
  assert.deepStrictEqual(charts.map((c) => c.querySelector('.lvl__chart-name').textContent), ['Time gap', 'Speed', 'Throttle', 'Brake', 'Gear', 'Steering']);
  assert.strictEqual(charts[0].querySelectorAll('polyline').length, 1, 'one gap line');
  for (const c of charts.slice(1)) assert.strictEqual(c.querySelectorAll('polyline').length, 2, c.textContent);
});

test('lap vs lap: pick your lap and what to hold it against - another lap or a rival\'s best', async (t) => {
  const app = await openLapVsLap(t);
  await app.pick('mine', '7');
  let q = app.requests[app.requests.length - 1].searchParams;
  assert.deepStrictEqual([q.get('a'), q.get('b')], ['10', '7'], 'the reference is a, the lap explained is b');
  await app.pick('ref', 'r3');
  q = app.requests[app.requests.length - 1].searchParams;
  assert.deepStrictEqual([q.get('a'), q.get('b')], ['7', 'r3'], 'against a rival the bridge takes your lap as a');
  assert.match(app.text('.lvl__verdict'), /Lap 7 was 0\.512 s slower than HAMILTON's best/);
});

test('lap vs lap: where the time went, biggest loss first; a corner zooms every chart to it', async (t) => {
  const app = await openLapVsLap(t);
  const rows = app.$$('.lvl__corner');
  assert.match(rows[0].textContent, /Corner 1/);
  assert.match(rows[0].textContent, /lost 0\.31/);
  assert.match(rows[1].textContent, /Corner 2/);
  rows[0].click();
  for (const c of app.$$('.lvl__chart svg')) assert.deepStrictEqual([c.dataset.from, c.dataset.to], ['430', '770'], 'the corner with 50 m either side');
  app.$$('.lvl__whole')[0].click();
  for (const c of app.$$('.lvl__chart svg')) assert.deepStrictEqual([c.dataset.from, c.dataset.to], ['0', '2000']);
});

test('lap vs lap: when the bridge can\'t compare, it says why', async (t) => {
  const app = await openLapVsLap(t, () => ({ error: 'Needs two complete, clean laps with telemetry' }));
  assert.match(app.text('.lvl'), /Needs two complete, clean laps with telemetry/);
  assert.deepStrictEqual(app.errors, []);
});
