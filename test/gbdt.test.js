const test = require('node:test');
const assert = require('node:assert');
const { predict } = require('../src/ml/gbdt');
const model = require('../src/ml/models/overtake-gbdt.json');
const parity = require('./fixtures/overtake-gbdt-parity.json');

test('gbdt: the app gives the same pass probability as LightGBM in Python, on 200 real battle samples', () => {
  assert.deepStrictEqual(parity.features, model.features);
  for (const { x, p } of parity.rows) {
    const js = predict(model, x);
    assert.ok(Math.abs(js - p) < 1e-9, `JS ${js} vs Python ${p} for ${JSON.stringify(x)}`);
  }
});

test('gbdt: a split sends a value equal to its threshold left, and a missing value the way the tree learned', () => {
  const stump = (dl, m) => ({ trees: [{ f: 0, t: 1, dl, m, l: { v: -1 }, r: { v: 1 } }] });
  const sigmoid = (z) => 1 / (1 + Math.exp(-z));
  assert.strictEqual(predict(stump(true, 'None'), [1]), sigmoid(-1));
  assert.strictEqual(predict(stump(true, 'None'), [1.0001]), sigmoid(1));
  // LightGBM reads a missing value as 0 unless the split learned a side for NaN.
  assert.strictEqual(predict(stump(false, 'None'), [null]), sigmoid(-1));
  assert.strictEqual(predict(stump(false, 'NaN'), [NaN]), sigmoid(1));
  assert.strictEqual(predict(stump(true, 'NaN'), [undefined]), sigmoid(-1));
  // 'Zero': zero itself is the missing value.
  assert.strictEqual(predict(stump(false, 'Zero'), [0]), sigmoid(1));
});
