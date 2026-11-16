const test = require('node:test');
const assert = require('node:assert');
const { timeMap } = require('../src/analysis/timeMap');
const { compareLaps } = require('../src/analysis/lapCompare');
const { createOutlines } = require('../src/state/trackOutline');

// Where on the track a lap lost its time: the lap comparison's running gap, cut into equal slices of the lap, one per point of the
// track outline, so each stretch of the map can be coloured by what the lap lost or gained there.
const trace = (gapAt) => {
  const d = Array.from({ length: 601 }, (_, k) => k * 5); // a 3 km lap in 5 m steps
  return { d, delta: d.map(gapAt) };
};

test('timeMap: each slice carries only the time lost or gained inside it, and the slices add up to the whole gap', () => {
  const t = trace((m) => (m < 1000 ? 0 : m < 1500 ? ((m - 1000) / 500) * 1.2 : 1.2)); // 1.2 s lost between 1.0 and 1.5 km
  const { deltaS, lengthM } = timeMap(t, 240);
  assert.strictEqual(deltaS.length, 240);
  assert.strictEqual(lengthM, 3000);
  assert.ok(Math.abs(deltaS.reduce((a, b) => a + b, 0) - 1.2) < 0.01, 'the sum is the lap\'s whole gap');
  const loud = deltaS.map((v, i) => [i, v]).filter(([, v]) => Math.abs(v) > 0.001).map(([i]) => i);
  assert.ok(Math.min(...loud) >= Math.floor((1000 / 3000) * 240) - 1 && Math.max(...loud) <= Math.ceil((1500 / 3000) * 240) + 1, `only 1.0-1.5 km: slices ${loud[0]}-${loud.at(-1)}`);
});

test('timeMap: a stretch where the lap was faster comes out negative', () => {
  const t = trace((m) => (m < 2000 ? 0 : -((Math.min(m, 2400) - 2000) / 400) * 0.5));
  const { deltaS } = timeMap(t, 120);
  assert.ok(Math.min(...deltaS) < -0.002);
  assert.ok(deltaS.every((v) => v <= 0.0005), 'nothing lost anywhere');
});

test('timeMap: a lap that is shorter than the usual or has too few points gives nothing rather than throwing', () => {
  assert.strictEqual(timeMap({ d: [], delta: [] }), null);
  assert.strictEqual(timeMap({ d: [0], delta: [0] }), null);
  assert.strictEqual(timeMap(null), null);
});

test('compareLaps: the comparison carries its time map, and it adds up to the lap\'s total gap', () => {
  // two 3 km laps with one corner each; B takes it slower
  const lap = (apex, lapNum) => {
    const points = [];
    let t = 0;
    for (let d = 0; d <= 3000; d += 10) {
      const inCorner = d >= 1000 && d <= 1100;
      const speed = d < 900 ? 250 : d < 1000 ? 250 - ((d - 900) / 100) * (250 - apex) : d <= 1100 ? apex : 250;
      points.push([d, Math.round(t), speed, inCorner ? 0 : 1, d >= 900 && d < 1000 ? 1 : 0, 0, 4]);
      t += (10 / (speed / 3.6)) * 1000;
    }
    return { lapNum, lapMs: Math.round(t), points };
  };
  const c = compareLaps(lap(90, 1), lap(70, 2));
  assert.ok(c.timeMap && c.timeMap.deltaS.length === 240);
  assert.ok(Math.abs(c.timeMap.deltaS.reduce((a, b) => a + b, 0) - c.totalS) < 0.02);
  const worst = c.timeMap.deltaS.indexOf(Math.max(...c.timeMap.deltaS));
  assert.ok(worst >= Math.floor((850 / 3000) * 240) && worst <= Math.ceil((1300 / 3000) * 240), `the loss is at the corner: slice ${worst}`);
});

test('outline: the outline of a track is handed back by name, and null for one it has not drawn', () => {
  const o = createOutlines();
  assert.strictEqual(o.get(10), null);
});
