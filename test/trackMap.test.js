const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');
const { createPipeline } = require('../src/pipeline');
const enc = require('../src/sim/encoders');

// The track map widget: the outline the bridge learned, and every car on it, you highlighted, the ones ahead and behind
// told apart. It is a widget for Custom screens (and any preset a user builds), not part of the six screens.
const base = () => raceSnapshots().find((s) => s.player && s.analysis);
const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
const car = (idx, x, z, position, over = {}) => ({ idx, x, z, position, you: false, pit: false, ...over });
const map = (over = {}) => ({ trackId: 10, outline: square, cars: [car(0, 0, 0, 1), car(1, 100, 0, 2, { you: true }), car(2, 100, 100, 3, { pit: true })], ...over });
const custom = (t, snap) => {
  const app = open(t, { storage: { 'raceEngineer.customs': [{ layout: '2x2', widgets: ['map', 'call', 'radio', 'pace'] }] } });
  app.connect();
  app.send({ ...base(), connected: true, ...snap });
  [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === 'Custom').click();
  return app;
};
const dots = (app) => [...app.window.document.querySelectorAll('.w-map__car')];

test('map widget: the outline is drawn and each car is a dot, you in your colour, ahead and behind told apart', (t) => {
  const app = custom(t, { map: map() });
  const doc = app.window.document;
  assert.strictEqual(doc.querySelectorAll('.w-map__seg').length, square.length, 'one stretch of track per outline point');
  const d = dots(app);
  assert.strictEqual(d.length, 3);
  const you = d.find((x) => x.classList.contains('is-you'));
  assert.ok(you, 'you are marked');
  assert.strictEqual(d.filter((x) => x.classList.contains('is-ahead')).length, 1, 'position 1 is ahead of you in 2nd');
  assert.strictEqual(d.filter((x) => x.classList.contains('is-behind')).length, 1);
  assert.strictEqual(d.filter((x) => x.classList.contains('is-pit')).length, 1);
  assert.strictEqual(d[d.length - 1], you, 'you are drawn last, on top');
  assert.deepStrictEqual(app.errors, []);
});

test('map widget: dots follow the cars between snapshots and cars that leave are dropped', (t) => {
  const app = custom(t, { map: map() });
  const x0 = dots(app)[0].getAttribute('cx');
  app.send({ ...base(), connected: true, map: map({ cars: [car(0, 50, 50, 1), car(1, 100, 0, 2, { you: true })] }) });
  assert.strictEqual(dots(app).length, 2);
  assert.notStrictEqual(dots(app)[0].getAttribute('cx'), x0);
  assert.deepStrictEqual(app.errors, []);
});

test('map widget: before the first clean lap it says how the track gets drawn, and nothing breaks without a map', (t) => {
  const app = custom(t, { map: map({ outline: null }) });
  assert.match(app.window.document.querySelector('.w-map').textContent, /first clean lap/i);
  assert.strictEqual(dots(app).length, 0, 'with no outline there is nothing to place the cars on');
  const none = custom(t, { map: null });
  assert.match(none.window.document.querySelector('.w-map').textContent, /first clean lap/i);
  assert.deepStrictEqual(app.errors.concat(none.errors), []);
});

test('map widget: the outline rides once a second, so the page keeps it between snapshots and drops it on another track', (t) => {
  const app = custom(t, { map: map() });
  app.send({ ...base(), connected: true, map: { trackId: 10, cars: [car(1, 100, 0, 2, { you: true })] } }); // no outline this tick
  assert.strictEqual(app.window.document.querySelectorAll('.w-map__seg').length, square.length, 'kept');
  app.send({ ...base(), connected: true, map: { trackId: 11, cars: [car(1, 5, 5, 2, { you: true })] } });
  assert.match(app.window.document.querySelector('.w-map').textContent, /first clean lap/i, 'another track: not the old outline');
});

test('map widget: the outline arriving again each second (a new copy off the wire) does not rebuild the track; another track does', (t) => {
  const app = custom(t, { map: map() });
  const seg0 = app.window.document.querySelector('.w-map__seg');
  app.send({ ...base(), connected: true, map: map({ outline: square.map((p) => [...p]) }) });
  assert.strictEqual(app.window.document.querySelector('.w-map__seg'), seg0, 'the same track: the same elements');
  const other = [[0, 0], [50, 0], [50, 50]];
  app.send({ ...base(), connected: true, map: map({ trackId: 11, outline: other }) });
  assert.strictEqual(app.window.document.querySelectorAll('.w-map__seg').length, other.length, 'another track is drawn');
  assert.deepStrictEqual(app.errors, []);
});

// Where the time goes (16 Nov 2026: "the track map is useless, it should show where you are losing time").
// 25 mini-sectors over 240 outline points: point i's stretch is mini-sector floor((i + 0.5) / 240 * 25).
const ring = Array.from({ length: 240 }, (_, i) => [Math.cos((i / 240) * 2 * Math.PI) * 100, Math.sin((i / 240) * 2 * Math.PI) * 100]);
const sectors = (o) => Array.from({ length: 25 }, (_, k) => o[k] || 0);
const loss = {
  laps: { lapNum: 9, sectors: sectors({ 2: 200 }), worst: { sector: 2, ms: 200, corner: 3 } },
  ahead: { name: 'GASLY', sectors: sectors({ 20: 150, 5: -90 }), worst: { sector: 20, ms: 150, corner: 14 } },
};
const segClass = (app, i) => app.window.document.querySelectorAll('.w-map__seg')[i].getAttribute('class');

test('map widget: the track is red where you lose time to the car ahead and green where you gain, and says where most went', (t) => {
  const app = custom(t, { map: map({ outline: ring, loss }) });
  const doc = app.window.document;
  assert.match(segClass(app, 200), /is-lost/, 'slice 20 (points 192-201)');
  assert.match(segClass(app, 50), /is-gained/, 'slice 5');
  assert.doesNotMatch(segClass(app, 100), /is-lost|is-gained/, 'even: grey');
  assert.match(doc.querySelector('.w-map__sum').textContent, /^0\.06s slower than GASLY - most lost into turn 14 \(0\.15s\)$/);
  assert.deepStrictEqual(app.errors, []);
});

test('map widget: "Your laps" shows the last lap against the ones before, and the pick holds between snapshots', (t) => {
  const app = custom(t, { map: map({ outline: ring, loss }) });
  const doc = app.window.document;
  [...doc.querySelectorAll('.w-map__modes .tool')].find((b) => b.textContent === 'Your laps').click();
  assert.match(segClass(app, 22), /is-lost/, 'slice 2 (points 20-28)');
  assert.doesNotMatch(segClass(app, 200), /is-lost/);
  assert.match(doc.querySelector('.w-map__sum').textContent, /turn 3/);
  app.send({ ...base(), connected: true, map: { trackId: 10, cars: [car(1, 100, 0, 2, { you: true })] } }); // between the once-a-second ones
  assert.match(segClass(app, 22), /is-lost/, 'kept');
  assert.strictEqual(doc.querySelector('.w-map__modes .is-active').textContent, 'Your laps');
  assert.deepStrictEqual(app.errors, []);
});

test('map widget: with nothing to compare yet it says what it needs, and the track stays grey', (t) => {
  const app = custom(t, { map: map({ outline: ring, loss: { laps: null, ahead: null } }) });
  assert.match(app.window.document.querySelector('.w-map__sum').textContent, /clean lap/i);
  assert.ok([...app.window.document.querySelectorAll('.w-map__seg')].every((x) => x.getAttribute('class') === 'w-map__seg'));
  assert.deepStrictEqual(app.errors, []);
});

test('pipeline: with no session packet yet there is no map, and a Motion packet alone does not break the tick', () => {
  let t = 1_000_000;
  const p = createPipeline({ now: () => t });
  const H = { sessionUID: 7n, sessionTime: 10, frameIdentifier: 1, playerCarIndex: 1 };
  p.feed(enc.encodeMotion(H, Array.from({ length: 22 }, (_, i) => (i < 3 ? { x: i * 10 + 5, z: 7 } : {}))));
  t += 100;
  assert.strictEqual(p.tick().map, null);
});

test('pipeline: driving a clean lap round a circle (Session, Lap Data, Telemetry and Motion packets) draws the outline on the snapshot', () => {
  let t = 1_000_000;
  const p = createPipeline({ now: () => t });
  const LENGTH = 6283;
  const H = (n) => ({ sessionUID: 9n, sessionTime: n / 10, frameIdentifier: n, overallFrameIdentifier: n, playerCarIndex: 0 });
  let n = 0;
  const step = (d) => {
    n++;
    const a = (d / LENGTH) * 2 * Math.PI;
    p.feed(enc.encodeSession(H(n), { trackId: 10, trackLength: LENGTH, totalLaps: 5, sessionType: 15 }));
    p.feed(enc.encodeLapData(H(n), [{ carPosition: 1, currentLapNum: 2, lapDistance: d, totalDistance: d, pitStatus: 0, driverStatus: 4, resultStatus: 2 }]));
    p.feed(enc.encodeCarTelemetry(H(n), [{ speed: 220 }]));
    p.feed(enc.encodeMotion(H(n), [{ x: 1000 * Math.cos(a), z: 1000 * Math.sin(a) }]));
    t += 100;
    return p.tick();
  };
  let withOutline = null;
  for (let d = 0; d < LENGTH; d += 20) step(d);
  for (let i = 0; i < 12; i++) {
    const s = step(5 + i);
    if (s.map && s.map.outline) withOutline = s.map;
  }
  assert.ok(withOutline, 'the outline arrives on the once-a-second tick');
  assert.strictEqual(withOutline.outline.length, 240);
  assert.strictEqual(withOutline.cars.length, 1);
  assert.strictEqual(withOutline.cars[0].you, true);
  assert.deepStrictEqual(withOutline.loss, { laps: null, ahead: null }, 'the loss rides with the outline; one lap is nothing to compare');
});
