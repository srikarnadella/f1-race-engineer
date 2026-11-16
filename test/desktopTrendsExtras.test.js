const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');

// Race analysis, All races: the race start report and the corner trends at a track (public/analysis.js, trendsPage).
function fakeApi() {
  const status = { version: '0.1.0', mode: 'live', replay: null, recording: null, settings: { httpPort: 8080, udpPort: 20777, share: false, phoneVoice: false }, pairUrl: null, addresses: [], clients: 1, dataDir: 'C:/data', analyzing: [] };
  const ok = async () => status;
  return { status: ok, setSettings: ok, record: ok, stopRecording: ok, replay: ok, live: ok, captures: async () => [], analyze: ok, deleteCapture: ok, deleteSession: ok, showCapture: ok, openReport: ok, openDataFolder: ok, openInBrowser: ok, speech: { start: ok, stop: ok }, on: () => () => {} };
}
const TRACKS = [{ track: 'Spa', bestEverMs: 108209, improvedMs: 500, races: [{ sessionId: 9, type: 'Race', date: '2026-10-15', grid: 6, finish: 5, laps: 5, bestMs: 108700, typicalMs: 110000 }] }];
const STARTS = {
  races: [
    { sessionId: 9, track: 'Spa', date: '2026-10-15', type: 'Race', grid: 8, lap1: 5, gained: 3, finish: 4 },
    { sessionId: 11, track: 'Monaco', date: '2026-10-17', type: 'Race', grid: 3, lap1: 6, gained: -3, finish: 5 },
  ],
  summary: { races: 2, avgGained: 0, lostTwoOrMore: 1, gainedAny: 1, best: 3, worst: -3 },
};
const trends = (extra = {}) => ({ tracks: TRACKS, wear: [], calls: { races: [], total: { calls: 0, graded: 0, right: 0, wrong: 0, unclear: 0 } }, starts: STARTS, ...extra });
const CORNERS = {
  track: 'Spa',
  sessions: [{ id: 1, date: '2026-10-01', name: 'Practice', lapMs: 109800, isRef: false }, { id: 2, date: '2026-10-08', name: 'Qualifying', lapMs: 108209, isRef: true }, { id: 3, date: '2026-10-15', name: 'Race', lapMs: 108700, isRef: false }],
  corners: [{ corner: 1, atM: 420, deltas: [0.31, 0, 0.12], change: -0.19 }, { corner: 2, atM: 1500, deltas: [0.02, 0, 0.21], change: 0.19 }],
  headline: { improved: [{ corner: 1, atM: 420, change: -0.19 }], slipped: [{ corner: 2, atM: 1500, change: 0.19 }] },
};

async function openAll(t, { trendsReply = trends(), corners = CORNERS, cornerTracks = [{ track: 'Spa', sessions: 3 }] } = {}) {
  const asked = [];
  const app = open(t, { before: (w) => {
    w.undercut = fakeApi();
    w.fetch = async (url) => {
      const u = new URL(String(url), 'http://x');
      asked.push(u.pathname + u.search);
      if (u.pathname === '/api/trends') return { ok: true, json: async () => trendsReply };
      if (u.pathname === '/api/corners') return { ok: true, json: async () => (u.searchParams.get('track') ? corners : { tracks: cornerTracks }) };
      return { ok: false, json: async () => ({}) };
    };
  } });
  await new Promise((r) => setTimeout(r, 10));
  app.connect();
  app.send({ ...raceSnapshots()[200], debrief: { sessions: [] } });
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Race analysis')).click();
  doc.querySelector('.ana__all').click();
  await new Promise((r) => setTimeout(r, 40));
  return { ...app, doc, asked, text: (sel) => (doc.querySelector(sel) || {}).textContent || '' };
}

test('starts: the report says how many races, the average places gained on lap 1, and lists each start', async (t) => {
  const app = await openAll(t);
  const x = app.text('.trd__starts').replace(/\s+/g, ' ');
  assert.match(x, /Race starts/);
  assert.match(x, /2 races/);
  assert.match(x, /lost two or more places in 1/i);
  const rows = [...app.doc.querySelectorAll('.trd__starts tbody tr')].map((r) => [...r.children].map((c) => c.textContent));
  assert.deepStrictEqual(rows, [['2026-10-15', 'Spa', 'P8', 'P5', '+3', 'P4'], ['2026-10-17', 'Monaco', 'P3', 'P6', '−3', 'P5']]);
  assert.deepStrictEqual(app.errors, []);
});

test('starts: an older bridge with no start report, or no races with a start on record, shows no section and no error', async (t) => {
  const old = await openAll(t, { trendsReply: (() => { const x = trends(); delete x.starts; return x; })() });
  assert.strictEqual(old.doc.querySelector('.trd__starts'), null);
  const none = await openAll(t, { trendsReply: trends({ starts: { races: [], summary: null } }) });
  assert.strictEqual(none.doc.querySelector('.trd__starts'), null);
  assert.deepStrictEqual(old.errors.concat(none.errors), []);
});

test('corners: pick a track and each corner shows its time against your fastest lap in every session, and what changed', async (t) => {
  const app = await openAll(t);
  const sel = app.doc.querySelector('.trd__corner-track');
  assert.ok(sel, 'a track picker');
  assert.deepStrictEqual([...sel.options].map((o) => o.textContent), ['Spa (3 sessions)']);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(app.asked.some((a) => a === '/api/corners?track=Spa'), 'the first track is read');
  const head = [...app.doc.querySelectorAll('.trd__corners thead th')].map((c) => c.textContent);
  assert.deepStrictEqual(head, ['Corner', 'At', '2026-10-01', '2026-10-08', '2026-10-15', 'Change']);
  const rows = [...app.doc.querySelectorAll('.trd__corners tbody tr')].map((r) => [...r.children].map((c) => c.textContent));
  assert.deepStrictEqual(rows[0], ['1', '0.4 km', '+0.31 s', 'fastest lap', '+0.12 s', '0.19 s closer']);
  assert.deepStrictEqual(rows[1], ['2', '1.5 km', '+0.02 s', 'fastest lap', '+0.21 s', '0.19 s further']);
  const note = app.text('.trd__corners').replace(/\s+/g, ' ');
  assert.match(note, /Corner 1 .* 0\.19 s closer/);
  assert.match(note, /fuel, tyres and weather/i);
});

test('corners: no track with two sessions that have a trace means no section, and a track with nothing to compare says so', async (t) => {
  const none = await openAll(t, { cornerTracks: [] });
  assert.strictEqual(none.doc.querySelector('.trd__corners'), null);
  const thin = await openAll(t, { corners: { track: 'Spa', sessions: [], corners: [], headline: { improved: [], slipped: [] } } });
  await new Promise((r) => setTimeout(r, 30));
  assert.match(thin.text('.trd__corners'), /nothing to compare/i);
  assert.deepStrictEqual(none.errors.concat(thin.errors), []);
});
