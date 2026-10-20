// Runs a gradient-boosted tree model trained in Python (ml/overtake_lgbm.py)
// and exported as JSON: no ML dependency at run time. Each tree is nested
// splits { f, t, dl, m, l, r } - feature f at or under threshold t goes left
// - down to leaves { v }. For a binary model the leaves of all the trees add
// up to a log-odds, which the sigmoid turns into a probability.

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// LightGBM's missing values: with missing type 'NaN' a missing value takes the
// side the split learned (dl: default left); otherwise it reads as 0, and with
// 'Zero' a 0 is itself the missing value.
function goLeft(node, value) {
  const missing = value == null || Number.isNaN(value);
  if (node.m === 'NaN' && missing) return node.dl;
  const v = missing ? 0 : value;
  if (node.m === 'Zero' && Math.abs(v) <= 1e-35) return node.dl;
  return v <= node.t;
}

function leaf(node, x) {
  let n = node;
  while (n.v === undefined) n = goLeft(n, x[n.f]) ? n.l : n.r;
  return n.v;
}

/** @param {{ trees: any[] }} model @param {(number | null | undefined)[]} x features in model.features order */
function predict(model, x) {
  let z = 0;
  for (const tree of model.trees) z += leaf(tree, x);
  return sigmoid(z);
}

module.exports = { predict };
