const test = require('node:test');
const assert = require('node:assert');
const { performance } = require('perf_hooks');
const { syntheticPackets } = require('./helpers/synthetic');
const { createPipeline } = require('../src/pipeline');

// The engine runs at 10 Hz on the same PC as the game, and every snapshot
// goes over Wi-Fi to a tablet. Measured on a desktop: 0.34 ms a tick (p99
// 0.9 ms), 16-21 KB a snapshot. The limits leave room for a slow CI runner;
// crossing them means a change made the hot path several times slower.
// Other test files run in parallel, so one pass's wall-clock p99 reached
// 11-29 ms with no change at all. The replay is deterministic: it runs three
// times and each tick counts its fastest pass, so contention would have to hit
// the same tick every time. The mean is CPU time, which contention can't
// inflate (one tick's CPU time can't be used: on Windows it moves in ~15.6 ms steps).
test('budget: a 10 Hz tick takes well under its 100 ms, and a snapshot fits a tablet on Wi-Fi', () => {
  const packets = [...syntheticPackets()];
  const pass = () => {
    let t = 0;
    const p = createPipeline({ now: () => t });
    const ticks = [];
    const sizes = [];
    let cpuUs = 0;
    let last = -Infinity;
    for (const { tMs, buf } of packets) {
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
    return { ticks, sizes, meanCpuMs: cpuUs / 1000 / ticks.length };
  };
  const passes = [pass(), pass(), pass()];
  const fastest = passes[0].ticks.map((_, i) => Math.min(...passes.map((r) => r.ticks[i])));
  const warm = fastest.slice(50).sort((a, b) => a - b); // after the JIT has warmed up
  const p99 = warm[Math.floor(warm.length * 0.99)];
  const meanCpuMs = Math.min(...passes.map((r) => r.meanCpuMs));
  const sizes = passes[0].sizes;
  assert.ok(meanCpuMs < 2, `mean tick ${meanCpuMs.toFixed(2)} ms of CPU`);
  assert.ok(p99 < 25, `p99 tick ${p99.toFixed(2)} ms wall-clock, fastest of three passes`);
  assert.ok(Math.max(...sizes) < 48 * 1024, `largest snapshot ${Math.max(...sizes)} bytes`);
});
