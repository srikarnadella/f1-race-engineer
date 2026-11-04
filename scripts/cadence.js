#!/usr/bin/env node
// How steady was the game's telemetry in a recording? The game sends car telemetry once per game frame
// (up to the send rate you set), so the gaps between those packets follow its frame rate: a lower rate, or
// hitches, mean the game ran slower. Compare two recordings of the same track and conditions, one with
// Undercut closed or minimized and one with it open, to see whether it costs you frames.
//
//   npm run cadence -- <capture folder or .f1log[.gz]> ...     (default: every capture in the app's data folder)
//
// Gaps over a second are pauses (the pause menu, a replay, a flashback), not stutter, and are left out of the rate.
const fs = require('fs');
const path = require('path');
const { readLog } = require('../src/capture/logFile');
const { parsePacket } = require('../src/udp/parsePacket');

const CAR_TELEMETRY = 6;
const PAUSE_MS = 1000;

// gaps: ms between consecutive car-telemetry packets. Pauses are dropped; hitches are gaps from 50 ms up.
function cadence(gapsMs) {
  const gaps = gapsMs.filter((g) => g < PAUSE_MS).sort((a, b) => a - b);
  if (!gaps.length) return null;
  const q = (x) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * x))];
  return { packets: gaps.length, medianMs: q(0.5), p90Ms: q(0.9), p99Ms: q(0.99), perSecond: +(1000 / q(0.5)).toFixed(1), hitches: gaps.filter((g) => g >= 50).length, pauses: gapsMs.length - gaps.length };
}

async function gapsOf(file) {
  const gaps = [];
  let last = null;
  for await (const { tMs, buf } of readLog(file)) {
    let p;
    try { p = parsePacket(buf); } catch (_) { continue; }
    if (!p || !p.header || p.header.packetId !== CAR_TELEMETRY) continue;
    if (last != null) gaps.push(tMs - last);
    last = tMs;
  }
  return gaps;
}

const packetsFile = (p) => (fs.existsSync(p) && fs.statSync(p).isDirectory() ? ['packets.f1log.gz', 'packets.f1log'].map((f) => path.join(p, f)).find((f) => fs.existsSync(f)) : p);

async function main() {
  const args = process.argv.slice(2);
  const dir = path.join(process.env.APPDATA || '', 'Undercut', 'data', 'captures');
  const targets = args.length ? args : fs.existsSync(dir) ? fs.readdirSync(dir).map((d) => path.join(dir, d)) : [];
  for (const t of targets) {
    const file = packetsFile(t);
    if (!file) continue;
    const c = cadence(await gapsOf(file));
    console.log(`${path.basename(path.dirname(file) === dir ? t : path.dirname(file)).padEnd(22)} ${c ? `${c.perSecond}/s  median ${c.medianMs} ms  p90 ${c.p90Ms}  p99 ${c.p99Ms}  hitches(50 ms+) ${c.hitches}  pauses ${c.pauses}` : 'no car telemetry'}`);
  }
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1); });

module.exports = { cadence };
