const test = require('node:test');
const assert = require('node:assert');
const enc = require('../src/sim/encoders');
const { parsePacket } = require('../src/udp/parsePacket');
const { createCarBalanceTracker } = require('../src/state/carBalance');
const { computeAdjustments, batteryTrend } = require('../src/state/adjustments');

const H = { sessionUID: 1n, sessionTime: 1, frameIdentifier: 1, playerCarIndex: 0 };

test('car setups: differential and brake bias read per car', () => {
  const { data } = parsePacket(enc.encodeCarSetups(H, [{ onThrottle: 65, offThrottle: 50, brakeBias: 57, engineBraking: 40 }]));
  assert.strictEqual(data.cars.length, 22);
  assert.deepStrictEqual(
    [data.cars[0].onThrottle, data.cars[0].offThrottle, data.cars[0].brakeBias, data.cars[0].engineBraking],
    [65, 50, 57, 40],
  );
});

test('motion ex: wheel slip ratio and angle in RL, RR, FL, FR order', () => {
  const { data } = parsePacket(enc.encodeMotionEx(H, { wheelSlipRatio: [0.1, 0.2, -0.3, 0], wheelSlipAngle: [0, 0, 0.15, 0.15] }));
  assert.deepStrictEqual(data.wheelSlipRatio.map((v) => +v.toFixed(2)), [0.1, 0.2, -0.3, 0]);
  assert.deepStrictEqual(data.wheelSlipAngle.map((v) => +v.toFixed(2)), [0, 0, 0.15, 0.15]);
});

// Drives one lap through a single corner: braking from 1000m, released at
// 1100m, back on the power to 1300m. `entry`/`exit` override wheel slip.
function driveCorner(tracker, lapNum, { entrySlip, exitSlip, exitAngle, neutralised = false } = {}) {
  const zero = [0, 0, 0, 0];
  for (let d = 900; d <= 1300; d += 10) {
    const braking = d >= 1000 && d < 1100;
    tracker.update({
      lapData: { lapDistance: d, currentLapNum: lapNum, pitStatus: 0 },
      telemetry: { brake: braking ? 0.9 : 0, throttle: braking ? 0 : 1, speed: braking ? 200 : 150, steer: d > 1100 && d < 1200 ? 0.4 : 0 },
      motionEx: {
        wheelSlipRatio: braking && entrySlip ? entrySlip : !braking && d > 1100 && exitSlip ? exitSlip : zero,
        wheelSlipAngle: !braking && d > 1100 && exitAngle ? exitAngle : [0.02, 0.02, 0.02, 0.02],
      },
      trackLengthM: 5000,
      neutralised,
    });
  }
}

test('balance: a lockup on one lap is noise, on two of three laps it is an issue', () => {
  const t = createCarBalanceTracker();
  driveCorner(t, 5, { entrySlip: [0, 0, -0.6, 0] });
  assert.deepStrictEqual(t.issues(), []);
  driveCorner(t, 6);
  driveCorner(t, 7, { entrySlip: [0, 0, -0.6, 0] });
  assert.deepStrictEqual(t.issues(), [{ corner: 1, distM: 1000, type: 'frontLock', wheel: 'FL', laps: 2 }]);
});

test('balance: a fixed issue ages out even if that corner records nothing new', () => {
  const t = createCarBalanceTracker();
  driveCorner(t, 3, { entrySlip: [0, 0, -0.6, 0] });
  driveCorner(t, 4, { entrySlip: [0, 0, -0.6, 0] });
  assert.strictEqual(t.issues().length, 1);
  // Bias moved - laps 5 and 6 are clean through that corner.
  driveCorner(t, 5);
  driveCorner(t, 6);
  assert.deepStrictEqual(t.issues(), []);
});

test('balance: exit wheelspin and understeer, and nothing learned under a safety car', () => {
  const t = createCarBalanceTracker();
  for (const lap of [1, 2]) driveCorner(t, lap, { exitSlip: [0.6, 0.6, 0, 0] });
  assert.strictEqual(t.issues()[0].type, 'spin');

  const u = createCarBalanceTracker();
  for (const lap of [1, 2]) driveCorner(u, lap, { exitAngle: [0.03, 0.03, 0.15, 0.15] });
  assert.strictEqual(u.issues()[0].type, 'understeer');

  const sc = createCarBalanceTracker();
  for (const lap of [1, 2]) driveCorner(sc, lap, { entrySlip: [-0.6, -0.6, -0.6, -0.6], neutralised: true });
  assert.deepStrictEqual(sc.issues(), []);
});

const player = (ersPct, { mode = 1, bias = 56, diff = 60, history = [] } = {}) => ({
  status: { frontBrakeBias: bias, ersStoreEnergy: (ersPct / 100) * 4e6, ersDeployMode: mode },
  setup: { onThrottle: diff, brakeBias: bias },
  ersHistory: history,
});
const ers = (args) => computeAdjustments({ issues: [], ...args }).suggestions.find((s) => s.kind === 'ers');

test('ERS: attack, defend, harvest, empty it on the last lap', () => {
  assert.match(ers({ player: player(70), gapAheadMs: 800 }).why, /^Attack - 0\.8s to the car ahead, battery ~70%/);
  assert.strictEqual(ers({ player: player(70), gapAheadMs: 800 }).action, 'ERS: Overtake');
  // Already in Overtake: nothing to change.
  assert.strictEqual(ers({ player: player(70, { mode: 3 }), gapAheadMs: 800 }), undefined);
  assert.strictEqual(ers({ player: player(30), gapAheadMs: 800 }).action, 'ERS: Medium');
  assert.match(ers({ player: player(50), gapBehindMs: 600 }).why, /^Defend/);
  assert.match(ers({ player: player(40), lapsLeft: 0.8 }).radio, /Last lap - empty the battery/);
  assert.match(ers({ player: player(60), neutralised: 'VSC' }).radio, /VSC - ERS to None and recharge/);
});

test('balance: changing the setting forgets the laps driven before it', () => {
  const t = createCarBalanceTracker();
  driveCorner(t, 3, { exitSlip: [0.6, 0.6, 0, 0], entrySlip: [0, 0, -0.6, 0] });
  driveCorner(t, 4, { exitSlip: [0.6, 0.6, 0, 0], entrySlip: [0, 0, -0.6, 0] });
  assert.deepStrictEqual(t.issues().map((i) => i.type).sort(), ['frontLock', 'spin']);
  t.forget(['spin', 'understeer']); // diff changed
  assert.deepStrictEqual(t.issues().map((i) => i.type), ['frontLock']);
});

test('ERS: a draining battery that will not last to the flag', () => {
  const history = [{ lapNum: 10, energyJ: 2.8e6 }, { lapNum: 11, energyJ: 2.4e6 }]; // -10%/lap
  assert.strictEqual(batteryTrend(history), -10);
  const s = ers({ player: player(60, { mode: 2, history }), lapsLeft: 12 });
  assert.strictEqual(s.action, 'ERS: Medium');
  assert.match(s.why, /Dropping 10%\/lap - empty in ~6 laps/);
  // Enough battery for the laps that are left: no call.
  assert.strictEqual(ers({ player: player(60, { mode: 2, history }), lapsLeft: 4 }), undefined);
  // A lap that ended under the VSC (recharging) isn't a deployment trend.
  assert.strictEqual(batteryTrend([...history, { lapNum: 12, energyJ: 3.2e6, neutralised: true }]), -10);
});

test('balance suggestions: which way to move bias and diff, and by how much', () => {
  const issue = (corner, type, wheel = null) => ({ corner, distM: corner * 1000, type, wheel, laps: 2 });
  const sugg = (issues) => computeAdjustments({ player: player(60), issues }).suggestions;
  assert.deepStrictEqual(sugg([issue(2, 'frontLock', 'FL')]).map((s) => [s.action, s.where]), [['Bias 56 → 54%', 'Corner 2 (2.0 km)']]);
  assert.strictEqual(sugg([issue(4, 'rearLock', 'Rears')])[0].action, 'Bias 56 → 58%');
  assert.strictEqual(sugg([issue(1, 'spin')])[0].action, 'Diff 60 → 55%');
  assert.strictEqual(sugg([issue(3, 'understeer')])[0].action, 'Diff 60 → 65%');
  // One corner wants less diff, another more: both are marked per-corner.
  const mixed = sugg([issue(1, 'spin'), issue(3, 'understeer')]);
  assert.deepStrictEqual(mixed.map((s) => s.where), ['Corner 1 (1.0 km) exit only', 'Corner 3 (3.0 km) exit only']);
  // Front locking everywhere: move the base bias once instead of per corner.
  const all = sugg([issue(1, 'frontLock'), issue(2, 'frontLock'), issue(5, 'frontLock')]);
  assert.deepStrictEqual(all.map((s) => s.action), ['Base bias 56 → 55%']);
});
