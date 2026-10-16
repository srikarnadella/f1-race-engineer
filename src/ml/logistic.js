// Logistic regression, from scratch: standardised features, L2 penalty,
// class-weighted full-batch gradient descent. Small, dependency-free and
// fully inspectable - each weight reads as "how much this feature moves the
// odds", which is the point for a driver-facing prediction.

function standardize(X) {
  const d = X[0].length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j] / X.length;
  for (const x of X) for (let j = 0; j < d; j++) std[j] += (x[j] - mean[j]) ** 2 / X.length;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  return { mean, std };
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// y in {0,1}. Positives are rare (a pass), so they're up-weighted to balance
// the classes during fitting; the bias is then shifted back so predicted
// probabilities match the real base rate (prior correction).
function train(X, y, { lambda = 0.01, lr = 0.5, epochs = 1500, balance = true } = {}) {
  const { mean, std } = standardize(X);
  const Z = X.map((x) => x.map((v, j) => (v - mean[j]) / std[j]));
  const d = Z[0].length;
  const pos = y.reduce((a, b) => a + b, 0);
  const neg = y.length - pos;
  const wPos = balance && pos ? y.length / (2 * pos) : 1;
  const wNeg = balance && neg ? y.length / (2 * neg) : 1;
  const w = new Array(d).fill(0);
  let b = 0;
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    let wsum = 0;
    for (let i = 0; i < Z.length; i++) {
      const p = sigmoid(Z[i].reduce((s, v, j) => s + v * w[j], b));
      const cw = y[i] ? wPos : wNeg;
      const err = (p - y[i]) * cw;
      for (let j = 0; j < d; j++) gw[j] += err * Z[i][j];
      gb += err;
      wsum += cw;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / wsum + lambda * w[j]);
    b -= lr * (gb / wsum);
  }
  // Undo the class weighting in the intercept: log(neg/pos) shift.
  const priorShift = balance && pos && neg ? Math.log(pos / neg) : 0;
  return { mean, std, weights: w, bias: b + priorShift };
}

function predict(model, x) {
  const z = x.reduce((s, v, j) => s + ((v - model.mean[j]) / model.std[j]) * model.weights[j], model.bias);
  return sigmoid(z);
}

// Area under the ROC curve: the chance a random positive outranks a random
// negative (0.5 = coin flip). Rank-based, with ties shared.
function auc(scores, y) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rankSum = 0;
  let pos = 0;
  for (let k = 0; k < idx.length;) {
    let j = k;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[k]]) j++;
    const rank = (k + j) / 2 + 1;
    for (let m = k; m <= j; m++) if (y[idx[m]]) { rankSum += rank; pos++; }
    k = j + 1;
  }
  const neg = y.length - pos;
  return pos && neg ? (rankSum - (pos * (pos + 1)) / 2) / (pos * neg) : null;
}

function evaluate(scores, y) {
  const eps = 1e-6;
  const n = y.length;
  const logLoss = -y.reduce((s, yi, i) => s + (yi ? Math.log(Math.max(eps, scores[i])) : Math.log(Math.max(eps, 1 - scores[i]))), 0) / n;
  const brier = y.reduce((s, yi, i) => s + (scores[i] - yi) ** 2, 0) / n;
  const baseRate = y.reduce((a, b) => a + b, 0) / n;
  const baseBrier = baseRate * (1 - baseRate);
  // Calibration: predicted vs observed rate in probability buckets.
  const edges = [0, 0.05, 0.1, 0.2, 0.4, 0.6, 1.0001];
  const calibration = edges.slice(0, -1).map((lo, k) => {
    const hi = edges[k + 1];
    const inB = scores.map((s, i) => [s, y[i]]).filter(([s]) => s >= lo && s < hi);
    return {
      bucket: `${Math.round(lo * 100)}-${Math.min(100, Math.round(hi * 100))}%`,
      n: inB.length,
      predicted: inB.length ? +(inB.reduce((a, [s]) => a + s, 0) / inB.length).toFixed(3) : null,
      observed: inB.length ? +(inB.reduce((a, [, yi]) => a + yi, 0) / inB.length).toFixed(3) : null,
    };
  });
  return { n, positives: y.reduce((a, b) => a + b, 0), baseRate: +baseRate.toFixed(4), auc: auc(scores, y), logLoss: +logLoss.toFixed(4), brier: +brier.toFixed(4), brierSkill: baseBrier ? +(1 - brier / baseBrier).toFixed(3) : null, calibration };
}

module.exports = { train, predict, evaluate, auc, sigmoid };
