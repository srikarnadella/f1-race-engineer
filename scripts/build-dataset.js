#!/usr/bin/env node
// Builds the committed datasets from the raw captures (which stay local):
//   datasets/races.csv  one row per race session: the catalog of what was recorded
//   datasets/laps.csv   one row per car per completed lap, every race
// Each capture is replayed through the real pipeline on its own clock.
//
//   npm run dataset [-- capture-folder ...]   (default: every folder in captures/)
const fs = require('fs');
const path = require('path');
const { readLog } = require('../src/capture/logFile');
const { parseHeader } = require('../src/udp/parsers/header');
const { createPipeline } = require('../src/pipeline');
const { createLapRecorder, toCsv } = require('../src/data/laps');
const { captureFiles } = require('../src/data/captures');
const { RACE_SESSION_TYPES } = require('../src/state/race');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'datasets');
const SYNC_EVERY_MS = 1000;
const MIN_LAPS = 3; // fewer is an aborted start, not a race

const RACE_COLUMNS = ['raceId', 'capture', 'track', 'sessionType', 'totalLaps', 'lapsRun', 'cars', 'laps', 'stops', 'neutralisedLaps', 'durationMin', 'feedRateHz', 'feedLossPct'];

async function buildCapture(file) {
  const capture = path.basename(path.dirname(file));
  const races = [];
  let t = 0;
  let pipeline = null;
  let race = null;
  let lastSync = -Infinity;
  let uid = null;
  const finish = () => {
    if (!race) return;
    race.rec.sync();
    const rows = race.rec.rows();
    const lapsRun = Math.max(0, ...rows.filter((r) => r.isPlayer).map((r) => r.lapNum));
    if (lapsRun >= MIN_LAPS) races.push({ ...race, rows, lapsRun });
    race = null;
  };
  console.warn = () => {}; // odd packets are the analyzer's business, not this one's
  for await (const { tMs, buf } of readLog(file)) {
    t = tMs;
    let header;
    try {
      header = parseHeader(buf);
    } catch {
      continue;
    }
    if (String(header.sessionUID) !== uid) {
      finish();
      uid = String(header.sessionUID);
      pipeline = createPipeline({ now: () => t });
    }
    pipeline.feed(buf);
    const session = pipeline.fieldModel.getSession();
    if (!race && session && RACE_SESSION_TYPES.has(session.sessionType)) {
      race = { raceId: `${capture}#${races.length + 1}`, capture, session, rec: createLapRecorder(pipeline.fieldModel, { raceId: `${capture}#${races.length + 1}` }), firstT: tMs, feed: [] };
    }
    if (!race || tMs - lastSync < SYNC_EVERY_MS) continue;
    lastSync = tMs;
    race.rec.sync();
    race.lastT = tMs;
    const feed = pipeline.fieldModel.getFeedHealth();
    if (feed.lossPct != null) race.feed.push(feed);
  }
  finish();
  return races;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function raceRow(r) {
  const byCar = new Map();
  for (const row of r.rows) byCar.set(row.carIndex, [...(byCar.get(row.carIndex) || []), row]);
  // Stops: each car's pit-stop counter, first lap to last.
  const stops = [...byCar.values()].reduce((n, laps) => n + Math.max(0, laps[laps.length - 1].numPitStops - laps[0].numPitStops), 0);
  const leaderLaps = new Set(r.rows.filter((x) => x.neutralised).map((x) => x.lapNum));
  const round = (v, k = 1) => (v == null ? '' : Math.round(v * 10 ** k) / 10 ** k);
  return {
    raceId: r.raceId, capture: r.capture, track: r.rows[0].track, sessionType: r.session.sessionType, totalLaps: r.session.totalLaps,
    lapsRun: r.lapsRun, cars: byCar.size, laps: r.rows.length, stops, neutralisedLaps: leaderLaps.size,
    durationMin: round((r.lastT - r.firstT) / 60000), feedRateHz: round(mean(r.feed.map((f) => f.rateHz)), 0), feedLossPct: round(mean(r.feed.map((f) => f.lossPct))),
  };
}

async function main() {
  const files = captureFiles(ROOT, process.argv.slice(2));
  if (!files.length) {
    console.error('No captures found - record races with `npm run capture` first.');
    process.exit(1);
  }
  const log = console.log;
  const races = [];
  for (const f of files) {
    const found = await buildCapture(f);
    log(`  ${path.relative(ROOT, f)}: ${found.map((r) => `${r.rows[0].track} (${r.lapsRun} laps)`).join(', ') || 'no race'}`);
    races.push(...found);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const raceRows = races.map(raceRow);
  fs.writeFileSync(path.join(OUT, 'races.csv'), [RACE_COLUMNS.join(','), ...raceRows.map((r) => RACE_COLUMNS.map((c) => r[c]).join(','))].join('\n') + '\n');
  const laps = races.flatMap((r) => r.rows);
  fs.writeFileSync(path.join(OUT, 'laps.csv'), toCsv(laps));
  log(`\n${races.length} races, ${laps.length} laps -> ${path.relative(ROOT, OUT)}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
