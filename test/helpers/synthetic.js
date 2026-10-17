// The scripted synthetic race (src/sim/syntheticSession.js) as packets, and a
// replay of it through the pipeline on the race's own clock, so tests can
// assert on what the dashboard would have shown at each moment.
const { generate } = require('../../src/sim/syntheticSession');
const { createPipeline } = require('../../src/pipeline');

const EPOCH = 1_700_000_000_000;
let cached = null;

// [{ tMs, buf }] - generated once per test process (about 16k packets).
function syntheticPackets() {
  if (!cached) {
    cached = [];
    generate((tMs, buf) => cached.push({ tMs, buf }));
  }
  return cached;
}

// Feeds `packets` and ticks the engine every 100 ms of race time, as the
// bridge does. onTick({ tMs, snap, pipeline }) sees every snapshot.
function replay(packets, { onTick, onPacket, pipelineOptions = {} } = {}) {
  let tNow = 0;
  const pipeline = createPipeline({ now: () => EPOCH + tNow, ...pipelineOptions });
  let lastTick = -Infinity;
  for (const p of packets) {
    tNow = p.tMs;
    if (onPacket) onPacket(p, pipeline);
    pipeline.feed(p.buf);
    if (p.tMs - lastTick < 100) continue;
    lastTick = p.tMs;
    const snap = pipeline.tick();
    if (onTick) onTick({ tMs: p.tMs, snap, pipeline });
  }
  return pipeline;
}

module.exports = { syntheticPackets, replay, EPOCH };
