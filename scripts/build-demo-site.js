#!/usr/bin/env node
// Builds the public demo website's data: replays a session through the real
// engine (parsers, FieldModel, insight engine, analysis, focus, debrief) and
// records what the dashboard would have received, so a static page can play
// it back with no bridge running. GitHub Pages hosts it (.github/workflows/pages.yml).
//
//   npm run site                                 build site/demo-data/ (CI does this on deploy)
//   npm run site -- --race captures/<folder>     (re)build site/race-data/ from a real race
//   npm run site -- --race <dir> --laps 11-16    ...the live screens play laps 11 to 16 (the default)
//   npm run site -- --serve                      preview at http://localhost:8099
//
// The live screens play a stretch of a real race, and the Debrief shows all
// of it. That needs a capture CI doesn't have, so --race writes what the
// dashboard received to site/race-data/, which is committed - derived data
// only (game driver names, lap times, traces), never the raw capture. Re-run
// it after changing what the engine sends. Without race-data (a fresh
// clone), the synthetic demo session stands in.
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { readLog } = require('../src/capture/logFile');
const { createPipeline } = require('../src/pipeline');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'site', 'demo-data');
const RACE_OUT = path.join(ROOT, 'site', 'race-data');
const DEMO_LOG = path.join(ROOT, 'demo', 'synthetic-session.f1log');
const TICK_MS = 100;
const SAMPLE_MS = 500; // 2 snapshots a second - plenty for a demo, a fifth of the live rate
const FIELD_EACH_SIDE = 3; // the dashboard only shows the cars around you from `field`
const RACE = 15; // sessionType

// Floats to 3 decimals: the dashboard never shows more, and it halves the file.
const round = (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v);
const write = (name, data, dir = OUT) => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, round));
  return fs.statSync(path.join(dir, name)).size;
};
const kb = (n) => `${Math.round(n / 1024)} KB`;

// The engine runs on the recording's clock.
const EPOCH = 1_760_000_000_000;

// The cars directly ahead and behind - what the Battle card shows - both have a gap trend.
function neighboursHavePace(snap) {
  const ahead = snap.nearby.filter((c) => c.gapToPlayerMs < 0).sort((a, b) => b.gapToPlayerMs - a.gapToPlayerMs)[0];
  const behind = snap.nearby.filter((c) => c.gapToPlayerMs >= 0).sort((a, b) => a.gapToPlayerMs - b.gapToPlayerMs)[0];
  return [ahead, behind].every((c) => !c || c.gapTrendMsPerLap != null);
}

async function replay(file, { onTick, everyMs = TICK_MS }) {
  let clock = EPOCH;
  const pipeline = createPipeline({ now: () => clock, source: 'demo' });
  let lastTick = -Infinity;
  let t0 = null;
  const origWarn = console.warn;
  console.warn = () => {}; // a truncated or odd packet is fine here
  try {
    for await (const { tMs, buf } of readLog(file)) {
      if (t0 == null) t0 = tMs;
      clock = EPOCH + (tMs - t0);
      pipeline.feed(buf);
      if (tMs - lastTick < everyMs) continue;
      lastTick = tMs;
      const snap = pipeline.tick();
      if (onTick) onTick({ tMs: tMs - t0, snap });
    }
  } finally {
    console.warn = origWarn;
  }
  return { debrief: pipeline.debrief };
}

// Records what the dashboard would have received, twice a second, while
// keep(snapshot) says so - with `field` cut to the cars it actually shows.
function sampler(keep) {
  const frames = [];
  let lastSample = -Infinity;
  let tyre = null;
  const onTick = ({ tMs, snap }) => {
    if (tMs - lastSample < SAMPLE_MS || !snap.player || !keep(snap)) return;
    lastSample = tMs;
    tyre = snap.analysis.tyreModel;
    const { updatedAtMs, field, debrief, ...rest } = snap; // the Debrief is written once, separately
    const me = field.findIndex((c) => c.isPlayer);
    const near = field.slice(Math.max(0, me - FIELD_EACH_SIDE), me + FIELD_EACH_SIDE + 1);
    frames.push({ t: tMs, s: { ...rest, source: 'demo', capturing: false, field: near } });
  };
  return { frames, onTick, tyre: () => tyre };
}

// Each session's lap compare and rivals, as the bridge's API would answer them -
// the default comparison, and your best lap against each rival lap it offers.
const debriefSessions = (debrief, dir) => debrief.view().sessions.filter((x) => x.laps.length).map((x) => {
  const cmp = debrief.compare(x.id, null, null);
  write(`api/compare-${x.id}.json`, cmp, dir);
  for (const r of cmp.rivals || []) write(`api/compare-${x.id}-${r.id}.json`, debrief.compare(x.id, null, r.id), dir);
  write(`api/rivals-${x.id}.json`, debrief.rivals(x.id), dir);
  write(`api/audit-${x.id}.json`, debrief.audit(x.id), dir);
  return { ...x, live: false };
});

// A real race: the live screens for the player's race laps [from, to], the
// Debrief for all of it. Written to site/race-data/ (committed).
async function buildRace(raceDir, [from, to]) {
  const file = ['packets.f1log.gz', 'packets.f1log'].map((f) => path.join(raceDir, f)).find((f) => fs.existsSync(f));
  if (!file) throw new Error(`no packets.f1log(.gz) in ${raceDir}`);
  console.log(`[site] replaying ${path.relative(ROOT, file)} (takes a minute)...`);
  const live = sampler((snap) => snap.session && snap.session.sessionType === RACE && snap.player.currentLapNum >= from && snap.player.currentLapNum <= to);
  const race = await replay(file, { onTick: live.onTick });
  if (!live.frames.length) throw new Error(`no race laps ${from}-${to} in ${raceDir}`);
  // From zero, with the game's pauses (menus, a flashback being picked)
  // squeezed out - nobody watches a frozen demo for a minute.
  let t = 0;
  const frames = live.frames.map((fr, i, all) => {
    if (i) t += Math.min(fr.t - all[i - 1].t, 2 * SAMPLE_MS);
    return { t, s: fr.s };
  });
  fs.rmSync(RACE_OUT, { recursive: true, force: true });
  fs.mkdirSync(RACE_OUT, { recursive: true });
  fs.writeFileSync(path.join(RACE_OUT, 'snapshots.json.gz'), zlib.gzipSync(JSON.stringify(frames, round), { level: 9 }));
  write('sessions.json', debriefSessions(race.debrief, RACE_OUT), RACE_OUT);
  write('models-tyre.json', live.tyre(), RACE_OUT);
  console.log(`[site] race: ${frames.length} snapshots (laps ${from}-${to}), ${kb(fs.statSync(path.join(RACE_OUT, 'snapshots.json.gz')).size)} gzipped`);
}

// No real race committed: the synthetic session, from once the rivals'
// pace is known - a visitor should land mid-race, not on "needs a clean lap".
async function buildSynthetic() {
  if (!fs.existsSync(DEMO_LOG)) require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'generate-demo-session.js')], { stdio: 'inherit' });
  const live = sampler(neighboursHavePace);
  const demo = await replay(DEMO_LOG, { onTick: live.onTick });
  return { frames: live.frames, sessions: debriefSessions(demo.debrief, OUT), tyre: live.tyre() };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--serve')) return serve();
  const raceIdx = args.indexOf('--race');
  const lapsIdx = args.indexOf('--laps');
  const laps = (lapsIdx >= 0 ? args[lapsIdx + 1] : '11-16').split('-').map(Number);
  if (raceIdx >= 0) await buildRace(path.resolve(args[raceIdx + 1]), laps);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  let frames;
  let sessions;
  let tyre;
  if (fs.existsSync(path.join(RACE_OUT, 'snapshots.json.gz'))) {
    frames = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RACE_OUT, 'snapshots.json.gz'))));
    sessions = JSON.parse(fs.readFileSync(path.join(RACE_OUT, 'sessions.json'), 'utf8'));
    tyre = JSON.parse(fs.readFileSync(path.join(RACE_OUT, 'models-tyre.json'), 'utf8'));
    fs.cpSync(path.join(RACE_OUT, 'api'), path.join(OUT, 'api'), { recursive: true });
  } else {
    ({ frames, sessions, tyre } = await buildSynthetic());
  }
  // 1. The live screens.
  console.log(`[site] live: ${frames.length} snapshots, ${(frames[frames.length - 1].t / 1000).toFixed(0)}s - snapshots.json ${kb(write('snapshots.json', frames))}`);
  // 2. The Debrief, longest session first.
  sessions.sort((a, b) => b.laps.length - a.laps.length);
  console.log(`[site] debrief: ${sessions.map((x) => `${x.sessionName} ${x.track} (${x.laps.length} laps)`).join(', ')} - ${kb(write('debrief.json', { sessions }))}`);

  // 3. The Models tab, as /api/models serves it.
  let overtake = null;
  try {
    overtake = require('../src/ml/modelInfo').overtakeInfo();
  } catch (_) {
    overtake = null;
  }
  write('api/models.json', { overtake, tyre });
  console.log(`[site] written to ${path.relative(ROOT, OUT)}`);
}

// Local preview, laid out exactly as the Pages workflow publishes it:
// site/ at the root, docs/screenshots/ and site/img/ at /img/, the dashboard (public/) at /demo/,
// its data at /demo/demo-data/.
function serve() {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
  const resolve = (p) => {
    if (p.startsWith('/img/')) return [path.join(ROOT, 'docs', 'screenshots', p.slice(5)), path.join(ROOT, 'site', 'img', p.slice(5))].find((f) => fs.existsSync(f));
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
