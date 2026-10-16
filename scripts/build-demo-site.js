#!/usr/bin/env node
// Builds the public demo website's data: replays a session through the real
// engine (parsers, FieldModel, insight engine, analysis, focus, debrief) and
// records what the dashboard would have received, so a static page can play
// it back with no bridge running. GitHub Pages hosts it (.github/workflows/pages.yml).
//
//   npm run site                                 build site/demo-data/ (CI does this on deploy)
//   npm run site -- --race captures/<folder>     also (re)build site/race-data/ from a real race
//   npm run site -- --serve                      preview at http://localhost:8099
//
// Live screens come from the synthetic demo session (every call fires in five
// laps), rebuilt on every deploy - it's deterministic, so it isn't committed.
// A real race for the Debrief needs a capture CI doesn't have, so --race
// writes it to site/race-data/, which is committed. Only derived data
// (driver names from the game, lap times, traces) goes there, never the raw capture.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { readLog } = require('../src/capture/logFile');
const { parsePacket } = require('../src/udp/parsePacket');
const { createFieldModel } = require('../src/state/fieldModel');
const { createInsightEngine } = require('../src/state/insightEngine');
const { createRaceAnalysis } = require('../src/state/raceAnalysis');
const { createDebrief } = require('../src/state/debrief');
const { createFocus } = require('../src/state/focus');
const { buildSnapshot } = require('../src/server/snapshot');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'site', 'demo-data');
const RACE_OUT = path.join(ROOT, 'site', 'race-data');
const DEMO_LOG = path.join(ROOT, 'demo', 'synthetic-session.f1log');
const TICK_MS = 100;
const SAMPLE_MS = 500; // 2 snapshots a second - plenty for a demo, a fifth of the live rate
const FIELD_EACH_SIDE = 3; // the dashboard only shows the cars around you from `field`

// Floats to 3 decimals: the dashboard never shows more, and it halves the file.
const round = (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v);
const write = (name, data, dir = OUT) => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, round));
  return fs.statSync(path.join(dir, name)).size;
};

// The engine stamps everything with Date.now(); run it on the recording's clock.
const realNow = Date.now;
const EPOCH = 1_760_000_000_000;
let clock = EPOCH;
Date.now = () => clock;

// The cars directly ahead and behind - what the Battle card shows - both have a gap trend.
function neighboursHavePace(snap) {
  const ahead = snap.nearby.filter((c) => c.gapToPlayerMs < 0).sort((a, b) => b.gapToPlayerMs - a.gapToPlayerMs)[0];
  const behind = snap.nearby.filter((c) => c.gapToPlayerMs >= 0).sort((a, b) => a.gapToPlayerMs - b.gapToPlayerMs)[0];
  return [ahead, behind].every((c) => !c || c.gapTrendMsPerLap != null);
}

async function replay(file, { onTick, everyMs = TICK_MS }) {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  const ra = createRaceAnalysis(fm);
  const focus = createFocus();
  const debrief = createDebrief(fm);
  let lastTick = -Infinity;
  let t0 = null;
  const origWarn = console.warn;
  console.warn = () => {}; // a truncated or odd packet is fine here
  try {
    for await (const { tMs, buf } of readLog(file)) {
      if (t0 == null) t0 = tMs;
      clock = EPOCH + (tMs - t0);
      let parsed;
      try {
        parsed = parsePacket(buf);
      } catch {
        continue;
      }
      if (parsed.data) fm.dispatch(parsed.header.packetId, parsed.header, parsed.data);
      if (tMs - lastTick < everyMs) continue;
      lastTick = tMs;
      debrief.tick();
      if (onTick) onTick({ tMs: tMs - t0, fm, ie, ra, focus });
    }
  } finally {
    console.warn = origWarn;
  }
  return { fm, ie, ra, debrief };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--serve')) return serve();
  const raceIdx = args.indexOf('--race');
  const raceDir = raceIdx >= 0 ? path.resolve(args[raceIdx + 1]) : null;

  if (!fs.existsSync(DEMO_LOG)) require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'generate-demo-session.js')], { stdio: 'inherit' });
  fs.rmSync(OUT, { recursive: true, force: true });

  // 1. The live screens: the synthetic session, sampled as the dashboard sees it.
  const frames = [];
  let lastSample = -Infinity;
  let lastAnalysis = null;
  const demo = await replay(DEMO_LOG, {
    onTick: ({ tMs, fm, ie, ra, focus }) => {
      const snap = buildSnapshot(fm, ie, ra, focus);
      if (snap.analysis) lastAnalysis = snap.analysis;
      // Start once the rivals' pace is known: a visitor should land mid-race, not on "needs a clean lap".
      if (tMs - lastSample < SAMPLE_MS || !snap.player || !neighboursHavePace(snap)) return;
      lastSample = tMs;
      const { updatedAtMs, field, ...rest } = snap;
      const me = field.findIndex((c) => c.isPlayer);
      const near = field.slice(Math.max(0, me - FIELD_EACH_SIDE), me + FIELD_EACH_SIDE + 1);
      frames.push({ t: tMs, s: { source: 'demo', capturing: false, field: near, ...rest } });
    },
  });
  console.log(`[site] ${frames.length} snapshots, ${(frames[frames.length - 1].t / 1000).toFixed(0)}s`);
  const kb = (n) => `${Math.round(n / 1024)} KB`;
  console.log(`[site] snapshots.json ${kb(write('snapshots.json', frames))}`);

  // 2. The Debrief: the demo session, plus any real races (site/race-data/).
  const debriefSessions = (debrief, dir) => debrief.view().sessions.filter((x) => x.laps.length).map((x) => {
    write(`api/compare-${x.id}.json`, debrief.compare(x.id, null, null), dir);
    write(`api/rivals-${x.id}.json`, debrief.rivals(x.id), dir);
    return { ...x, live: false };
  });
  if (raceDir) {
    const file = ['packets.f1log.gz', 'packets.f1log'].map((f) => path.join(raceDir, f)).find((f) => fs.existsSync(f));
    if (!file) throw new Error(`no packets.f1log(.gz) in ${raceDir}`);
    console.log(`[site] replaying ${path.relative(ROOT, file)} for the Debrief (takes a minute)...`);
    const race = await replay(file, {});
    fs.rmSync(RACE_OUT, { recursive: true, force: true });
    write('sessions.json', debriefSessions(race.debrief, RACE_OUT), RACE_OUT);
  }
  const sessions = debriefSessions(demo.debrief, OUT);
  if (fs.existsSync(path.join(RACE_OUT, 'sessions.json'))) {
    sessions.push(...JSON.parse(fs.readFileSync(path.join(RACE_OUT, 'sessions.json'), 'utf8')));
    fs.cpSync(path.join(RACE_OUT, 'api'), path.join(OUT, 'api'), { recursive: true });
  }
  // Real races first: they're the more interesting debrief.
  sessions.sort((a, b) => (a.track === 'Red Bull Ring') - (b.track === 'Red Bull Ring') || b.laps.length - a.laps.length);
  console.log(`[site] debrief: ${sessions.map((s) => `${s.sessionName} ${s.track} (${s.laps.length} laps)`).join(', ')} - ${kb(write('debrief.json', { sessions }))}`);

  // 3. The Models tab, as /api/models serves it.
  let overtake = null;
  try {
    const m = require('../src/ml/models/overtake.json');
    overtake = { question: m.question, horizonS: m.horizonS, trainedOn: m.trainedOn, evaluation: m.evaluation, weights: m.features.map((f, j) => ({ feature: f, weight: m.weights[j] })) };
  } catch (_) {
    overtake = null;
  }
  write('api/models.json', { overtake, tyre: lastAnalysis ? lastAnalysis.tyreModel : null });
  Date.now = realNow;
  console.log(`[site] written to ${path.relative(ROOT, OUT)}`);
}

// Local preview, laid out exactly as the Pages workflow publishes it:
// site/ at the root, docs/screenshots/ at /img/, the dashboard (public/) at /demo/,
// its data at /demo/demo-data/.
function serve() {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const resolve = (p) => {
    if (p.startsWith('/img/')) return path.join(ROOT, 'docs', 'screenshots', p.slice(5));
    if (p.startsWith('/demo/demo-data/')) return path.join(ROOT, 'site', p.slice('/demo/'.length));
    if (p.startsWith('/demo/')) return path.join(ROOT, 'public', p.slice('/demo/'.length) || 'index.html');
    if (p === '/demo') return null;
    return path.join(ROOT, 'site', p === '/' ? 'index.html' : p);
  };
  http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/demo') {
      res.writeHead(301, { Location: '/demo/' });
      return res.end();
    }
    let file = resolve(p);
    if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!file || p.includes('..') || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(8099, () => console.log('[site] preview: http://localhost:8099 (demo at /demo/)'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
