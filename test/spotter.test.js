const test = require('node:test');
const assert = require('node:assert');
const { sideOf, createSpotter, CAR_LENGTH_M, MAX_LATERAL_M } = require('../src/analysis/spotter');

// Roadmap X3: "car left / car right / clear" from where every car is. Positions are the game's world metres on the
// ground plane (x, z); the player's own forward and right vectors say which way is left. The player faces -z here,
// so right is +x (as in a real F1 26 capture: forward (0.16, -0.99), right (0.99, 0.16)).
const me = { x: 100, z: 200, forwardX: 0, forwardZ: -1, rightX: 1, rightZ: 0 };
const at = (lateral, lon) => ({ x: 100 + lateral, z: 200 - lon }); // lon > 0: ahead of me

test('spotter: a car alongside on a side is on that side; ahead, behind or far across is not', () => {
  assert.strictEqual(sideOf(me, at(3, 0)), 'right');
  assert.strictEqual(sideOf(me, at(-3, 0)), 'left');
  assert.strictEqual(sideOf(me, at(3, 4)), 'right', 'the front of it is level with my rear');
  assert.strictEqual(sideOf(me, at(-3, -4)), 'left');
  assert.strictEqual(sideOf(me, at(3, CAR_LENGTH_M + 2)), null, 'a car length ahead is not alongside');
  assert.strictEqual(sideOf(me, at(3, -(CAR_LENGTH_M + 2))), null);
  assert.strictEqual(sideOf(me, at(MAX_LATERAL_M + 2, 0)), null, 'two lanes over');
  assert.strictEqual(sideOf(me, at(0, 0)), null, 'directly on me is a collision, not a side');
});

test('spotter: it works whichever way the car faces', () => {
  const east = { x: 0, z: 0, forwardX: 1, forwardZ: 0, rightX: 0, rightZ: 1 }; // facing +x, so right is +z
  assert.strictEqual(sideOf(east, { x: 1, z: 3 }), 'right');
  assert.strictEqual(sideOf(east, { x: 1, z: -3 }), 'left');
});

test('spotter: an unused slot at the origin and a car in the pits never count', () => {
  const origin = { x: 0, z: 0, forwardX: 0, forwardZ: -1, rightX: 1, rightZ: 0 };
  const sp = createSpotter();
  const out = sp.update(origin, [{ idx: 3, x: 3, z: 0, inactive: true }], 0);
  assert.deepStrictEqual([out.left, out.right], [null, null]);
  const pit = sp.update(me, [{ idx: 4, ...at(3, 0), inPit: true }], 100);
  assert.deepStrictEqual([pit.left, pit.right], [null, null]);
});

test('spotter: "on" is reported at once, "clear" only after the side has been empty for the hold time, each once', () => {
  const sp = createSpotter({ holdMs: 400 });
  const rival = (lat) => [{ idx: 7, ...at(lat, 0) }];
  assert.deepStrictEqual(sp.update(me, [], 0).events, []);
  const on = sp.update(me, rival(3), 100);
  assert.deepStrictEqual(on.events, [{ side: 'right', on: true, idx: 7 }]);
  assert.strictEqual(on.right, 7);
  assert.deepStrictEqual(sp.update(me, rival(3), 200).events, [], 'not repeated while it stays');
  assert.deepStrictEqual(sp.update(me, [], 300).events, [], 'gone, but held');
  assert.strictEqual(sp.update(me, [], 500).right, 7, 'still held at 200 ms');
  assert.deepStrictEqual(sp.update(me, [], 800).events, [{ side: 'right', on: false, idx: null }]);
  assert.strictEqual(sp.update(me, [], 900).right, null);
  assert.deepStrictEqual(sp.update(me, [], 1000).events, [], 'clear is said once');
});

test('spotter: a car that comes back inside the hold time is the same call, and both sides are tracked apart', () => {
  const sp = createSpotter({ holdMs: 400 });
  sp.update(me, [{ idx: 1, ...at(3, 0) }, { idx: 2, ...at(-3, 0) }], 0);
  const mid = sp.update(me, [{ idx: 2, ...at(-3, 0) }], 100);
  assert.strictEqual(mid.left, 2);
  assert.strictEqual(mid.right, 1, 'held');
  const back = sp.update(me, [{ idx: 1, ...at(3, 1) }, { idx: 2, ...at(-3, 0) }], 200);
  assert.deepStrictEqual(back.events, [], 'no new "car right"');
  assert.strictEqual(back.right, 1);
});

test('spotter: with two cars on a side it names the nearest', () => {
  const sp = createSpotter();
  const out = sp.update(me, [{ idx: 1, ...at(4.5, 2) }, { idx: 2, ...at(2.5, 1) }], 0);
  assert.strictEqual(out.right, 2);
});
