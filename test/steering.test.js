const test = require('node:test');
const assert = require('node:assert');
const { analyzeSteering } = require('../src/llm/steering');

// Oversteer and understeer from the steering you did (roadmap L8). The game sends no yaw or lateral load in
// the stored laps, but it does keep your steering, speed and pedals every few metres, and a car that slides
// shows in what the driver does about it: more lock for less speed is understeer; a big catch of
// countersteer is oversteer, and whether it came on or off the throttle says which setting is involved.
// Everything is read against your OWN usual at that corner, so a corner whose exit simply turns the other
// way (a switchback) isn't a slide, and only what repeats is called the car.
//
// A synthetic 3 km lap in 5 m steps, two corners: corner 1 (brake 500 m, apex 600 m) is the one the tests
// change; corner 2 (apex 1600 m) always has the same big natural swing the other way after the apex.
const STEP = 5;
const N = 601;
const CORNERS = [{ corner: 1, atM: 500, apexAtM: 600 }, { corner: 2, atM: 1500, apexAtM: 1600 }];

function makeLap({ lock = 0.4, minV = 100, counter = 0, counterThrottle = 0.8, counterAtM = 650 } = {}) {
  const r = { d: [], t: [], speed: [], throttle: [], brake: [], steer: [] };
  let t = 0;
  for (let k = 0; k < N; k++) {
    const d = k * STEP;
    const tri = (centre, half) => Math.max(0, 1 - Math.abs(d - centre) / half);
    let steer = lock * tri(600, 60) + 0.3 * tri(1600, 60) - 0.25 * tri(1670, 20); // corner 2: always swings back 0.25
    steer -= counter * tri(counterAtM, 20);
    const speed = 250 - (250 - minV) * tri(600, 100) - (250 - 100) * tri(1600, 100) * (d < 1600 ? 1 : 1);
    const braking = d >= 500 && d <= 580;
    r.d.push(d);
    r.t.push(t);
    r.speed.push(speed);
    r.throttle.push(braking ? 0 : d > 600 && d < 680 ? counterThrottle : 1);
    r.brake.push(braking ? 1 : 0);
    r.steer.push(steer);
    t += (STEP / (speed / 3.6)) * 1000;
  }
  return r;
}
const lapsOf = (specs) => specs.map((s, i) => ({ lap: i + 2, r: makeLap(s) }));
const usual = (n) => Array.from({ length: n }, () => ({}));
const wobble = [0, 0.01, -0.01, 0.005, -0.005, 0.01, 0, -0.01, 0.005, -0.005]; // honest lap-to-lap scatter

function analyse(specs, extra = {}) {
  return analyzeSteering({ laps: lapsOf(specs.map((s, i) => ({ lock: 0.4 + wobble[i % 10], ...s }))), corners: CORNERS, ...extra });
}

test('steering: ten ordinary laps show nothing, and a corner that always swings back is not a slide', () => {
  const r = analyse(usual(10));
  assert.strictEqual(r.enough, true);
  assert.deepStrictEqual(r.corners, []);
  assert.match(r.text, /No corner showed steering out of the ordinary/);
  assert.deepStrictEqual(r.advice, []);
});

test('steering: more lock for less speed, lap after lap, is understeer at that corner, and it cost time', () => {
  const specs = usual(10);
  for (const i of [2, 4, 6, 8]) specs[i] = { lock: 0.52, minV: 95 };
  const r = analyse(specs);
  const c = r.corners.find((x) => x.corner === 1);
  assert.deepStrictEqual(c.understeer.laps, [4, 6, 8, 10]);
  assert.ok(c.understeer.lost_s > 0.05, `those laps lost ${c.understeer.lost_s} s`);
  assert.deepStrictEqual(c.habits, ['understeer']);
  assert.match(r.text, /Understeer, corner 1 \(0\.6 km\).*laps 4, 6, 8 and 10.*more steering lock than usual.*less speed/);
  assert.ok(!r.corners.some((x) => x.corner === 2), 'corner 2\'s natural swing-back is its usual');
});

test('steering: more lock at normal speed is just a different line, not understeer', () => {
  const specs = usual(10);
  for (const i of [2, 4, 6, 8]) specs[i] = { lock: 0.52, minV: 100 };
  assert.deepStrictEqual(analyse(specs).corners, []);
});

test('steering: a big catch of countersteer on the throttle, repeated, is oversteer on power', () => {
  const specs = usual(10);
  for (const i of [1, 3, 5]) specs[i] = { counter: 0.3, counterThrottle: 0.8 };
  const r = analyse(specs);
  const c = r.corners.find((x) => x.corner === 1);
  assert.deepStrictEqual(c.oversteer_power.laps, [3, 5, 7]);
  assert.strictEqual(c.oversteer_off.laps.length, 0);
  assert.deepStrictEqual(c.habits, ['oversteer_power']);
  assert.match(r.text, /Oversteer on the throttle, corner 1.*laps 3, 5 and 7.*countersteer.*throttle was 80%/);
});

test('steering: the same catch off the throttle is oversteer off power (entry or lift), a different setting', () => {
  const specs = usual(10);
  for (const i of [1, 3, 5]) specs[i] = { counter: 0.3, counterThrottle: 0.1 };
  const c = analyse(specs).corners.find((x) => x.corner === 1);
  assert.deepStrictEqual(c.oversteer_off.laps, [3, 5, 7]);
  assert.strictEqual(c.oversteer_power.laps.length, 0);
});

test('steering: once is a mistake, not the car - a one-off is listed apart from the habits', () => {
  const specs = usual(10);
  specs[4] = { counter: 0.35 };
  const r = analyse(specs);
  const c = r.corners.find((x) => x.corner === 1);
  assert.deepStrictEqual(c.habits, []);
  assert.deepStrictEqual(r.advice, [], 'no setup advice for a single lap');
  assert.match(r.text, /one-off.*lap 6.*corner 1/i);
});

test('steering: a correction only a little bigger than usual is not a slide', () => {
  const specs = usual(10);
  for (const i of [1, 3, 5]) specs[i] = { counter: 0.1 };
  assert.deepStrictEqual(analyse(specs).corners, []);
});

test('steering: too few laps to tell a habit from a one-off says so, not a guess', () => {
  const r = analyse(usual(3));
  assert.strictEqual(r.enough, false);
  assert.match(r.text, /at least 5 laps with telemetry.*you have 3/i);
  assert.deepStrictEqual(r.corners, []);
});

// --- Advice: only what the guides agree on, as things to test, with your current setting ---
test('advice: understeer - front wing, a lower off-throttle diff for rotation, a driving fix first; no on-throttle direction', () => {
  const specs = usual(10);
  for (const i of [2, 4, 6, 8]) specs[i] = { lock: 0.52, minV: 95 };
  const r = analyse(specs, { setting: { brake_bias: 57, diff_on_throttle: 100, diff_off_throttle: 50 } });
  const text = r.advice.join('\n');
  assert.match(text, /front wing/i);
  assert.match(text, /lower off-throttle diff.*rotate/i);
  assert.match(text, /now 50%/);
  assert.match(text, /brake a little earlier/i);
  assert.doesNotMatch(text, /(raise|lower|increase|reduce) the on-throttle/i, 'the guides disagree on the on-throttle direction: it is not told');
});

test('advice: oversteer on power - rear wing, a gentler throttle at the throttle seen, and the on-throttle diff as a test either way', () => {
  const specs = usual(10);
  for (const i of [1, 3, 5]) specs[i] = { counter: 0.3, counterThrottle: 0.8 };
  const r = analyse(specs, { setting: { diff_on_throttle: 100 } });
  const text = r.advice.join('\n');
  assert.match(text, /rear wing/i);
  assert.match(text, /guides disagree.*on-throttle diff.*one step each way/i);
  assert.match(text, /80%/);
});

test('advice: oversteer off power - a higher off-throttle diff steadies it, and a rear lock points at the brake bias', () => {
  const specs = usual(10);
  for (const i of [1, 3, 5]) specs[i] = { counter: 0.3, counterThrottle: 0.1 };
  const r = analyse(specs, { setting: { diff_off_throttle: 50 }, issues: [{ lap_num: 5, distance_m: 640, kind: 'rear_lock', wheel: 'RL' }] });
  const text = r.advice.join('\n');
  assert.match(text, /higher off-throttle diff.*steadier/i);
  assert.match(text, /now 50%/);
  assert.match(text, /rear wheel also locked.*brake bias/i);
});

test('advice: every set of suggestions ends with the honest caution', () => {
  const specs = usual(10);
  for (const i of [2, 4, 6, 8]) specs[i] = { lock: 0.52, minV: 95 };
  const r = analyse(specs);
  assert.match(r.text, /guides disagree on some directions.*one thing at a time.*three laps/i);
});

test('wheel slip that agrees is said: an understeer or wheelspin flagged by the car data on the same lap and corner', () => {
  const specs = usual(10);
  for (const i of [2, 4, 6, 8]) specs[i] = { lock: 0.52, minV: 95 };
  const r = analyse(specs, { issues: [{ lap_num: 6, distance_m: 640, kind: 'understeer', wheel: null }] });
  assert.match(r.text, /wheel-slip data.*lap 6/i);
});
