const test = require('node:test');
const assert = require('node:assert');
const { pairFeatures, featureSpread } = require('../src/ml/overtakeFeatures');
const { passRange } = require('../src/ml/passRange');
const { battleCall } = require('../src/analysis/battleCall');

// A3: the battle calls say how sure they are. The overtake model gives a point chance; its inputs
// (how fast the gap is closing, the pace difference) are read from a few seconds and a few laps of
// noisy data, so the chance carries the range those inputs allow: re-run the model with each input
// moved by what its own noise allows (80%: 1.28 standard errors).

const lap = (ms) => ({ lapMs: ms, pit: false, neutralised: false });
// attacker 0.4 s behind, a car whose gap samples (1 Hz) are given as [t, gapMs].
function pair({ samples, attackerLaps = [90000, 90000, 90000], defenderLaps = [90500, 90500, 90500] }) {
  const attacker = {
    lapData: { carPosition: 5, deltaToCarInFrontInMS: samples[samples.length - 1][1], pitStatus: 0, currentLapNum: 6 },
    status: { tyresAgeLaps: 6, visualTyreCompound: 17, ersStoreEnergy: 2e6 },
    lapHistory: attackerLaps.map(lap),
    gapAheadHistory: samples.map(([t, gapMs]) => ({ t, gapMs })),
    telemetry2: { overtakeAvailable: false },
  };
  const defender = {
    lapData: { carPosition: 4, deltaToCarInFrontInMS: 2000, pitStatus: 0, currentLapNum: 6 },
    status: { tyresAgeLaps: 8, visualTyreCompound: 17, ersStoreEnergy: 2e6 },
    lapHistory: defenderLaps.map(lap),
    gapAheadHistory: [],
    telemetry2: { overtakeAvailable: false },
  };
  return { attacker, defender };
}
// A gap closing 0.1 s every second from 1.2 s, steady vs jittering around the same line.
const steady = [[0, 1200], [1, 1100], [2, 1000], [3, 900], [4, 800], [5, 700], [6, 600]];
const jitter = [[0, 1350], [1, 1000], [2, 1180], [3, 760], [4, 930], [5, 600], [6, 610]];

test('feature spread: a gap that closes in a straight line is a firm closing rate; a jittery one is not', () => {
  const a = pair({ samples: steady });
  const b = pair({ samples: jitter });
  const firm = featureSpread(a.attacker, a.defender);
  const loose = featureSpread(b.attacker, b.defender);
  assert.ok(firm.closingSE < 0.005, `a straight line has no scatter, got ${firm.closingSE}`);
  assert.ok(loose.closingSE > firm.closingSE + 0.02, 'the scatter widens it');
});

test('feature spread: the pace difference is as sure as the laps it comes from', () => {
  const same = pair({ samples: steady, attackerLaps: [90000, 90000, 90000], defenderLaps: [90500, 90500, 90500] });
  const ragged = pair({ samples: steady, attackerLaps: [89000, 91500, 90000], defenderLaps: [90500, 93000, 89500] });
  assert.ok(featureSpread(same.attacker, same.defender).paceSE < 0.01);
  assert.ok(featureSpread(ragged.attacker, ragged.defender).paceSE > 0.5);
  // One clean lap says nothing about its own scatter: wide, not zero.
  const one = pair({ samples: steady, attackerLaps: [90000], defenderLaps: [90500] });
  assert.ok(featureSpread(one.attacker, one.defender).paceSE >= 0.3);
});

test('pass range: always brackets the estimate, and is a point when nothing is uncertain', () => {
  const { attacker, defender } = pair({ samples: jitter });
  const f = pairFeatures(attacker, defender);
  const r = passRange(f, featureSpread(attacker, defender));
  assert.ok(r.lo <= r.p && r.p <= r.hi, JSON.stringify(r));
  const exact = passRange(f, { closingSE: 0, paceSE: 0 });
  assert.deepStrictEqual([exact.lo, exact.hi], [exact.p, exact.p]);
});

test('pass range: the same battle read from noisier data has a wider range', () => {
  const a = pair({ samples: steady });
  const b = pair({ samples: jitter });
  const ra = passRange(pairFeatures(a.attacker, a.defender), featureSpread(a.attacker, a.defender));
  const rb = passRange(pairFeatures(b.attacker, b.defender), featureSpread(b.attacker, b.defender));
  assert.ok(rb.hi - rb.lo > ra.hi - ra.lo, `steady ${ra.hi - ra.lo}, jittery ${rb.hi - rb.lo}`);
});

test('pass range: levels follow the model\'s own thresholds, and a range that crosses one says so', () => {
  const r = passRange({ logGap: Math.log(0.45), within05: 1, closingSPerS: 0.1, paceDeltaS: 0.5, tyreAgeDelta: 2, softerTyre: 0, ersDelta: 0, overtakeMode: 0, lapOne: 0 }, { closingSE: 0.15, paceSE: 0.6 });
  assert.ok(['low', 'medium', 'high'].includes(r.levelLo) && ['low', 'medium', 'high'].includes(r.levelHi));
  const order = { low: 0, medium: 1, high: 2 };
  assert.ok(order[r.levelLo] <= order[r.level] && order[r.level] <= order[r.levelHi]);
});

// --- The call says it ---
const row = (name, trend = 0) => ({ name, gapTrendMsPerLap: trend, pitStatus: 0 });
const chance = (p, level, lo, hi, levelLo, levelHi) => ({ p, level, range: { lo, hi, levelLo, levelHi } });

test('battle call: a pass chance that could be one level or the next is called as a range, and the call is marked soft', () => {
  const c = battleCall({ ahead: row('NORRIS'), gapAheadS: 0.8, battle: { attack: chance(0.2, 'medium', 0.08, 0.34, 'low', 'high') }, batteryPct: 70 });
  assert.strictEqual(c.mode, 'ATTACK');
  assert.match(c.reason, /pass chance low to high/);
  assert.strictEqual(c.confidence, 'soft');
});

test('battle call: a firm pass chance is named once, and the call is firm', () => {
  const c = battleCall({ ahead: row('NORRIS'), gapAheadS: 0.8, battle: { attack: chance(0.4, 'high', 0.3, 0.5, 'high', 'high') }, batteryPct: 70 });
  assert.match(c.reason, /pass chance high/);
  assert.doesNotMatch(c.reason, / to /);
  assert.strictEqual(c.confidence, 'firm');
});

test('battle call: a threat behind carries its range too', () => {
  const c = battleCall({ behind: row('SAINZ', -300), gapBehindS: 0.7, battle: { defend: chance(0.15, 'medium', 0.05, 0.3, 'low', 'high') } });
  assert.strictEqual(c.mode, 'DEFEND');
  assert.match(c.reason, /threat low to high/);
  assert.strictEqual(c.confidence, 'soft');
});

test('battle call: with no range (an older snapshot, the demo) the words are as they were', () => {
  const c = battleCall({ ahead: row('NORRIS'), gapAheadS: 0.6, battle: { attack: { p: 0.15, level: 'medium' } }, batteryPct: 70 });
  assert.strictEqual(c.reason, 'pass chance medium');
  assert.strictEqual(c.confidence, 'firm');
});

test('battle call: sandwiched between two chances whose ranges overlap, the choice is a toss-up and says so', () => {
  const both = (a, d) => battleCall({ ahead: row('NORRIS'), behind: row('SAINZ'), gapAheadS: 0.5, gapBehindS: 0.4, battle: { attack: a, defend: d }, batteryPct: 80 });
  const close = both(chance(0.2, 'medium', 0.1, 0.3, 'medium', 'high'), chance(0.22, 'medium', 0.12, 0.32, 'medium', 'high'));
  assert.strictEqual(close.confidence, 'soft');
  const clear = both(chance(0.5, 'high', 0.4, 0.55, 'high', 'high'), chance(0.05, 'low', 0.02, 0.08, 'low', 'low'));
  assert.deepStrictEqual([clear.mode, clear.confidence], ['ATTACK', 'firm']);
});

// --- The Battle card shows it ---
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { syntheticPackets, replay } = require('./helpers/synthetic');

test('battle card: the pass chip shows the range beside the chance, and just the chance when there is none', () => {
  const dom = new JSDOM('<!doctype html><body><div id="m"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const file = path.join(__dirname, '..', 'public', 'widgets.js');
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInContext(dom.getInternalVMContext());
  const update = dom.window.RaceWidgets.widgets.battle.mount(dom.window.document.getElementById('m'));
  let snap = null;
  replay(syntheticPackets(), { onTick: ({ snap: s }) => { if (!snap && s.analysis && s.analysis.battle && s.analysis.battle.attack) snap = JSON.parse(JSON.stringify(s)); } });
  assert.ok(snap, 'the synthetic race has a car within reach ahead');
  snap.analysis.battle.attack = { p: 0.2, level: 'medium', horizonS: 10, range: { lo: 0.08, hi: 0.34, levelLo: 'low', levelHi: 'high' } };
  update(snap);
  assert.match(dom.window.document.body.textContent, /Pass MED · 20% \(8-34%\)/);
  snap.analysis.battle.attack = { p: 0.2, level: 'medium', horizonS: 10 };
  update(snap);
  assert.match(dom.window.document.body.textContent, /Pass MED · 20%(?! \()/);
});

test('the live snapshot carries the range on both sides of a battle', () => {
  let seen = null;
  replay(syntheticPackets(), { onTick: ({ snap }) => { const b = snap.analysis && snap.analysis.battle; if (!seen && b && b.attack) seen = b.attack; } });
  assert.ok(seen && seen.range, JSON.stringify(seen));
  assert.ok(seen.range.lo <= seen.p && seen.p <= seen.range.hi);
});

test('battle call: a car close behind with no pass-chance data at all is still defended, with no range to word', () => {
  const c = battleCall({ behind: row('SAINZ', null), gapBehindS: 0.4, battle: {} });
  assert.deepStrictEqual([c.mode, c.confidence], ['DEFEND', 'firm']);
});
