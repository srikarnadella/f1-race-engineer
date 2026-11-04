const test = require('node:test');
const assert = require('node:assert');
const { cadence } = require('../scripts/cadence');

// The telemetry cadence of a recording: the game's frame rate, read from the gaps between its packets.
test('cadence: the rate is the median gap, pauses are left out and hitches counted', () => {
  const gaps = [...Array(90).fill(20), ...Array(6).fill(25), 60, 80, 120, 3000, 16000];
  const c = cadence(gaps);
  assert.strictEqual(c.medianMs, 20);
  assert.strictEqual(c.perSecond, 50);
  assert.strictEqual(c.hitches, 3, 'a gap of 50 ms or more, under a second');
  assert.strictEqual(c.pauses, 2, 'over a second is the pause menu, not stutter');
  assert.strictEqual(c.packets, 99);
});

test('cadence: a slower game is a lower rate', () => {
  assert.ok(cadence(Array(50).fill(24)).perSecond < cadence(Array(50).fill(20)).perSecond);
});

test('cadence: nothing to read is null, not NaN', () => {
  assert.strictEqual(cadence([]), null);
  assert.strictEqual(cadence([5000, 9000]), null);
});
