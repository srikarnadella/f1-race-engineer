#!/usr/bin/env node
// Usage: npm run analyze -- <capture folder | file.f1log[.gz]>
//        (no argument = the newest folder under captures/)
// Writes report.md and report.json next to the capture and prints the checks.
const fs = require('fs');
const path = require('path');
const { analyzeCapture, toMarkdown } = require('../src/capture/analyze');

function newestCapture() {
  const root = path.resolve(__dirname, '..', 'captures');
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root).map((d) => path.join(root, d)).filter((d) => fs.statSync(d).isDirectory());
  return dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

async function main() {
  const target = process.argv[2] || newestCapture();
  if (!target) {
    console.error('Usage: npm run analyze -- <capture folder | file.f1log[.gz]>\n(no captures/ found - record one with `npm run capture`)');
    process.exit(1);
  }
  const started = Date.now();
  const report = await analyzeCapture(target);
  const outDir = report.capture.dir;
  // A capture folder gets report.md/json; a loose .f1log gets <name>.report.*
  const base = fs.statSync(path.resolve(target)).isDirectory() ? path.join(outDir, 'report') : path.resolve(target).replace(/\.f1log(\.gz)?$/, '.report');
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  fs.writeFileSync(`${base}.md`, toMarkdown(report));

  console.log(`Analyzed ${report.capture.packets} packets (${report.capture.durationS}s) in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  for (const c of report.checks) console.log(`  ${c.status.padEnd(4)} ${c.name}: ${c.detail}`);
  console.log(`\n  ${report.laps.length} laps · ${report.markers.length} driver mark(s) · ${report.timeline.length} dashboard changes`);
  console.log(`\nReport: ${base}.md\n        ${base}.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
