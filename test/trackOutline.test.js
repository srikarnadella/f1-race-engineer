const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOutlines, BINS } = require('../src/state/trackOutline');

// The track map: the outline is learned from one clean lap of yours (where you were, by distance round the lap),
// kept per track, and never redrawn by a worse lap. A circle of 1000 m circumference makes the answer checkable.
const LENGTH = 6283; // 2 * pi * 1000
const at = (d) => ({ x: 1000 * Math.cos((d / LENGTH) * 2 * Math.PI), z: 1000 * Math.sin((d / LENGTH) * 2 * Math.PI) });
const sample = (d, over = {}) => ({ trackId: 10, length: LENGTH, distance: d, ...at(d), speedKmh: 200, inPit: false, ...over });
const lap = (o, { from = 0, to = LENGTH, step = 20, over = () => ({}) } = {}) => { for (let d = from; d < to; d += step) o.observe(sample(d, over(d))); };

test('outline: a clean lap draws the track, closed on itself, once the next lap begins', () => {
  const o = createOutlines();
  lap(o);
  assert.strictEqual(o.get(10), null, 'not until the lap is finished');
  o.observe(sample(5)); // across the line
  const outline = o.get(10);
  assert.strictEqual(outline.length, BINS);
  const worst = Math.max(...outline.map(([x, z]) => Math.abs(Math.hypot(x, z) - 1000)));
  assert.ok(worst < 20, `every point is on the circle (off by ${worst.toFixed(1)} m)`);
  assert.deepStrictEqual(o.get(11), null, 'another track has none');
});

test('outline: a lap through the pits is not enough, and neither is a lap with a big hole in it', () => {
  const o = createOutlines();
  lap(o, { over: (d) => ({ inPit: d > 4000 && d < 5400 }) });
  o.observe(sample(5));
  assert.strictEqual(o.get(10), null, 'the pit lane is not the track');
  lap(o, { to: 3000 });
  lap(o, { from: 4500 });
  o.observe(sample(5));
  assert.strictEqual(o.get(10), null, 'a third of the lap missing');
  lap(o);
  o.observe(sample(5));
  assert.ok(o.get(10), 'the next clean lap draws it');
});

test('outline: crawling or stopped samples are ignored, and a better lap does not redraw it', () => {
  const o = createOutlines();
  lap(o, { over: () => ({ speedKmh: 5 }) });
  o.observe(sample(5));
  assert.strictEqual(o.get(10), null, 'a car standing still tells nothing about the line');
  lap(o);
  o.observe(sample(5));
  const first = JSON.stringify(o.get(10));
  lap(o, { over: () => ({ x: 5000, z: 5000 }) }); // a lap off in the weeds
  o.observe(sample(5));
  assert.strictEqual(JSON.stringify(o.get(10)), first, 'kept as drawn');
});

test('outline: bad input is ignored and never throws', () => {
  const o = createOutlines();
  for (const bad of [{}, { trackId: null }, sample(-30), sample(NaN), { ...sample(10), x: undefined }, { ...sample(10), length: 0 }]) assert.doesNotThrow(() => o.observe(bad));
  assert.strictEqual(o.get(10), null);
});

test('outline: kept on disk, and a damaged file is ignored rather than breaking the app', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tracks.json');
  const a = createOutlines({ file });
  lap(a);
  a.observe(sample(5));
  assert.deepStrictEqual(createOutlines({ file }).get(10), a.get(10));
  fs.writeFileSync(file, '{ not json');
  assert.strictEqual(createOutlines({ file }).get(10), null);
});
