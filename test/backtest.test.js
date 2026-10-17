const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { fromCsv } = require('../src/data/laps');
const { scoreTyreModel, scoreRivalStops, scoreAll } = require('../src/data/backtest');

// The models, scored on the committed lap dataset (datasets/laps.csv, built
// from real races by `npm run dataset`). CI fails if a change makes a model
// worse than the scores in datasets/scores.json - improving one means
// re-running `npm run backtest -- --update` and committing the new scores.
const DATA = path.join(__dirname, '..', 'datasets');
const rows = fromCsv(fs.readFileSync(path.join(DATA, 'laps.csv'), 'utf8'));
const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'scores.json'), 'utf8'));

// Rows for a made-up race: `cars` cars on mediums rated for 20 laps, each
// stopping on lap stopLap(car).
function race({ cars = 6, totalLaps = 30, stopLap }) {
  const out = [];
  for (let c = 0; c < cars; c++) {
    const stop = stopLap(c);
    for (let lap = 1; lap <= totalLaps; lap++) {
      const stint2 = lap > stop;
      const age = stint2 ? lap - stop - 1 : lap - 1;
      out.push({ raceId: 'x', track: 'Test', sessionType: 15, totalLaps, carIndex: c, isPlayer: c === 0, lapNum: lap, lapMs: 80000 + 100 * age, pit: lap === stop || lap === stop + 1, neutralised: false, compound: stint2 ? 18 : 17, tyreAge: age, fuelKg: 10, position: c + 1, gapToLeaderMs: c * 1000, numPitStops: stint2 ? 1 : 0, wearMax: 2 * age, usableLife: stint2 ? 25 : 20 });
    }
  }
  return out;
}

// A row's tyreAge is the age during that lap (0 on a fresh set's first lap), so a
// car boxing at 12 laps old (60% of 20) pits at the end of lap 13.
test('backtest, rival stops: cars that all stop at 60% of the rated life are predicted exactly', () => {
  const s = scoreRivalStops(race({ stopLap: () => 13 }));
  assert.ok(s.stops === 5 && s.predictions > 30, `${JSON.stringify(s)} - car 0 is the player, whose stops are the driver's call`);
  assert.strictEqual(s.model.meanLaps, 0);
});

test('backtest, rival stops: learning from the first stops beats the prior when the field stops early', () => {
  // The field boxes at 40-45% of the rated life; the prior says 60%.
  // (Stopping late, the prior already falls back to "the end of the rated life".)
  const s = scoreRivalStops(race({ stopLap: (c) => 9 + (c % 2) }));
  assert.ok(s.model.meanLaps < s.prior.meanLaps, JSON.stringify(s));
});

// Known weakness: the stops seen first are the early ones, so a field whose
// stops spread out (40%, 45% ... 65%) teaches "early" and the later cars are
// called too soon - worse than the prior (2.2 laps off vs 1.5).
test('backtest, rival stops: a field whose stops spread out is not called early by the first stoppers', { todo: 'learned share is biased to the earliest stops' }, () => {
  const s = scoreRivalStops(race({ stopLap: (c) => 9 + c }));
  assert.ok(s.model.meanLaps <= s.prior.meanLaps, JSON.stringify(s));
});

test('backtest, rival stops: a stop under a safety car is not scored (it is a different decision)', () => {
  const rowsSc = race({ stopLap: () => 13 }).map((r) => (r.lapNum === 13 ? { ...r, neutralised: true } : r));
  assert.strictEqual(scoreRivalStops(rowsSc).stops, 0);
});

test('backtest, tyre model: scores every race long enough to fit, against "no wear"', () => {
  const s = scoreTyreModel(race({ cars: 8, stopLap: () => 14 }));
  assert.strictEqual(s.races.length, 1);
  assert.ok(s.races[0].model.medianMs < s.races[0].naive.medianMs);
});

test('gate: no model is worse on the real races than its saved score', () => {
  const now = scoreAll(rows);
  const worse = [];
  for (const [name, metric] of Object.entries(saved.gate)) {
    if (now.gate[name] > metric + 1e-9) worse.push(`${name}: ${now.gate[name]} (saved ${metric})`);
  }
  assert.deepStrictEqual(worse, [], 'a model got worse - or, if this is the intended trade-off, run `npm run backtest -- --update`');
});

test('gate: the dataset is the one the scores were saved from', () => {
  assert.strictEqual(rows.length, saved.dataset.laps);
  assert.strictEqual(new Set(rows.map((r) => r.raceId)).size, saved.dataset.races);
});
