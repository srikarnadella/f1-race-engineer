const test = require('node:test');
const assert = require('node:assert');
const { syntheticPackets, replay, EPOCH } = require('./helpers/synthetic');
const { createPipeline } = require('../src/pipeline');

// What the driver sees each tick: the call and the radio cards.
function calls(snap) {
  return JSON.stringify({ call: snap.strategy && snap.strategy.call, radio: snap.insights.map((i) => [i.id, i.severity, i.message]), focus: snap.focus });
}

test('pipeline: packets in, a snapshot of the player and the field out', () => {
  const p = replay(syntheticPackets().slice(0, 4000));
  const snap = p.snapshot();
  assert.strictEqual(snap.connected, true);
  assert.strictEqual(snap.source, 'live');
  assert.ok(snap.player, 'the player car is known');
  assert.strictEqual(snap.field.length, 22); // the full F1 25 grid
});

test('pipeline: the debrief rides along once every 10 ticks (once a second)', () => {
  const p = replay(syntheticPackets().slice(0, 2000));
  const withDebrief = Array.from({ length: 30 }, () => 'debrief' in p.tick());
  assert.strictEqual(withDebrief.filter(Boolean).length, 3);
});

test('pipeline: a packet it cannot parse is dropped, not thrown', () => {
  const p = createPipeline();
  assert.strictEqual(p.feed(Buffer.alloc(3)), false);
  assert.strictEqual(p.feed(syntheticPackets()[0].buf), true);
});

test('pipeline: engine time comes only from the injected clock', () => {
  const ticks = (wallClock) => {
    const real = Date.now;
    // Anything still reading the wall clock would see a different time on each run.
    Date.now = wallClock;
    try {
      const out = [];
      replay(syntheticPackets(), { onTick: ({ snap }) => out.push(calls(snap)) });
      return out;
    } finally {
      Date.now = real;
    }
  };
  const a = ticks(() => EPOCH + 3_600_000);
  const b = ticks(() => 0);
  assert.ok(a.length > 3000);
  for (let i = 0; i < a.length; i++) assert.strictEqual(b[i], a[i], `tick ${i} differs`);
});

test('pipeline: the snapshot says when it was built, on the injected clock', () => {
  let t = 5000;
  const p = createPipeline({ now: () => t });
  assert.strictEqual(p.tick().updatedAtMs, 5000);
  t = 6000;
  assert.strictEqual(p.tick().updatedAtMs, 6000);
});
