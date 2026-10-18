#!/usr/bin/env node
// Scores the models on the committed lap dataset, as CI does (test/backtest.test.js).
//   npm run backtest               print the scores and how they compare with the saved ones
//   npm run backtest -- --update   save them as the new line CI holds (after an intended change)
const fs = require('fs');
const path = require('path');
const { fromCsv, CALL_SCHEMA } = require('../src/data/laps');
const { auditCalls } = require('../src/analysis/callsAudit');
const { scoreAll } = require('../src/data/backtest');

const DATA = path.resolve(__dirname, '..', 'datasets');
const now = scoreAll(fromCsv(fs.readFileSync(path.join(DATA, 'laps.csv'), 'utf8')));
const file = path.join(DATA, 'scores.json');
const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;

console.log(`${now.dataset.races} races, ${now.dataset.laps} laps\n`);
console.log('Tyre model (each car predicted from the others), mean error per lap:');
for (const r of now.tyre.races) console.log(`  ${r.track.padEnd(12)} ${String(r.laps).padStart(4)} laps   model ${r.model.meanMs} ms   no-wear ${r.naive.meanMs} ms`);
console.log(`  all          ${String(now.tyre.laps).padStart(4)} laps   model ${now.tyre.model.meanMs} ms   no-wear ${now.tyre.naive.meanMs} ms`);
const rs = now.rivalStops;
console.log(`\nRival stops: ${rs.stops} green-flag AI stops, ${rs.predictions} predictions 1-10 laps out`);
console.log(`  model ${rs.model.meanLaps} laps off (${rs.model.within1Pct}% within 1)   prior only ${rs.prior.meanLaps} (${rs.prior.within1Pct}%)`);
const callsFile = path.join(DATA, 'calls.csv');
if (fs.existsSync(callsFile)) {
  const laps = fromCsv(fs.readFileSync(path.join(DATA, 'laps.csv'), 'utf8'));
  const calls = fromCsv(fs.readFileSync(callsFile, 'utf8'), CALL_SCHEMA);
  console.log('\nCalls audit (each call graded against what then happened):');
  for (const raceId of new Set(laps.map((l) => l.raceId))) {
    const a = auditCalls(calls.filter((c) => c.raceId === raceId), laps.filter((l) => l.raceId === raceId));
    console.log(`  ${raceId}: ${a.summary.right} right, ${a.summary.wrong} wrong, ${a.summary.unclear} unclear of ${a.summary.graded} graded (${a.summary.calls} calls)`);
    for (const c of a.calls) if (c.verdict !== 'rule') console.log(`    lap ${String(c.lapNum).padStart(2)} ${c.action.padEnd(4)} ${c.kind.padEnd(10)} ${c.verdict.padEnd(7)} ${c.why}`);
  }
}
console.log('\nGate (lower is better):');
for (const [k, v] of Object.entries(now.gate)) console.log(`  ${k.padEnd(22)} ${v}${saved ? `   saved ${saved.gate[k]}` : ''}`);

if (process.argv.includes('--update')) {
  fs.writeFileSync(file, JSON.stringify({ dataset: now.dataset, gate: now.gate }, null, 2) + '\n');
  console.log(`\nSaved to ${path.relative(process.cwd(), file)}`);
}
