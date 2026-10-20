#!/usr/bin/env node
// How good are the predictions? Replays recorded races through the real
// pipeline and scores two of them against what then actually happened,
// each next to a naive baseline:
//
//   Rejoin position: just before any car (not only yours) stops, where the
//   "If you box now" model says it will rejoin, vs its position 25s after the
//   stop (found by the stop counter, which also catches the flashback that
//   undoes one). Red flags are excluded: everyone stops and every gap reads 0.
//   Projected battery: at half-distance on a lap, the projected ERS store at
//   the line vs the store when the car gets there.
//   Attack forecast: summed from each capture's report.json (npm run analyze).
//   Tyre model and rival stops: scored on the lap dataset (datasets/laps.csv,
//   npm run dataset) by the same code CI gates on (src/data/backtest.js).
//
//   npm run accuracy [-- capture-folder ...]   (default: every folder in captures/)
// Writes docs/accuracy.md.
const fs = require('fs');
const path = require('path');
const { readLog } = require('../src/capture/logFile');
const { parsePacket } = require('../src/udp/parsePacket');
const { createFieldModel } = require('../src/state/fieldModel');
const { createRaceAnalysis, predictRejoin, PIT_LOSS_ESTIMATE_MS } = require('../src/engine/raceAnalysis');
const { projectBattery, ERS_MAX_J } = require('../src/analysis/batteryProjection');
const { fromCsv } = require('../src/data/laps');
const { scoreTyreModel, scoreRivalStops } = require('../src/data/backtest');
const { captureFiles } = require('../src/data/captures');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'accuracy.md');
const RACE_TYPES = new Set([15, 16, 17]);
const TICK_S = 1;
const MAX_PREDICTION_AGE_S = 30; // the car is in the pit lane for ~20s before the counter ticks
const SETTLE_AFTER_STOP_S = 25;

async function score(file, out) {
  const fm = createFieldModel();
  const ra = createRaceAnalysis(fm);
  const lastPrediction = new Map(); // carIndex -> { position, fixedPosition, keepPosition, t }
  const lastStops = new Map(); // carIndex -> numPitStops
  const stops = []; // { carIndex, at, p }
  const battery = new Map(); // carIndex -> { lapNum, projected, now }
  let lastTick = -Infinity;
  let lastT = null;
  let races = 0;
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
    if (!session || !RACE_TYPES.has(session.sessionType) || fm.playerIndex() == null) continue;
    if (String(fm.getSessionUID()) !== uid) { // the field's session: UID 0 packets belong to the current one
      uid = String(fm.getSessionUID());
      races++;
    }
    const t = header.sessionTime;
    // A flashback rewinds the race: forget predictions about a future that didn't happen.
    if (lastT != null && t < lastT - 0.5) {
      // Stops before the point it rewound to still happened.
      for (let k = stops.length - 1; k >= 0; k--) if (stops[k].at > t) stops.splice(k, 1);
      lastPrediction.clear();
      battery.clear();
    }
    lastT = t;
    if (t - lastTick < TICK_S) continue;
    lastTick = t;

    const analysis = ra.compute();
    const neutralised = !!session.safetyCarStatus || fm.isRedFlag();
    const ordered = fm.orderedByPosition();
    const L = session.trackLength;
    for (const car of ordered) {
      const ld = car.lapData;
      if (!ld || ld.resultStatus !== 2) continue;

      // --- Rejoin ---
      if (ld.pitStatus === 0 && ld.currentLapNum > 1 && !neutralised) {
        const fixed = PIT_LOSS_ESTIMATE_MS[session.trackId] || 22000;
        // As the app calls it: rivals due to stop this lap stop too.
        const stopIn = new Map((analysis.field || []).map((r) => [r.carIndex, r.stopInLaps]));
        const p = predictRejoin(ordered, car, analysis.pitLoss.ms, { stopIn });
        const q = predictRejoin(ordered, car, fixed, { stopIn });
        if (p && q) lastPrediction.set(car.carIndex, { position: p.position, fixedPosition: q.position, keepPosition: ld.carPosition, t });
      }
      const before = lastStops.get(car.carIndex);
      if (before != null && ld.numPitStops > before && !neutralised) {
        const p = lastPrediction.get(car.carIndex);
        if (p && t - p.t <= MAX_PREDICTION_AGE_S) stops.push({ carIndex: car.carIndex, at: t, p });
        lastPrediction.delete(car.carIndex);
      }
      lastStops.set(car.carIndex, ld.numPitStops);

      // --- Battery ---
      const pending = battery.get(car.carIndex);
      if (pending && ld.currentLapNum === pending.lapNum + 1) {
        const h = car.ersHistory[car.ersHistory.length - 1];
        if (h && h.lapNum === ld.currentLapNum && !h.neutralised && ld.pitStatus === 0) {
          const actual = (h.energyJ / ERS_MAX_J) * 100;
          out.battery.push({ err: Math.abs(pending.projected - actual), naive: Math.abs(pending.now - actual), profile: pending.basis === 'last lap' });
        }
        battery.delete(car.carIndex);
      }
      if (!battery.has(car.carIndex) && L > 0 && ld.lapDistance / L >= 0.5 && ld.lapDistance / L < 0.6 && !neutralised && ld.currentLapNum > 1) {
        const b = projectBattery(car, L);
        if (b && b.atLinePct != null) battery.set(car.carIndex, { lapNum: ld.currentLapNum, projected: b.atLinePct, now: b.nowPct, basis: b.basis });
      }
    }
    for (let k = stops.length - 1; k >= 0; k--) {
      const e = stops[k];
      if (t - e.at < SETTLE_AFTER_STOP_S) continue;
      stops.splice(k, 1);
      const car = fm.getCar(e.carIndex);
      if (!car.lapData || car.lapData.pitStatus !== 0) continue;
      const actual = car.lapData.carPosition;
      out.rejoin.push({ signed: e.p.position - actual, err: Math.abs(e.p.position - actual), fixed: Math.abs(e.p.fixedPosition - actual), keep: Math.abs(e.p.keepPosition - actual) });
    }
  }
  return races;
}

// From "2/8 real passes on you came at the forecast corner · field's busiest
// corner 0/8 · random corner 0.6/8" in each capture's analysis report.
function attackForecastFromReports(files) {
  const sum = { hit: 0, busiest: 0, random: 0, n: 0, races: 0 };
  for (const f of files) {
    const report = path.join(path.dirname(f), 'report.json');
    if (!fs.existsSync(report)) continue;
    const c = (JSON.parse(fs.readFileSync(report, 'utf8')).checks || []).find((x) => /^Attack forecast/.test(x.name));
    const m = c && c.detail.match(/(\d+)\/(\d+) real passes.*busiest corner (\d+)\/\d+.*random corner ([\d.]+)\/\d+/);
    if (!m) continue;
    sum.hit += +m[1];
    sum.n += +m[2];
    sum.busiest += +m[3];
    sum.random += +m[4];
    sum.races++;
  }
  return sum;
}

function attackForecastText(files) {
  const a = attackForecastFromReports(files);
  if (!a.n) return 'No analyzed captures with passes on the player yet - run `npm run analyze` on a race capture.';
  return `Of ${a.n} real passes on the player in ${a.races} race(s) (from each capture's \`npm run analyze\` report), ${a.hit} came at the
corner the forecast named, against ${a.busiest} at the track's single busiest passing corner and ${a.random.toFixed(1)} expected
from a random corner. **It beats chance, but not yet the simpler "busiest corner" rule**, so the dashboard
words it as a "likely spot" and it stays marked experimental until more races are recorded.`;
}

// Says where the wear fit doesn't beat "no wear", rather than leaving it to the table.
function tyreVerdict(races) {
  if (!races.length) return 'No race long enough to fit wear yet.';
  const lost = races.filter((x) => x.model.meanMs >= x.naive.meanMs);
  const won = races.length - lost.length;
  return `It beats the naive guess on ${won} of ${races.length} races${lost.length ? `; not on ${lost.map((x) => `${x.track} (${x.laps} laps)`).join(', ')}` : ''}.`;
}

const pctWithin =(xs, k, n) => (xs.length ? Math.round((xs.filter((x) => x[k] <= n).length / xs.length) * 100) : null);
const mean = (xs, k) => (xs.length ? xs.reduce((a, x) => a + x[k], 0) / xs.length : null);

async function main() {
  const files = captureFiles(ROOT, process.argv.slice(2));
  if (!files.length) {
    console.error('No captures found - record races with `npm run capture` first.');
    process.exit(1);
  }
  const out = { rejoin: [], battery: [] };
  const laps = fromCsv(fs.readFileSync(path.join(ROOT, 'datasets', 'laps.csv'), 'utf8'));
  const tyre = scoreTyreModel(laps);
  const stops = scoreRivalStops(laps);
  let races = 0;
  for (const f of files) {
    process.stdout.write(`  ${path.relative(ROOT, f)} ... `);
    const n = await score(f, out);
    races += n;
    console.log(`${n} race session(s)`);
  }
  const r = out.rejoin;
  const b = out.battery;
  const md = `# Prediction accuracy

Generated by \`npm run accuracy\` from ${races} recorded race session(s) (${files.length} capture file(s)). Every
prediction is scored against what then happened in the same race, next to a naive baseline - a model
only earns its place on the dashboard if it beats the obvious guess.

## "If you box now" - rejoin position

Just before any car (all 22, not only the player) stopped, the rejoin model predicted where it would come
out; that is compared with its position 25 s after the stop. Green-flag stops only.

| | Exact | Within 1 place | Mean error |
|---|---|---|---|
| **Model** (pit loss measured live from the field) | **${pctWithin(r, 'err', 0)}%** | **${pctWithin(r, 'err', 1)}%** | **${mean(r, 'err') != null ? mean(r, 'err').toFixed(2) : '-'} places** |
| Same model, fixed per-track pit loss | ${pctWithin(r, 'fixed', 0)}% | ${pctWithin(r, 'fixed', 1)}% | ${mean(r, 'fixed') != null ? mean(r, 'fixed').toFixed(2) : '-'} places |
| Naive: "you keep your position" | ${pctWithin(r, 'keep', 0)}% | ${pctWithin(r, 'keep', 1)}% | ${mean(r, 'keep') != null ? mean(r, 'keep').toFixed(2) : '-'} places |

${r.length} stops scored${r.length ? `; on average the model puts the car ${Math.abs(mean(r, 'signed')).toFixed(2)} places too far ${mean(r, 'signed') > 0 ? 'back (pessimistic)' : 'forward (optimistic)'}` : ''}${r.length < 20 ? " - a small sample: the races recorded so far had few green-flag stops (most stops in them came under a red flag, which is excluded), so read these as a sanity check rather than a benchmark" : ""}.

## Projected battery at the line

At half-distance on a green lap, the projected ERS store at the line (the rest of the lap assumed to go
like the same stretch of the last lap) against the store when the car crossed it. Every car on track.

| | Mean error | Within 5 points |
|---|---|---|
| **Projection** | **${mean(b, 'err') != null ? mean(b, 'err').toFixed(1) : '-'} pts** | **${pctWithin(b, 'err', 5)}%** |
| Naive: "stays where it is now" | ${mean(b, 'naive') != null ? mean(b, 'naive').toFixed(1) : '-'} pts | ${pctWithin(b, 'naive', 5)}% |

${b.length} half-laps scored. Points = percentage points of a full 4 MJ store.

## Tyre wear model

Every car's green-flag laps predicted from a wear fit on the *other* cars (held out, so a car never
grades its own fit), up to that car's own pace level - only the slope is tested. Against the naive
"tyres don't wear" guess. Mean error per lap over every lap of each race in the lap dataset
([datasets/](../datasets/)), slow laps (spins, traffic over 7%) left out.

| Race | Laps | **Model** | Naive |
|---|---|---|---|
${tyre.races.map((x) => `| ${x.track} | ${x.laps} | **${x.model.meanMs} ms** | ${x.naive.meanMs} ms |`).join('\n')}
| All | ${tyre.laps} | **${tyre.model.meanMs} ms** | ${tyre.naive.meanMs} ms |

${tyreVerdict(tyre.races)}

## When rivals stop

Each AI car's first green-flag stop, predicted at the end of every lap 1-10 laps before it, learning
from the stops already made in that race - against the same model learning nothing (60% of the set's
rated life). Laps off the real in-lap.

| | Mean error | Within 1 lap |
|---|---|---|
| **Model** | **${stops.model.meanLaps ?? '-'} laps** | **${stops.model.within1Pct ?? '-'}%** |
| Prior only | ${stops.prior.meanLaps ?? '-'} laps | ${stops.prior.within1Pct ?? '-'}% |

${stops.stops} green-flag AI stops, ${stops.predictions} predictions: the recorded races' other stops came under a red flag
or a safety car, which are a different decision.${stops.model.meanLaps === stops.prior.meanLaps ? ' Too few stops have been seen for the learning\nto change a prediction yet, so the two rows match.' : ''} Known weakness (a \`todo\` test): the stops a race
sees first are its early ones, so a field whose stops spread out is called early.

## Attack forecast ("where will the car behind attack?")

${attackForecastText(files)}

## Overtake model

Scored separately, by leave-one-race-out cross-validation: the LightGBM model the app runs in [ml-overtake-lightgbm.md](ml-overtake-lightgbm.md), the logistic regression it replaced in [ml-overtake-model.md](ml-overtake-model.md).
`;
  fs.writeFileSync(OUT, md);
  console.log(`\n${md}\nWritten to ${path.relative(ROOT, OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
