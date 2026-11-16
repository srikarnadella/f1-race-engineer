const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');

// The dashboard in qualifying: while the session is qualifying (or a sprint shootout) the live screens are Lap,
// Order and Plan instead of Drive, Battle, Strategy and Weather, and they go back when the session is a race.
const base = () => raceSnapshots().find((s) => s.player && s.analysis);
const tabs = (app) => [...app.window.document.querySelectorAll('.tab')].map((b) => b.lastChild.textContent);

const order = [
  { name: 'LECLERC', isPlayer: false, position: 1, bestMs: 105000, gapMs: 0, status: 'garage', compound: 16, cutLine: false },
  { name: 'YOU', isPlayer: true, position: 2, bestMs: 105400, gapMs: 400, status: 'flying', compound: 16, cutLine: false },
  { name: 'HAMILTON', isPlayer: false, position: 3, bestMs: 105900, gapMs: 900, status: 'out', compound: 17, cutLine: true },
  { name: 'ALONSO', isPlayer: false, position: 4, bestMs: 106500, gapMs: 1500, status: 'in', compound: 17, cutLine: false },
  { name: 'GASLY', isPlayer: false, position: null, bestMs: null, gapMs: null, status: 'garage', compound: null, cutLine: false },
];
const quali = (over = {}) => ({
  kind: 'qualifying', name: 'Q1', status: 'flying', lapInvalid: false, timeLeftS: 342, position: 2, bestMs: 105400, poleMs: 105000, gapToPoleMs: 400,
  cut: { position: 3, lineMs: 105900, marginMs: -500 }, projected: { lapMs: 105200, position: 2, improves: true }, lapGone: false, toLine: null, runs: null,
  traffic: { ahead: null, behind: null }, order, pushing: 1, ...over,
});
const withQuali = (q, player = {}) => {
  const s = base();
  return { ...s, connected: true, player: { ...s.player, deltaToBestMs: -200, ...player }, session: { ...(s.session || {}), trackTemperature: 31, airTemperature: 24 }, analysis: { ...s.analysis, quali: q } };
};
const race = () => ({ ...base(), connected: true, analysis: { ...base().analysis, quali: null } });
const text = (app, sel) => (app.window.document.querySelector(sel) || {}).textContent || '';

test('quali mode: the race screens give way to Lap, Order and Plan in a qualifying session, and come back for a race', (t) => {
  const app = open(t);
  app.connect();
  app.send(race());
  assert.deepStrictEqual(tabs(app).filter((l) => !/Home/.test(l)), ['Drive', 'Battle', 'Strategy', 'Weather', 'Custom']);
  assert.strictEqual(app.activeTab(), 'Drive');
  app.send(withQuali(quali()));
  assert.deepStrictEqual(tabs(app).filter((l) => !/Home/.test(l)), ['Lap', 'Order', 'Plan', 'Custom']);
  assert.strictEqual(app.activeTab(), 'Lap', 'the screen you were on means nothing now');
  app.send(race());
  assert.deepStrictEqual(tabs(app).filter((l) => !/Home/.test(l)), ['Drive', 'Battle', 'Strategy', 'Weather', 'Custom']);
  assert.strictEqual(app.activeTab(), 'Drive');
  assert.deepStrictEqual(app.errors, []);
});

test('quali mode: practice keeps the race screens, a sprint shootout counts as qualifying', (t) => {
  const app = open(t);
  app.connect();
  app.send(withQuali(quali({ kind: 'practice', name: 'Practice 1' })));
  assert.ok(tabs(app).includes('Drive') && !tabs(app).includes('Lap'));
  app.send(withQuali(quali({ kind: 'qualifying', name: 'SQ2' })));
  assert.ok(tabs(app).includes('Lap'));
  assert.deepStrictEqual(app.errors, []);
});

test('quali mode: a Custom screen, the Debrief and a screen you are on that exists in both are left alone', (t) => {
  const app = open(t);
  app.connect();
  app.send(race());
  tabs(app);
  [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === 'Custom').click();
  app.send(withQuali(quali()));
  assert.strictEqual(app.activeTab(), 'Custom');
  app.send({ ...race(), focus: { screen: 'debrief', reason: 'Session over' } }); // the Debrief is listed once the session is over
  [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === 'Debrief').click();
  app.send(race());
  assert.strictEqual(app.activeTab(), 'Debrief');
});

test('quali mode: the number keys follow the screens in view', (t) => {
  const app = open(t);
  app.connect();
  app.send(withQuali(quali()));
  const keys = [...app.window.document.querySelectorAll('.tab')].map((b) => [b.querySelector('.tab__key').textContent, b.lastChild.textContent]).filter(([k]) => k);
  const order2 = keys.find(([, l]) => l === 'Order')[0];
  app.press(order2);
  assert.strictEqual(app.activeTab(), 'Order');
});

test('quali mode, Lap: on a push lap the delta is the headline with the place it would give; a deleted lap says so', (t) => {
  const app = open(t);
  app.connect();
  app.send(withQuali(quali(), { deltaToBestMs: -123 }));
  assert.strictEqual(text(app, '.w-ql__hero'), '−0.123');
  assert.match(text(app, '.w-ql__sub'), /would be P2 · a new best/);
  assert.match(text(app, '.w-ql__head'), /Q1.*5:42 left/);
  assert.strictEqual(text(app, '.w-ql__state'), 'Push lap');
  assert.ok(app.window.document.querySelector('.w-ql__hero').classList.contains('is-pb'));
  app.send(withQuali(quali({ projected: { lapMs: 105900, position: 3, improves: false } }), { deltaToBestMs: 500 }));
  assert.strictEqual(text(app, '.w-ql__hero'), '+0.500');
  assert.ok(app.window.document.querySelector('.w-ql__hero').classList.contains('is-watch'));
  app.send(withQuali(quali({ lapInvalid: true })));
  assert.strictEqual(text(app, '.w-ql__hero'), 'Deleted');
  app.send(withQuali(quali({ lapGone: true })));
  assert.strictEqual(text(app, '.w-ql__hero'), 'Lap gone');
  assert.deepStrictEqual(app.errors, []);
});

test('quali mode, Lap: an out lap counts down to the line, the garage shows the runs left, the cut says through or short', (t) => {
  const app = open(t);
  app.connect();
  app.send(withQuali(quali({ status: 'out', projected: null, toLine: { startsInS: 75, spareS: 267, makesIt: true } })));
  assert.strictEqual(text(app, '.w-ql__hero'), '1:15');
  assert.match(text(app, '.w-ql__sub'), /to the line · 4:27 to spare/);
  app.send(withQuali(quali({ status: 'out', projected: null, toLine: { startsInS: 400, spareS: -58, makesIt: false } })));
  assert.match(text(app, '.w-ql__sub'), /flag falls first/);
  app.send(withQuali(quali({ status: 'garage', projected: null, runs: 2 })));
  assert.strictEqual(text(app, '.w-ql__hero'), '5:42');
  assert.match(text(app, '.w-ql__sub'), /time for 2 runs/);
  // 0.500 clear of the cut: through.
  assert.match(text(app, '.w-ql__tiles'), /Cut · P3/);
  assert.match(text(app, '.w-ql__tiles'), /0\.500 clear/);
  app.send(withQuali(quali({ cut: { position: 3, lineMs: 105900, marginMs: 300 } })));
  assert.match(text(app, '.w-ql__tiles'), /0\.300 short/);
  app.send(withQuali(quali({ cut: null })));
  assert.match(text(app, '.w-ql__tiles'), /To P1.*\+0\.400/);
  assert.deepStrictEqual(app.errors, []);
});

test('quali mode, Lap: traffic on the road is named', (t) => {
  const app = open(t);
  app.connect();
  app.send(withQuali(quali({ traffic: { ahead: { name: 'ALONSO', gapS: 2.4, status: 'out' }, behind: null } })));
  assert.match(text(app, '.w-ql__chip'), /Traffic: ALONSO 2\.4 s ahead/);
  app.send(withQuali(quali({ traffic: { ahead: null, behind: { name: 'HAMILTON', gapS: 3, status: 'flying' } } })));
  assert.match(text(app, '.w-ql__chip'), /HAMILTON on a push lap behind/);
});

test('quali mode, Order: every car by best lap, you highlighted, the cars below the cut dimmed, cars with no time last', (t) => {
  const app = open(t);
  app.connect();
  app.send(withQuali(quali()));
  [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === 'Order').click();
  const rows = [...app.window.document.querySelectorAll('.w-qo tbody tr')];
  assert.strictEqual(rows.length, 5);
  assert.deepStrictEqual(rows.map((r) => r.children[1].textContent), ['LECLERC', 'YOU', 'HAMILTON', 'ALONSO', 'GASLY']);
  assert.strictEqual(rows[1].classList.contains('is-player'), true);
  assert.deepStrictEqual(rows.map((r) => r.classList.contains('is-below')), [false, false, false, true, true]);
  assert.strictEqual(rows[2].classList.contains('is-cut'), true);
  assert.strictEqual(rows[1].children[2].textContent, '1:45.400');
  assert.strictEqual(rows[1].children[3].textContent, '+0.400');
  assert.strictEqual(rows[4].children[2].textContent, 'No time');
  assert.strictEqual(rows[4].children[0].textContent, '–');
  assert.match(rows[1].children[4].textContent, /PUSH/);
  assert.deepStrictEqual(app.errors, []);
});

test('quali mode, Plan: the clock, runs, who is on a push lap, the track; a sentence only when there is something to say', (t) => {
  const app = open(t);
  app.connect();
  app.send(withQuali(quali({ status: 'garage', projected: null, runs: 0, timeLeftS: 40, pushing: 6 })));
  [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === 'Plan').click();
  assert.match(text(app, '.w-qp__line'), /No time for another run/);
  assert.match(text(app, '.w-qp__tiles'), /0:40/);
  assert.match(text(app, '.w-qp__tiles'), /6.*of 5 cars/);
  assert.match(text(app, '.w-qp__tiles'), /31°C/);
  app.send(withQuali(quali({ status: 'flying' })));
  assert.strictEqual(text(app, '.w-qp__line'), '');
  app.send(withQuali(quali({ status: 'out', toLine: { startsInS: 400, spareS: -58, makesIt: false } })));
  assert.match(text(app, '.w-qp__line'), /flag falls before you reach the line/);
  assert.deepStrictEqual(app.errors, []);
});

test('quali mode: auto-switch asking for a race screen that is not there does nothing and does not throw', (t) => {
  const app = open(t, { storage: { 'raceEngineer.auto': true } });
  app.connect();
  app.send({ ...withQuali(quali()), focus: { screen: 'battle', reason: 'Car behind within 1 s' } });
  assert.ok(['Lap', 'Order', 'Plan'].includes(app.activeTab()));
  assert.deepStrictEqual(app.errors, []);
});

test('quali mode: the widgets say so, rather than showing blanks, when the session is not qualifying (a Custom screen can hold them)', (t) => {
  const app = open(t, { storage: { 'raceEngineer.customs': [{ layout: '2x2', widgets: ['qlap', 'qorder', 'qplan', 'radio'] }] } });
  app.connect();
  app.send(race());
  [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === 'Custom').click();
  assert.match(text(app, '.w-ql__head'), /Not a qualifying session/);
  assert.match(text(app, '.w-qp__line'), /Not a qualifying session/);
  assert.strictEqual(app.window.document.querySelectorAll('.w-qo tbody tr').length, 0);
  assert.doesNotMatch(app.window.document.querySelector('main').textContent, /undefined|NaN|null/);
  assert.deepStrictEqual(app.errors, []);
});

test('quali mode: a button that asks for Drive (Home\'s Live dashboard, Connect\'s Go to Drive) lands on the first screen of the set in view, not on a blank page', (t) => {
  const app = open(t);
  app.connect();
  app.send(withQuali(quali()));
  assert.strictEqual(app.activeTab(), 'Lap');
  [...app.window.document.querySelectorAll('.tab')].find((b) => b.lastChild.textContent === 'Order').click();
  app.window.document.dispatchEvent(new app.window.CustomEvent('undercut:show', { detail: 'drive' }));
  assert.strictEqual(app.activeTab(), 'Lap');
  assert.ok(app.window.document.querySelector('main').textContent.length > 20, 'something is drawn');
  // and the choice that was saved is one that exists, so the next start is not blank either
  assert.strictEqual(JSON.parse(app.window.localStorage.getItem('raceEngineer.screen')), 'qlap');
  assert.deepStrictEqual(app.errors, []);
  // a screen that exists in both sets is kept as asked
  app.window.document.dispatchEvent(new app.window.CustomEvent('undercut:show', { detail: 'debrief' }));
  assert.notStrictEqual(app.activeTab(), 'Lap');
});

test('quali mode: back in a race, a request for Drive is just Drive', (t) => {
  const app = open(t);
  app.connect();
  app.send(race());
  app.window.document.dispatchEvent(new app.window.CustomEvent('undercut:show', { detail: 'drive' }));
  assert.strictEqual(app.activeTab(), 'Drive');
  assert.deepStrictEqual(app.errors, []);
});
