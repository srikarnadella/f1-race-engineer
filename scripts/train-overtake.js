#!/usr/bin/env node
// Trains the overtake-probability model from recorded races.
//
//   npm run train:overtake [-- capture-folder ...]   (default: every folder in captures/)
//
// Pipeline: replay each capture through the real parsers and FieldModel ->
// once a second, one sample per close battle (car directly behind another,
// within 3s) -> label it 1 if the game's OVTK event shows that exact pass
// within the next HORIZON_S seconds -> logistic regression -> evaluated by
// leave-one-race-out (trained on the other races, scored on the held-out
// one), against a gap-only baseline -> model + report written to the repo.
const fs = require('fs');
const path = require('path');
const PACKET_IDS = require('../src/udp/packetIds');
const { readLog } = require('../src/capture/logFile');
const { parsePacket } = require('../src/udp/parsePacket');
const { createFieldModel } = require('../src/state/fieldModel');
const { FEATURES, pairFeatures, toVector } = require('../src/ml/overtakeFeatures');
const { train, predict, evaluate } = require('../src/ml/logistic');

const HORIZON_S = 10;
// L2 strength - chosen by the held-out score (see the report).
const LAMBDA = Number(process.env.LAMBDA || 0.01);
const BALANCE = process.env.BALANCE !== '0';
const MAX_GAP_S = 3;
const SAMPLE_EVERY_S = 1;
const RACE_TYPES = new Set([15, 16, 17]);
const ROOT = path.resolve(__dirname, '..');
const MODEL_OUT = path.join(ROOT, 'src', 'ml', 'models', 'overtake.json');
const HOTSPOTS_OUT = path.join(ROOT, 'src', 'ml', 'models', 'pass-hotspots.json');
const HOTSPOT_BIN_M = 100;
const REPORT_OUT = path.join(ROOT, 'docs', 'ml-overtake-model.md');

function captureFiles(args) {
  const dirs = args.length ? args : fs.existsSync(path.join(ROOT, 'captures'))
    ? fs.readdirSync(path.join(ROOT, 'captures')).map((d) => path.join(ROOT, 'captures', d)) : [];
  return dirs
    .map((d) => (fs.statSync(d).isDirectory() ? ['packets.f1log.gz', 'packets.f1log'].map((f) => path.join(d, f)).find((f) => fs.existsSync(f)) : d))
    .filter(Boolean);
}

// One capture -> race sessions -> { samples: [{t, a, d, x}], passes: [{t, a, d}] }.
async function extract(file) {
  const fm = createFieldModel();
  const races = new Map(); // sessionUID -> { name, samples, passes }
  let lastSample = -Infinity;
  let lastT = null;
  let uid = null;
  for await (const { buf } of readLog(file)) {
    let parsed;
    try {
      parsed = parsePacket(buf);
    } catch {
      continue;
    }
    const { header, data } = parsed;
    if (!data) continue;
    fm.dispatch(header.packetId, header, data);
    const session = fm.getSession();
    if (!session || !RACE_TYPES.has(session.sessionType)) continue;
    uid = String(header.sessionUID);
    if (!races.has(uid)) races.set(uid, { name: `${path.basename(path.dirname(file))} (track ${session.trackId})`, samples: [], passes: [], trackId: session.trackId, trackLength: session.trackLength });
    const race = races.get(uid);
    const t = header.sessionTime;
    // A flashback rewinds time: drop the future that no longer happened.
    if (lastT != null && t < lastT - 0.5) {
      race.samples = race.samples.filter((s) => s.t <= t);
      race.passes = race.passes.filter((p) => p.t <= t);
      lastSample = t;
    }
    lastT = t;
    if (header.packetId === PACKET_IDS.EVENT && data.code === 'OVTK') {
      // Where it happened too (lap 1 aside) - the pass-hotspot map.
      const lap = fm.getCar(data.overtakerIdx).lapData;
      race.passes.push({ t, a: data.overtakerIdx, d: data.overtakenIdx, atM: lap && lap.currentLapNum > 1 && lap.lapDistance >= 0 ? lap.lapDistance : null });
    }
    if (t - lastSample < SAMPLE_EVERY_S) continue;
    lastSample = t;
    const ordered = fm.orderedByPosition();
    for (let k = 1; k < ordered.length; k++) {
      const att = ordered[k];
      const def = ordered[k - 1];
      const f = pairFeatures(att, def);
      if (!f || f.gapS > MAX_GAP_S) continue;
      race.samples.push({ t, a: att.carIndex, d: def.carIndex, x: toVector(f) });
    }
  }
  for (const race of races.values()) {
    for (const s of race.samples) {
      s.y = race.passes.some((p) => p.a === s.a && p.d === s.d && p.t > s.t && p.t <= s.t + HORIZON_S) ? 1 : 0;
    }
  }
  return [...races.values()].filter((r) => r.samples.length);
}

const weightsTable = (model, names) => names.map((n, j) => ({ feature: n, weight: +model.weights[j].toFixed(3) })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

async function main() {
  const files = captureFiles(process.argv.slice(2));
  if (!files.length) throw new Error('No captures found - record races with `npm run capture` first.');
  const races = [];
  for (const f of files) {
    const found = await extract(f);
    races.push(...found);
    for (const r of found) console.log(`${r.name}: ${r.samples.length} battle samples, ${r.samples.filter((s) => s.y).length} labelled passes (${r.passes.length} OVTK events)`);
  }
  if (!races.length) throw new Error('No race sessions in those captures.');
  const all = races.flatMap((r) => r.samples);

  // Leave-one-race-out: every race scored by a model that never saw it.
  const gapIdx = FEATURES.indexOf('logGap');
  const held = { full: { s: [], y: [] }, gapOnly: { s: [], y: [] } };
  if (races.length > 1) {
    races.forEach((test, i) => {
      const trainSet = races.filter((_, j) => j !== i).flatMap((r) => r.samples);
      const m = train(trainSet.map((s) => s.x), trainSet.map((s) => s.y), { lambda: LAMBDA, balance: BALANCE });
      const g = train(trainSet.map((s) => [s.x[gapIdx]]), trainSet.map((s) => s.y), { lambda: LAMBDA, balance: BALANCE });
      for (const s of test.samples) {
        held.full.s.push(predict(m, s.x));
        held.full.y.push(s.y);
        held.gapOnly.s.push(predict(g, [s.x[gapIdx]]));
        held.gapOnly.y.push(s.y);
      }
    });
  }
  const evalFull = races.length > 1 ? evaluate(held.full.s, held.full.y) : null;
  const evalGap = races.length > 1 ? evaluate(held.gapOnly.s, held.gapOnly.y) : null;

  // The shipped model uses every race.
  const model = train(all.map((s) => s.x), all.map((s) => s.y), { lambda: LAMBDA, balance: BALANCE });
  const out = {
    name: 'overtake-probability',
    question: `Will the car directly behind pass the car ahead within ${HORIZON_S}s?`,
    horizonS: HORIZON_S,
    features: FEATURES,
    mean: model.mean.map((v) => +v.toFixed(6)),
    std: model.std.map((v) => +v.toFixed(6)),
    weights: model.weights.map((v) => +v.toFixed(6)),
    bias: +model.bias.toFixed(6),
    trainedOn: { races: races.length, samples: all.length, passes: all.filter((s) => s.y).length },
    evaluation: evalFull && { method: 'leave-one-race-out', model: { auc: evalFull.auc, logLoss: evalFull.logLoss, brier: evalFull.brier, brierSkill: evalFull.brierSkill, calibration: evalFull.calibration }, gapOnlyBaseline: { auc: evalGap.auc, logLoss: evalGap.logLoss, brier: evalGap.brier, brierSkill: evalGap.brierSkill } },
  };
  fs.mkdirSync(path.dirname(MODEL_OUT), { recursive: true });
  fs.writeFileSync(MODEL_OUT, JSON.stringify(out, null, 2) + '\n');

  // Where passes happen, per track, in 100 m bins: the attack forecast's prior.
  const tracks = {};
  for (const r of races) {
    if (r.trackId == null || !r.trackLength) continue;
    const t = tracks[r.trackId] || (tracks[r.trackId] = { lengthM: r.trackLength, binM: HOTSPOT_BIN_M, races: 0, passes: 0, counts: new Array(Math.ceil(r.trackLength / HOTSPOT_BIN_M)).fill(0) });
    t.races++;
    for (const p of r.passes) {
      if (p.atM == null) continue;
      t.counts[Math.min(t.counts.length - 1, Math.floor(p.atM / HOTSPOT_BIN_M))]++;
      t.passes++;
    }
  }
  fs.writeFileSync(HOTSPOTS_OUT, JSON.stringify({ note: 'Where passes happen at each track (lap 1 excluded), from recorded races. Built by npm run train:overtake.', tracks }) + '\n');
  console.log('pass hotspots:', Object.entries(tracks).map(([id, t]) => `track ${id}: ${t.passes} passes from ${t.races} race(s)`).join(', '));

  const fmt = (v) => (v == null ? '–' : typeof v === 'number' ? v.toFixed(3) : v);
  const L = [
    '# Overtake-probability model', '',
    `_Generated by \`npm run train:overtake\` - do not edit by hand._`, '',
    `**Question:** ${out.question}`, '',
    `**Data:** ${races.length} recorded F1 26 race(s), ${all.length} one-second samples of close battles (car directly behind, within ${MAX_GAP_S}s), ${out.trainedOn.passes} of them followed by a pass (base rate ${(out.trainedOn.passes / all.length * 100).toFixed(1)}%). Labels come from the game's own OVTK events; flashbacks are rewound out of the data.`, '',
    '**Model:** logistic regression, standardised features, L2-regularised, class-weighted with a prior correction so outputs are real probabilities. Written from scratch (`src/ml/logistic.js`) - no ML dependency.', '',
    '## Held-out evaluation', '',
    evalFull ? `Leave-one-race-out: each race is scored by a model trained only on the others.\n\n| | AUC | Log loss | Brier | Brier skill |\n|---|---|---|---|---|\n| Model (${FEATURES.length} features) | ${fmt(evalFull.auc)} | ${fmt(evalFull.logLoss)} | ${fmt(evalFull.brier)} | ${fmt(evalFull.brierSkill)} |\n| Baseline (log gap only) | ${fmt(evalGap.auc)} | ${fmt(evalGap.logLoss)} | ${fmt(evalGap.brier)} | ${fmt(evalGap.brierSkill)} |\n\nAUC: 0.5 is a coin flip, 1.0 is perfect ranking. Brier skill: improvement over always predicting the base rate.` : '_Needs at least two races for a held-out score._', '',
    evalFull ? `### Calibration (held out)\n\n| Predicted | Samples | Mean predicted | Observed |\n|---|---|---|---|\n${evalFull.calibration.map((c) => `| ${c.bucket} | ${c.n} | ${fmt(c.predicted)} | ${fmt(c.observed)} |`).join('\n')}` : '', '',
    '## What drives a pass (standardised weights, all races)', '',
    '| Feature | Weight |', '|---|---|',
    ...weightsTable(model, FEATURES).map((w) => `| \`${w.feature}\` | ${w.weight > 0 ? '+' : ''}${w.weight.toFixed(3)} |`), '',
    'Positive = makes a pass more likely. Weights are on standardised features, so their sizes compare directly.', '',
    '## Caveats', '',
    `- Small data: ${races.length} race(s). Every new capture can be added - re-run \`npm run train:overtake\`.`,
    '- Mostly AI drivers, so it learns how the game\'s AI battles; the player is one car of 22.',
    '- OVTK fires on any position swap, including some that come from a car ahead running wide or into the pits.',
  ];
  fs.mkdirSync(path.dirname(REPORT_OUT), { recursive: true });
  fs.writeFileSync(REPORT_OUT, L.join('\n') + '\n');

  console.log(`\n${all.length} samples, ${out.trainedOn.passes} passes across ${races.length} race(s)`);
  if (evalFull) console.log(`held-out AUC ${fmt(evalFull.auc)} (gap-only baseline ${fmt(evalGap.auc)}), Brier skill ${fmt(evalFull.brierSkill)} (baseline ${fmt(evalGap.brierSkill)})`);
  console.log('weights:', weightsTable(model, FEATURES).map((w) => `${w.feature} ${w.weight}`).join(', '));
  console.log(`\nwrote ${path.relative(ROOT, MODEL_OUT)} and ${path.relative(ROOT, REPORT_OUT)}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
