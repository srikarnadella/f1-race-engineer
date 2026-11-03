const test = require('node:test');
const assert = require('node:assert');
const { treeOf, summarize } = require('../scripts/perf-app');

const proc = (pid, parent, cpuS = 0, wsMB = 0, privateMB = 0) => ({ pid, parent, cpuS, wsMB, privateMB, name: 'x' });

test('perf-app: the app tree is the root and every descendant, not its siblings or parent', () => {
  const all = [proc(1, 0), proc(10, 1), proc(11, 10), proc(12, 11), proc(20, 1), proc(13, 10)];
  assert.deepStrictEqual(treeOf(10, all).map((p) => p.pid).sort(), [10, 11, 12, 13]);
});

test('perf-app: CPU counts only the time used between samples, including a process that started in between', () => {
  const before = [proc(10, 1, 5), proc(11, 10, 2)];
  const after = [proc(10, 1, 6, 100, 80), proc(11, 10, 2.5, 50, 40), proc(12, 10, 0.5, 30, 20)];
  const r = summarize(before, after, 10000, 8);
  assert.ok(Math.abs(r.cpuOneCore - 20) < 1e-9); // 2 CPU-seconds over 10 s
  assert.ok(Math.abs(r.cpuMachine - 2.5) < 1e-9);
  assert.strictEqual(r.wsMB, 180);
  assert.strictEqual(r.privateMB, 140);
  assert.strictEqual(r.processes, 3);
});
