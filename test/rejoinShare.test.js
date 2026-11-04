const test = require('node:test');
const assert = require('node:assert');
const { predictRejoin, REJOIN_LOSS_SHARE } = require('../src/engine/raceAnalysis');

// M5 / U2. "If you box now" is scored against where the car is 25 s after the stop, when only part of
// the stop's loss has been paid (the out-lap has hardly begun). On 79 recorded stops, charging the whole
// loss put the car 1.66 places too far back; charging three quarters of it, to the player and to the cars
// due to stop alike, takes that to 0.11 (held out race by race: 0.54) with the error down from 3.13 to
// 2.80 places. And a stop's cost isn't known to the second, so the prediction carries the range of places
// the measured losses' own scatter allows.

const car = (i, pos, gapMs) => ({ carIndex: i, lapData: { carPosition: pos, deltaToRaceLeaderInMS: gapMs, pitStatus: 0, resultStatus: 2 } });
const field = (...gaps) => gaps.map((g, i) => car(i, i + 1, g));
const S = 1000;

test('rejoin share: the share is three quarters, from the recorded stops', () => {
  assert.strictEqual(REJOIN_LOSS_SHARE, 0.75);
});

test('rejoin share: with the default the loss is charged whole, as it always was', () => {
  // Us: 20 s behind. A 20 s stop is 40 s: everyone is ahead (0, 10, 15, 33, 36).
  const ordered = field(0, 10 * S, 15 * S, 20 * S, 33 * S, 36 * S);
  assert.strictEqual(predictRejoin(ordered, ordered[3], 20 * S).position, 6);
});

test('rejoin share: a share of the loss is charged - 20 s at three quarters is 15 s, which clears the car at 36 s', () => {
  const ordered = field(0, 10 * S, 15 * S, 20 * S, 33 * S, 36 * S);
  const r = predictRejoin(ordered, ordered[3], 20 * S, { share: 0.75 });
  assert.strictEqual(r.position, 5); // behind 0, 10, 15 and 33; ahead of 36
  assert.strictEqual(r.behind.carIndex, 5);
});

test('rejoin share: the cars due to stop pay the same share', () => {
  // Us at 6 s (P3); car 1 at 2 s is due now. A 20 s stop at three quarters: we're at 21 s, it's out at 17 s - ahead.
  // Had the player paid three quarters but the car its whole 20 s it would be at 22 s, behind us (P2).
  const ordered = field(0, 2 * S, 6 * S);
  const stopIn = new Map([[1, 0]]);
  assert.strictEqual(predictRejoin(ordered, ordered[2], 20 * S, { share: 0.75, stopIn }).position, 3);
});

test('rejoin share: a time penalty served at the stop is paid in full, not in shares', () => {
  // Us at 10 s. 20 s at three quarters is 15 s; a 5 s penalty makes it 20 s: we're at 30 s, and the car at
  // 29.5 s is ahead. Had the penalty been scaled too (3.75 s) we'd be at 28.75 s, ahead of it.
  const ordered = field(0, 10 * S, 29.5 * S);
  assert.strictEqual(predictRejoin(ordered, ordered[1], 20 * S, { share: 0.75, extraMs: 5 * S }).position, 3);
});

test('rejoin range: a stop that runs short or long moves you up or down the places it allows', () => {
  // Us at 20 s; 20 s at three quarters puts us at 35 s. A 3 s scatter in the loss, 1.28 of it at three
  // quarters, is 2.88 s: 32.12 s (behind 30 s: P4) to 37.88 s (behind 36 s: P6), P5 between.
  const ordered = field(0, 10 * S, 20 * S, 30 * S, 33 * S, 36 * S, 40 * S);
  const r = predictRejoin(ordered, ordered[2], 20 * S, { share: 0.75, spreadMs: 3 * S });
  assert.deepStrictEqual([r.position, r.range.best, r.range.worst], [5, 4, 6]);
});

test('rejoin range: with no scatter to speak of the range is the place', () => {
  const ordered = field(0, 10 * S, 20 * S, 30 * S);
  const r = predictRejoin(ordered, ordered[2], 20 * S, { share: 0.75 });
  assert.deepStrictEqual(r.range, { best: r.position, worst: r.position });
});

test('rejoin range: always holds the place, however wide', () => {
  const ordered = field(0, 4 * S, 9 * S, 12 * S, 20 * S, 31 * S, 33 * S, 50 * S);
  for (const spread of [0, 500, 2000, 6000, 20000]) {
    const r = predictRejoin(ordered, ordered[4], 20 * S, { share: 0.75, spreadMs: spread });
    assert.ok(r.range.best <= r.position && r.position <= r.range.worst, `spread ${spread}: ${JSON.stringify(r.range)} vs P${r.position}`);
  }
});

// --- The card shows it ---
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { syntheticPackets, replay } = require('./helpers/synthetic');

function rejoinCard() {
  const dom = new JSDOM('<!doctype html><body><div id="m"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const file = path.join(__dirname, '..', 'public', 'widgets.js');
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInContext(dom.getInternalVMContext());
  const root = dom.window.document.getElementById('m');
  return { root, update: dom.window.RaceWidgets.widgets.rejoin.mount(root) };
}
function withRejoin(patch) {
  let snap = null;
  replay(syntheticPackets(), { onTick: ({ snap: s }) => { if (!snap && s.analysis && s.analysis.rejoin) snap = JSON.parse(JSON.stringify(s)); } });
  assert.ok(snap, 'the synthetic race has a rejoin prediction');
  Object.assign(snap.analysis.rejoin, patch);
  return snap;
}

test('rejoin card: the places a stop could give are shown as pips, the predicted one filled', () => {
  const { root, update } = rejoinCard();
  update(withRejoin({ position: 5, range: { best: 4, worst: 7 } }));
  const pips = [...root.querySelectorAll('.w-rejoin__pip')];
  assert.deepStrictEqual(pips.map((p) => p.textContent), ['P4', 'P5', 'P6', 'P7']);
  assert.deepStrictEqual(pips.filter((p) => p.classList.contains('is-mid')).map((p) => p.textContent), ['P5']);
  assert.strictEqual(root.querySelector('.w-rejoin__range').hidden, false);
});

test('rejoin card: one place only, nothing to show - and the pips come and go with the prediction', () => {
  const { root, update } = rejoinCard();
  update(withRejoin({ position: 5, range: { best: 5, worst: 5 } }));
  assert.strictEqual(root.querySelector('.w-rejoin__range').hidden, true);
  update(withRejoin({ position: 5, range: { best: 3, worst: 6 } }));
  assert.strictEqual(root.querySelectorAll('.w-rejoin__pip').length, 4);
  update(withRejoin({ position: 5, range: { best: 5, worst: 5 } }));
  assert.strictEqual(root.querySelector('.w-rejoin__range').hidden, true);
});

test('the live analysis carries the range, and a pit loss with the scatter it came from', () => {
  let seen = null;
  replay(syntheticPackets(), { onTick: ({ snap }) => { if (snap.analysis && snap.analysis.rejoin) seen = snap.analysis; } });
  assert.ok(seen.rejoin.range.best <= seen.rejoin.position && seen.rejoin.position <= seen.rejoin.range.worst);
  assert.ok(seen.pitLoss.spreadMs >= 500, JSON.stringify(seen.pitLoss));
});
