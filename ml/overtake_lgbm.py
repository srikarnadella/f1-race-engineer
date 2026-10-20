"""Does a gradient-boosted model beat the gap on its own at predicting a pass?

    python ml/overtake_lgbm.py [datasets/overtake-samples.csv.gz]

The samples are the ones the shipped model learns from (`npm run train:overtake
-- --samples ...`): one row per second of a close battle, the label is 1 if the
car behind passed that car within 10 s. Every model here is scored the same
way as the shipped one: leave one race out, so each race is predicted by models
that never saw it, against the same gap-only baseline. Writes
docs/ml-overtake-lightgbm.md.
"""
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'datasets' / 'overtake-samples.csv.gz'
REPORT = ROOT / 'docs' / 'ml-overtake-lightgbm.md'
SEED = 7
BOOTSTRAPS = 1000

# Fixed before looking at any held-out race: small trees and a slow learning
# rate for ~200k rows of 9 features; the number of trees is picked by early
# stopping on a race held out of the training races, never the test race.
LGB_PARAMS = dict(
    objective='binary', learning_rate=0.03, num_leaves=15, min_child_samples=200,
    subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0,
    n_estimators=2000, random_state=SEED, verbose=-1,
)


def logistic():
    return make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=1000))


def lightgbm(train, features):
    # Early stopping on one whole training race, so the tree count is chosen
    # on a race the model didn't fit, as the test race will be.
    races = sorted(train.race.unique())
    val_race = races[-1]
    fit, val = train[train.race != val_race], train[train.race == val_race]
    model = lgb.LGBMClassifier(**LGB_PARAMS)
    model.fit(fit[features], fit.y, eval_set=[(val[features], val.y)], eval_metric='binary_logloss',
              callbacks=[lgb.early_stopping(100, verbose=False)])
    return model


def leave_one_race_out(df, features):
    preds = {name: np.zeros(len(df)) for name in ('gap', 'logistic', 'lightgbm')}
    for race in sorted(df.race.unique()):
        test = df.race == race
        train = df[~test]
        preds['gap'][test] = logistic().fit(train[['logGap']], train.y).predict_proba(df.loc[test, ['logGap']])[:, 1]
        preds['logistic'][test] = logistic().fit(train[features], train.y).predict_proba(df.loc[test, features])[:, 1]
        preds['lightgbm'][test] = lightgbm(train, features).predict_proba(df.loc[test, features])[:, 1]
    return preds


def scores(y, p, base_rate):
    brier = brier_score_loss(y, p)
    return {
        'auc': roc_auc_score(y, p),
        'log_loss': log_loss(y, p),
        'brier': brier,
        'brier_skill': 1 - brier / brier_score_loss(y, np.full(len(y), base_rate)),
    }


def race_bootstrap(df, p_model, p_base, rng):
    """90% range of the AUC gain over the baseline, resampling whole races (the independent units)."""
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


def main():
    df = pd.read_csv(SAMPLES)
    features = list(df.columns[df.columns.get_loc('y') + 1:])
    base_rate = df.y.mean()
    preds = leave_one_race_out(df, features)
    pooled = {name: scores(df.y, p, base_rate) for name, p in preds.items()}

    per_race = []
    for race, g in df.groupby('race'):
        if g.y.nunique() < 2:
            continue
        rows = g.index.values
        per_race.append({'race': g.session.iloc[0], 'samples': len(g), 'passes': int(g.y.sum()),
                         **{name: roc_auc_score(g.y, preds[name][rows]) for name in preds}})
    per_race = pd.DataFrame(per_race)
    wins = int((per_race.lightgbm > per_race.gap).sum())

    rng = np.random.default_rng(SEED)
    lo, hi = race_bootstrap(df, preds['lightgbm'], preds['gap'], rng)

    full = lgb.LGBMClassifier(**{**LGB_PARAMS, 'n_estimators': 300}).fit(df[features], df.y)
    gain = pd.Series(full.booster_.feature_importance('gain'), index=features)
    gain = (gain / gain.sum()).sort_values(ascending=False)

    beats = lo > 0
    verdict = (
        f'LightGBM beats the gap on its own: AUC {pooled["lightgbm"]["auc"]:.3f} against {pooled["gap"]["auc"]:.3f}, '
        f'better on {wins} of {len(per_race)} races, and the 90% range of the gain ({lo:+.3f} to {hi:+.3f}) is above zero.'
        if beats else
        f'LightGBM does not clearly beat the gap on its own: AUC {pooled["lightgbm"]["auc"]:.3f} against '
        f'{pooled["gap"]["auc"]:.3f}, better on {wins} of {len(per_race)} races, and the 90% range of the gain '
        f'({lo:+.3f} to {hi:+.3f}) includes zero. The app keeps the logistic model, marked experimental.'
    )
    names = {'gap': 'Baseline: logistic, log gap only', 'logistic': f'Logistic, all {len(features)} features', 'lightgbm': f'LightGBM, all {len(features)} features'}
    lines = [
        '# Overtake model: LightGBM against the baseline', '',
        '_Generated by `python ml/overtake_lgbm.py` - do not edit by hand._', '',
        f'**Question:** will the car directly behind pass the car ahead within 10 s? Same samples as the shipped '
        f'model ([ml-overtake-model.md](ml-overtake-model.md)), exported with `npm run train:overtake -- --samples '
        f'datasets/overtake-samples.csv.gz`.', '',
        f'**Data:** {len(df):,} one-second samples of close battles from {df.race.nunique()} race sessions, '
        f'{int(df.y.sum()):,} followed by a pass (base rate {base_rate:.1%}).', '',
        '**Method:** leave one race out. Each race is predicted by models trained on the others only; LightGBM '
        'picks its number of trees by early stopping on one of the training races. Its settings were fixed '
        'before any test race was scored.', '',
        f'**Verdict:** {verdict}', '',
        '## Held-out scores (all races pooled)', '',
        '| Model | AUC | Log loss | Brier | Brier skill |', '|---|---|---|---|---|',
        *[f'| {names[n]} | {s["auc"]:.3f} | {s["log_loss"]:.4f} | {s["brier"]:.4f} | {s["brier_skill"]:+.3f} |' for n, s in pooled.items()],
        '',
        'AUC: 0.5 is a coin flip, 1.0 a perfect ranking. Brier skill: the improvement over always predicting '
        'the base rate (above zero is better than that).', '',
        f'AUC gain of LightGBM over the baseline, 90% range from {BOOTSTRAPS:,} resamples of whole races: '
        f'**{lo:+.3f} to {hi:+.3f}**.', '',
        '## Each race, held out', '',
        '| Race | Samples | Passes | Baseline AUC | Logistic AUC | LightGBM AUC |', '|---|---|---|---|---|---|',
        *[f'| {r.race} | {int(r.samples):,} | {int(r.passes):,} | {r.gap:.3f} | {r.logistic:.3f} | {r.lightgbm:.3f} |' for r in per_race.itertuples()],
        '',
        '## What LightGBM leans on (share of split gain, all races)', '',
        '| Feature | Share |', '|---|---|',
        *[f'| `{f}` | {v:.1%} |' for f, v in gain.items()],
        '',
        '## Caveats', '',
        '- Mostly AI drivers: this is how the game\'s AI battles.',
        '- Samples a second apart in the same battle are not independent, which is why the range above resamples '
        'whole races rather than rows.',
        '- The game\'s OVTK event fires on any position swap, including a car ahead running wide or pitting.',
    ]
    REPORT.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    for n, s in pooled.items():
        print(f'{names[n]:40s} AUC {s["auc"]:.3f}  log loss {s["log_loss"]:.4f}  Brier skill {s["brier_skill"]:+.3f}')
    print(f'LightGBM better on {wins}/{len(per_race)} races; AUC gain 90% range {lo:+.3f} to {hi:+.3f}')
    print(f'wrote {REPORT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
