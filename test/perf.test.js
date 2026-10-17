const test = require('node:test');
const assert = require('node:assert');
const { performance } = require('perf_hooks');
const { syntheticPackets } = require('./helpers/synthetic');
const { createPipeline } = require('../src/pipeline');

// The engine runs at 10 Hz on the same PC as the game, and every snapshot
// goes over Wi-Fi to a tablet. Measured on a desktop: 0.34 ms a tick (p99
// 0.9 ms), 16-21 KB a snapshot. The limits leave room for a slow CI runner;
// crossing them means a change made the hot path several times slower.
// The mean is CPU time, which other test files running in parallel can't
// inflate; wall-clock p99 under that contention reached 11 ms on its own, so
// it only guards against a real stall.
test('budget: a 10 Hz tick takes well under its 100 ms, and a snapshot fits a tablet on Wi-Fi', () => {
  let t = 0;
  const p = createPipeline({ now: () => t });
  const ticks = [];
  const sizes = [];
  let cpuUs = 0;
  let last = -Infinity;
  for (const { tMs, buf } of syntheticPackets()) {
    t = tMs;
    p.feed(buf);
    if (tMs - last < 100) continue;
    last = tMs;
    const cpu = process.cpuUsage();
    const start = performance.now();
    const snap = p.tick();
    ticks.push(performance.now() - start);
    cpuUs += process.cpuUsage(cpu).user;
    sizes.push(JSON.stringify(snap).length);
  }
  const warm = ticks.slice(50).sort((a, b) => a - b); // after the JIT has warmed up
  const meanCpuMs = cpuUs / 1000 / ticks.length;
  const p99 = warm[Math.floor(warm.length * 0.99)];
  assert.ok(meanCpuMs < 2, `mean tick ${meanCpuMs.toFixed(2)} ms of CPU`);
  assert.ok(p99 < 25, `p99 tick ${p99.toFixed(2)} ms wall-clock`);
  assert.ok(Math.max(...sizes) < 48 * 1024, `largest snapshot ${Math.max(...sizes)} bytes`);
});
