const test = require('node:test');
const assert = require('node:assert');
const enc = require('../src/sim/encoders');
const { createPipeline } = require('../src/pipeline');

// Roadmap X2/X3 end to end: Motion packets in, "car left / car right" in the snapshot the dashboard and the voice read.
const H = { sessionUID: 42n, sessionTime: 10, frameIdentifier: 1, playerCarIndex: 3 };
const facing = { forwardZ: -1, rightX: 1 }; // facing -z, right is +x
const cars = (list) => {
  const out = Array.from({ length: 22 }, () => ({}));
  for (const [i, c] of Object.entries(list)) out[i] = { ...facing, ...c };
  return out;
};

function run() {
  let t = 1_000_000;
  const p = createPipeline({ now: () => t });
  const motion = (list) => p.feed(enc.encodeMotion(H, cars(list)));
  const tick = (ms) => { t += ms; return p.tick(); };
  return { p, motion, tick };
}

test('pipeline: a car alongside on the right shows in the snapshot, and clears after the hold', () => {
  const { motion, tick } = run();
  motion({ 3: { x: 100, z: 200 }, 5: { x: 103, z: 200 } });
  assert.deepStrictEqual(tick(100).spotter, { left: false, right: true });
  motion({ 3: { x: 100, z: 200 }, 5: { x: 103, z: 200 }, 6: { x: 97, z: 201 } });
  assert.deepStrictEqual(tick(100).spotter, { left: true, right: true });
  motion({ 3: { x: 100, z: 200 }, 5: { x: 103, z: 230 } });
  assert.deepStrictEqual(tick(100).spotter, { left: true, right: true }, 'held for a moment');
  motion({ 3: { x: 100, z: 200 }, 5: { x: 103, z: 230 } });
  assert.deepStrictEqual(tick(500).spotter, { left: false, right: false });
});

test('pipeline: with no Motion packets the spotter is all clear, never missing', () => {
  const { p, tick } = run();
  assert.deepStrictEqual(tick(100).spotter, { left: false, right: false });
  assert.ok(p.snapshot().spotter);
});
