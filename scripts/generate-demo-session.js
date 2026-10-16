#!/usr/bin/env node
// Writes the synthetic demo session (src/sim/syntheticSession.js) as a
// .f1log in the same format the recorder produces, so `npm run demo` has
// something to replay before a real F1 26 capture is committed.
//
//   node scripts/generate-demo-session.js [out.f1log] [--if-missing]
const fs = require('fs');
const path = require('path');
const { generate } = require('../src/sim/syntheticSession');

const args = process.argv.slice(2);
const ifMissing = args.includes('--if-missing');
const outPath = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'demo', 'synthetic-session.f1log'));

if (ifMissing && fs.existsSync(outPath)) process.exit(0);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
const lines = [];
generate((tMs, buf) => lines.push(JSON.stringify({ tMs, hex: buf.toString('hex') })));
fs.writeFileSync(outPath, lines.join('\n') + '\n');

const lastT = JSON.parse(lines[lines.length - 1]).tMs;
console.log(`[demo] wrote ${lines.length} packets (${(lastT / 1000).toFixed(0)}s of racing) to ${outPath}`);
