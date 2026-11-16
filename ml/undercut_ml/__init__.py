"""Undercut's model training. Python learns, Node runs: each model is trained and scored here (leave one race
out, the same way the app's backtest scores the JavaScript models) and exported as JSON the app evaluates, with a
parity fixture the JavaScript tests check against.

    data.py      the datasets (datasets/*.csv.gz) and the race store (race.db), read-only
    evaluate.py  leave-one-race-out scoring: AUC, log loss, Brier, calibration, a race-level bootstrap
    export.py    trees and fixtures as JSON
    models/      one module per model: python -m undercut_ml.models.overtake  (run from ml/)
"""
