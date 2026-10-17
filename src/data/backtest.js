// The models scored on the lap dataset (datasets/laps.csv), each against the
// guess it has to beat. Lap-level data covers the models that work per lap:
// tyre wear and when rivals stop. (Rejoin and battery need the full packet
// stream: `npm run accuracy`, on the local captures.)
const { holdOutScore } = require('../ml/tyreModel');
const { expectedStopIn, learned } = require('../analysis/rivalStops');

const DRY = new Set([16, 17, 18]);
const HORIZON_LAPS = 10; // predictions this close to the stop are the ones a driver acts on

const byKey = (rows, key) => {
  const m = new Map();
  for (const r of rows) m.set(r[key], [...(m.get(r[key]) || []), r]);
  return m;
};

// Each race: every car's laps predicted from a wear fit on the other cars.
function scoreTyreModel(rows) {
  const races = [];
  for (const [raceId, raceRows] of byKey(rows, 'raceId')) {
    const cars = [...byKey(raceRows, 'carIndex')].map(([carIndex, laps]) => ({ carIndex, lapHistory: laps }));
    const s = holdOutScore(cars);
    if (s.laps) races.push({ raceId, track: raceRows[0].track, ...s });
  }
  const laps = races.reduce((n, r) => n + r.laps, 0);
  const weighted = (k) => (laps ? Math.round(races.reduce((a, r) => a + r[k].meanMs * r.laps, 0) / laps) : null);
  return { races, laps, model: { meanMs: weighted('model') }, naive: { meanMs: weighted('naive') } };
}

// Each AI car's first green-flag stop, predicted at the end of every lap of
// the stint before it (as the dashboard does, learning from the stops already
// made in the race), against the same model that learns nothing ("the prior").
function scoreRivalStops(rows) {
  const model = [];
  const prior = [];
  let stops = 0;
  for (const raceRows of byKey(rows, 'raceId').values()) {
    const cars = [...byKey(raceRows, 'carIndex').values()].map((laps) => laps.sort((a, b) => a.lapNum - b.lapNum));
    // The in-lap of each car's first stop: the first lap into the pit lane.
    const firstStops = cars.map((laps) => {
      const inLap = laps.find((l) => l.pit && l.lapNum > 1);
      return inLap ? { laps, inLap } : null;
    }).filter(Boolean);
    const green = firstStops.filter((s) => !s.inLap.neutralised && !s.inLap.isPlayer && DRY.has(s.inLap.compound) && s.inLap.usableLife);
    for (const { laps, inLap } of green) {
      stops++;
      const startWear = laps[0].wearMax || 0;
      for (const l of laps) {
        const ahead = inLap.lapNum - l.lapNum;
        if (ahead < 1 || ahead > HORIZON_LAPS || l.neutralised || l.pit) continue;
        // What the race had shown by the end of this lap.
        const seen = green.filter((s) => s.inLap.lapNum <= l.lapNum && s.inLap !== inLap);
        const args = { compound: l.compound, age: l.tyreAge + 1, usableLife: l.usableLife, owesStop: true, lapsLeft: l.totalLaps - l.lapNum, wear: l.wearMax, startWear };
        const predict = (extra) => {
          const k = expectedStopIn({ ...args, ...extra });
          return k == null ? null : l.lapNum + 1 + k;
        };
        const m = predict({ stopShare: learned(seen.map((s) => s.inLap.tyreAge / s.inLap.usableLife)), stopWear: learned(seen.map((s) => s.inLap.wearMax)) });
        const p = predict({});
        if (m == null || p == null) continue;
        model.push(Math.abs(m - inLap.lapNum));
        prior.push(Math.abs(p - inLap.lapNum));
      }
    }
  }
  const summary = (e) => ({ meanLaps: e.length ? Math.round((e.reduce((a, b) => a + b, 0) / e.length) * 100) / 100 : null, within1Pct: e.length ? Math.round((100 * e.filter((x) => x <= 1).length) / e.length) : null });
  return { stops, predictions: model.length, model: summary(model), prior: summary(prior) };
}

// Everything, plus the numbers CI holds the line on (lower is better).
function scoreAll(rows) {
  const tyre = scoreTyreModel(rows);
  const rivalStops = scoreRivalStops(rows);
  return {
    dataset: { races: new Set(rows.map((r) => r.raceId)).size, laps: rows.length },
    tyre,
    rivalStops,
    gate: { 'tyre.meanMs': tyre.model.meanMs, 'rivalStops.meanLaps': rivalStops.model.meanLaps },
  };
}

module.exports = { scoreTyreModel, scoreRivalStops, scoreAll };
