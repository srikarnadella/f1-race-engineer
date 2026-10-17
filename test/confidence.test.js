const test = require('node:test');
const assert = require('node:assert');
const { wearRange } = require('../src/analysis/pitTiming');
const { syntheticPackets, replay } = require('./helpers/synthetic');

// How sure a pit call is: the stop-lap simulation run again at both ends of
// the tyre model's 90% range. A pick that holds across it is firm; one that
// moves is "lap 14-16, depending on tyre wear".

test('confidence: a pick that stays put across the wear range holds', () => {
  assert.deepStrictEqual(wearRange(2, { bestInLaps: 2 }, { bestInLaps: 2 }), { holds: true, fromInLaps: 2, toInLaps: 2 });
});

test('confidence: a pick that moves gives the laps it could be', () => {
  // Faster wear brings the stop forward; slower wear pushes it back.
  assert.deepStrictEqual(wearRange(2, { bestInLaps: 4 }, { bestInLaps: 1 }), { holds: false, fromInLaps: 1, toInLaps: 4 });
});

test('confidence: "stay out" at one end of the range is part of the range, not a lap', () => {
  assert.deepStrictEqual(wearRange(3, { bestInLaps: null }, { bestInLaps: 3 }), { holds: false, fromInLaps: 3, toInLaps: null });
});

test('confidence: no range to test against is no confidence claim', () => {
  assert.strictEqual(wearRange(2, null, { bestInLaps: 2 }), null);
});

test('confidence: in the synthetic race every pit-timing pick carries how sure it is', () => {
  let picks = 0;
  replay(syntheticPackets(), {
    onTick: ({ snap }) => {
      const pt = snap.analysis && snap.analysis.pitTiming;
      const tm = snap.analysis && snap.analysis.tyreModel;
      if (!pt || !tm || !Object.values(tm.compounds).some((c) => c.ciMs)) return;
      picks++;
      assert.ok(pt.wear, 'pit timing with a wear range carries a confidence');
      const { fromInLaps: from, toInLaps: to } = pt.wear;
      // The pick sits inside its own range ('stay out' = after every lap).
      const pos = (k) => (k == null ? Infinity : k);
      assert.ok(pos(from) <= pos(pt.bestInLaps) && pos(pt.bestInLaps) <= pos(to), JSON.stringify({ best: pt.bestInLaps, wear: pt.wear }));
    },
  });
  assert.ok(picks > 50, `${picks} picks checked`);
});
