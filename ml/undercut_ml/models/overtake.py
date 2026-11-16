"""Does a gradient-boosted model beat the gap on its own at predicting a pass?

    python -m undercut_ml.models.overtake [datasets/overtake-samples.csv.gz]     (from ml/)
    python ml/overtake_lgbm.py [datasets/overtake-samples.csv.gz]                (from the repo root, as before)

The samples are the ones the shipped model learns from (`npm run train:overtake
-- --samples ...`): one row per second of a close battle, the label is 1 if the
car behind passed that car within 10 s. Every model here is scored the same
way as the shipped one: leave one race out, so each race is predicted by models
that never saw it, against the same gap-only baseline. Writes
docs/ml-overtake-lightgbm.md, and the model the app runs: its trees as JSON in
src/ml/models/overtake-gbdt.json (evaluated by src/ml/gbdt.js), with
test/fixtures/overtake-gbdt-parity.json to check JS and Python agree.
"""
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from undercut_ml.data import ROOT, feature_columns, load_overtake_samples
from undercut_ml.evaluate import BOOTSTRAPS, calibration, leave_one_race_out, per_race_auc, race_bootstrap, scores
from undercut_ml.export import parity_fixture, tree_json, write_json

REPORT = ROOT / 'docs' / 'ml-overtake-lightgbm.md'
MODEL_OUT = ROOT / 'src' / 'ml' / 'models' / 'overtake-gbdt.json'
PARITY_OUT = ROOT / 'test' / 'fixtures' / 'overtake-gbdt-parity.json'
PARITY_ROWS = 200
HORIZON_S = 10
SEED = 7

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


def fitters(features):
    """The three models scored on every held-out race: the gap alone, logistic on everything, LightGBM."""
    def gap(train, test):
        return logistic().fit(train[['logGap']], train.y).predict_proba(test[['logGap']])[:, 1], None

    def logi(train, test):
        return logistic().fit(train[features], train.y).predict_proba(test[features])[:, 1], None

    def gbm(train, test):
        model = lightgbm(train, features)
        return model.predict_proba(test[features])[:, 1], model.best_iteration_

    return {'gap': gap, 'logistic': logi, 'lightgbm': gbm}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    df = load_overtake_samples(Path(argv[0]) if argv else None)
    features = feature_columns(df)
    base_rate = df.y.mean()
    preds, infos = leave_one_race_out(df, fitters(features))
    fold_trees = infos['lightgbm']
    pooled = {name: scores(df.y, p, base_rate) for name, p in preds.items()}

    per_race = per_race_auc(df, preds)
    wins = int((per_race.lightgbm > per_race.gap).sum())

    rng = np.random.default_rng(SEED)
    lo, hi = race_bootstrap(df, preds['lightgbm'], preds['gap'], rng)

    # The shipped model: every race, as many trees as the held-out folds stopped at (their median).
    n_trees = int(np.median(fold_trees))
    full = lgb.LGBMClassifier(**{**LGB_PARAMS, 'n_estimators': n_trees}).fit(df[features], df.y)
    gain = pd.Series(full.booster_.feature_importance('gain'), index=features)
    gain = (gain / gain.sum()).sort_values(ascending=False)

    beats = lo > 0
    cal = calibration(df.y.values, preds['lightgbm'])
    verdict = (
        f'LightGBM beats the gap on its own: AUC {pooled["lightgbm"]["auc"]:.3f} against {pooled["gap"]["auc"]:.3f}, '
        f'better on {wins} of {len(per_race)} races, and the 90% range of the gain ({lo:+.3f} to {hi:+.3f}) is above zero. '
        f'The app runs it ({n_trees} trees, trained on every race).'
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
        '### Calibration (LightGBM, held out)', '',
        '| Predicted | Samples | Mean predicted | Observed |', '|---|---|---|---|',
        *[f'| {c["bucket"]} | {c["n"]:,} | {c["predicted"] if c["n"] else "-"} | {c["observed"] if c["n"] else "-"} |' for c in cal],
        '',
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

    def evaluation(n):
        sc = pooled[n]
        return {'auc': round(sc['auc'], 4), 'logLoss': round(sc['log_loss'], 4), 'brier': round(sc['brier'], 4), 'brierSkill': round(sc['brier_skill'], 3)}
    model = {
        'name': 'overtake-probability',
        'kind': 'gbdt',
        'question': f'Will the car directly behind pass the car ahead within {HORIZON_S}s?',
        'horizonS': HORIZON_S,
        'features': features,
        'trainedOn': {'races': int(df.race.nunique()), 'samples': len(df), 'passes': int(df.y.sum())},
        'evaluation': {'method': 'leave-one-race-out', 'model': {**evaluation('lightgbm'), 'calibration': cal}, 'gapOnlyBaseline': evaluation('gap')},
        'importance': [{'feature': f, 'share': round(float(v), 4)} for f, v in gain.items()],
        'trees': [tree_json(t['tree_structure']) for t in full.booster_.dump_model()['tree_info']],
    }
    write_json(MODEL_OUT, model, separators=(',', ':'))
    rows = df.sample(PARITY_ROWS, random_state=SEED)
    write_json(PARITY_OUT, parity_fixture('Python predict_proba for these rows; test/gbdt.test.js checks src/ml/gbdt.js gives the same.',
                                          features, rows[features].values, full.predict_proba(rows[features])[:, 1]))
    for n, s in pooled.items():
        print(f'{names[n]:40s} AUC {s["auc"]:.3f}  log loss {s["log_loss"]:.4f}  Brier skill {s["brier_skill"]:+.3f}')
    print(f'LightGBM better on {wins}/{len(per_race)} races; AUC gain 90% range {lo:+.3f} to {hi:+.3f}')
    print(f'wrote {REPORT.relative_to(ROOT)}, {MODEL_OUT.relative_to(ROOT)} ({n_trees} trees, {MODEL_OUT.stat().st_size // 1024} KB), {PARITY_OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
