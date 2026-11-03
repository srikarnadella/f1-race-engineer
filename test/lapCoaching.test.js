const test = require('node:test');
const assert = require('node:assert');
const { compareLaps, lapCorners } = require('../src/analysis/lapCompare');

// Coaching from the saved telemetry: where full throttle comes back after each corner, and how
// far you coast (off both pedals) before braking - lift and coast. Traces are built here as
// [d, tMs, speed, throttle, brake, steer, gear], a point every 2 m, time from the speed.
function trace({ coastM = 0, fullAfterApexM = 40, brakeAt = 1000 } = {}) {
  const pts = [];
  let t = 0;
  for (let d = 0; d <= 2000; d += 2) {
    let speed = 280;
    let throttle = 1;
    let brake = 0;
    if (d >= brakeAt - coastM && d < brakeAt) { throttle = 0; speed = 278; }
    if (d >= brakeAt && d < brakeAt + 100) { throttle = 0; brake = 1; speed = 280 - (d - brakeAt) * 1.8; }
    if (d >= brakeAt + 100) {
      const after = d - (brakeAt + 100); // the apex is at brakeAt + 100
      speed = Math.min(280, 100 + after * 1.2);
      throttle = after >= fullAfterApexM ? 1 : 0.5;
    }
    pts.push([d, Math.round(t), Math.round(speed), throttle, brake, 0, 6]);
    t += (2 / (speed / 3.6)) * 1000;
  }
  return { lapNum: 1, lapMs: Math.round(t), points: pts, startedAtLine: true };
}

test('coaching: where full throttle comes back after a corner, against the other lap', () => {
  const c = compareLaps({ ...trace({ fullAfterApexM: 40 }), lapNum: 2 }, { ...trace({ fullAfterApexM: 70 }), lapNum: 5 });
  const corner = c.corners[0];
  assert.ok(Math.abs(corner.throttleM - 30) <= 5, `full throttle about 30 m later, got ${corner.throttleM}`);
  assert.match(corner.summary, /full throttle \d+ m later/);
});

test('coaching: how far each lap coasts before braking', () => {
  const c = compareLaps({ ...trace({ coastM: 0 }), lapNum: 2 }, { ...trace({ coastM: 60 }), lapNum: 5 });
  const corner = c.corners[0];
  assert.ok(Math.abs(corner.coastM - 60) <= 6, `lap 5 coasted about 60 m, got ${corner.coastM}`);
  assert.strictEqual(corner.refCoastM, 0);
  assert.match(corner.summary, /coasted \d+ m before braking/);
});

test('coaching: one lap\'s braking zones, each with the flat-out run before it and any coasting', () => {
  const zones = lapCorners(trace({ coastM: 50, brakeAt: 1200 }).points);
  assert.strictEqual(zones.length, 1);
  const z = zones[0];
  assert.ok(Math.abs(z.atM - 1200) <= 5, String(z.atM));
  assert.ok(Math.abs(z.coastM - 50) <= 6, String(z.coastM));
  assert.ok(z.flatOutM > 1050 && z.flatOutM < 1160, `the run from the start to the lift, got ${z.flatOutM}`);
  assert.ok(z.apexKmh > 90 && z.apexKmh < 110, String(z.apexKmh));
});
