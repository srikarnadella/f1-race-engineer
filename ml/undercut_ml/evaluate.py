"""Scoring that every model here shares: leave one race out, so each race is predicted by models that never saw it,
and the 90% range of a gain comes from resampling whole races (the independent units), not rows."""
import numpy as np
import pandas as pd
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score

# The same buckets as src/ml/logistic.js evaluate(), so the Models tab reads both alike.
CAL_EDGES = [0, 0.05, 0.1, 0.2, 0.4, 0.6, 1.0001]
BOOTSTRAPS = 1000


def leave_one_race_out(df, fitters):
    """fitters: {name: fit(train, test) -> (probabilities for test, info)}. Returns ({name: predictions for every
    row}, {name: [info of each fold]}). Races are visited in sorted order, every fitter on each before the next."""
    preds = {name: np.zeros(len(df)) for name in fitters}
    infos = {name: [] for name in fitters}
    for race in sorted(df.race.unique()):
        test = df.race == race
        train = df[~test]
        for name, fit in fitters.items():
            p, info = fit(train, df[test])
            preds[name][test] = p
            infos[name].append(info)
    return preds, infos


def scores(y, p, base_rate):
    brier = brier_score_loss(y, p)
    return {
        'auc': roc_auc_score(y, p),
        'log_loss': log_loss(y, p),
        'brier': brier,
        'brier_skill': 1 - brier / brier_score_loss(y, np.full(len(y), base_rate)),
    }


def calibration(y, p):
    out = []
    for lo, hi in zip(CAL_EDGES, CAL_EDGES[1:]):
        inb = (p >= lo) & (p < hi)
        n = int(inb.sum())
        out.append({'bucket': f'{round(lo * 100)}-{min(100, round(hi * 100))}%', 'n': n,
                    'predicted': round(float(p[inb].mean()), 3) if n else None,
                    'observed': round(float(y[inb].mean()), 3) if n else None})
    return out


def race_bootstrap(df, p_model, p_base, rng):
    """90% range of the AUC gain over the baseline, resampling whole races."""
    races = df.race.unique()
    idx = {r: np.flatnonzero(df.race.values == r) for r in races}
    gains = []
    for _ in range(BOOTSTRAPS):
        rows = np.concatenate([idx[r] for r in rng.choice(races, len(races), replace=True)])
        y = df.y.values[rows]
        if y.min() == y.max():
            continue
        gains.append(roc_auc_score(y, p_model[rows]) - roc_auc_score(y, p_base[rows]))
    return np.percentile(gains, [5, 95])


def per_race_auc(df, preds):
    """One row per race that has both outcomes: its session name, sizes, and every model's held-out AUC."""
    rows = []
    for _, g in df.groupby('race'):
        if g.y.nunique() < 2:
            continue
        idx = g.index.values
        rows.append({'race': g.session.iloc[0], 'samples': len(g), 'passes': int(g.y.sum()),
                     **{name: roc_auc_score(g.y, preds[name][idx]) for name in preds}})
    return pd.DataFrame(rows)
