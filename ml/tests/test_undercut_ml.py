"""Unit tests for the parts of undercut_ml that are not the long training run. From ml/:

    ..\\.venv\\Scripts\\python -m unittest discover -s tests

(The training run itself is checked by its outputs: re-running ml/overtake_lgbm.py leaves the committed model,
parity fixture and report byte for byte as they were.)
"""
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from undercut_ml import data, evaluate, export  # noqa: E402


class Evaluate(unittest.TestCase):
    def test_leave_one_race_out_never_trains_on_the_race_it_predicts(self):
        df = pd.DataFrame({'race': ['a'] * 4 + ['b'] * 4 + ['c'] * 4, 'y': [0, 1] * 6, 'x': range(12)})
        seen = []

        def fit(train, test):
            seen.append((set(train.race), set(test.race)))
            return np.full(len(test), 0.5), len(train)

        preds, infos = evaluate.leave_one_race_out(df, {'m': fit})
        self.assertEqual([t for _, t in seen], [{'a'}, {'b'}, {'c'}])
        for train, test in seen:
            self.assertTrue(train.isdisjoint(test))
        self.assertEqual(len(preds['m']), 12)
        self.assertEqual(infos['m'], [8, 8, 8])

    def test_scores_and_calibration_on_known_numbers(self):
        y = np.array([0, 0, 1, 1])
        p = np.array([0.1, 0.2, 0.8, 0.9])
        s = evaluate.scores(y, p, base_rate=0.5)
        self.assertEqual(s['auc'], 1.0)
        self.assertAlmostEqual(s['brier_skill'], 0.9)
        cal = evaluate.calibration(y, p)
        self.assertEqual(sum(c['n'] for c in cal), 4)
        top = [c for c in cal if c['bucket'] == '60-100%'][0]
        self.assertEqual((top['n'], top['observed']), (2, 1.0))

    def test_the_race_bootstrap_range_holds_zero_when_a_model_is_no_better_than_its_baseline(self):
        rng = np.random.default_rng(1)
        df = pd.DataFrame({'race': np.repeat(list('abcdefgh'), 50), 'y': rng.integers(0, 2, 400)})
        noise = rng.random(400)
        lo, hi = evaluate.race_bootstrap(df, noise, rng.random(400), np.random.default_rng(2))
        self.assertLess(lo, 0)
        self.assertGreater(hi, 0)


class Export(unittest.TestCase):
    def test_a_lightgbm_tree_becomes_nested_splits_and_leaves(self):
        node = {'split_feature': 2, 'threshold': 1.5, 'decision_type': '<=', 'default_left': True, 'missing_type': 'None',
                'left_child': {'leaf_value': -0.2}, 'right_child': {'leaf_value': 0.4}}
        self.assertEqual(export.tree_json(node), {'f': 2, 't': 1.5, 'dl': True, 'm': 'None', 'l': {'v': -0.2}, 'r': {'v': 0.4}})

    def test_only_less_or_equal_splits_are_accepted(self):
        with self.assertRaises(AssertionError):
            export.tree_json({'split_feature': 0, 'threshold': 1, 'decision_type': '==', 'left_child': {}, 'right_child': {}})


class Data(unittest.TestCase):
    def make_db(self, with_learn=True):
        path = Path(tempfile.mkdtemp()) / 'race.db'
        con = sqlite3.connect(path)
        con.execute('CREATE TABLE session (session_id INTEGER PRIMARY KEY, session_uid TEXT, track TEXT, session_name TEXT, is_race INTEGER'
                    + (', learn INTEGER NOT NULL DEFAULT 1' if with_learn else '') + ')')
        con.execute('CREATE TABLE lap (session_id INTEGER, car_idx INTEGER, lap_num INTEGER, lap_ms INTEGER)')
        con.executemany('INSERT INTO session (session_id, session_uid, track, session_name, is_race) VALUES (?, ?, ?, ?, 1)',
                        [(1, 'a', 'Spa', 'Race'), (2, 'b', 'Monza', 'Race')])
        con.executemany('INSERT INTO lap VALUES (?, 0, ?, 90000)', [(1, 1), (1, 2), (2, 1)])
        if with_learn:
            con.execute('UPDATE session SET learn = 0 WHERE session_id = 2')
        con.commit()
        con.close()
        return path

    def test_laps_of_a_race_switched_off_are_not_learned_from(self):
        path = self.make_db()
        self.assertEqual(sorted(data.load_laps(path).track.unique()), ['Spa'])
        self.assertEqual(sorted(data.load_laps(path, learn_only=False).track.unique()), ['Monza', 'Spa'])

    def test_a_store_from_before_the_switch_counts_every_session(self):
        path = self.make_db(with_learn=False)
        self.assertEqual(sorted(data.load_laps(path).track.unique()), ['Monza', 'Spa'])

    def test_the_store_is_opened_read_only(self):
        path = self.make_db()
        con = sqlite3.connect(f'file:{path.as_posix()}?mode=ro', uri=True)
        with self.assertRaises(sqlite3.OperationalError):
            con.execute('DELETE FROM lap')
        con.close()

    def test_feature_columns_are_everything_after_the_label(self):
        df = pd.DataFrame(columns=['race', 'session', 'y', 'logGap', 'closing'])
        self.assertEqual(data.feature_columns(df), ['logGap', 'closing'])

    def test_the_shipped_samples_load(self):
        df = data.load_overtake_samples()
        self.assertIn('y', df.columns)
        self.assertGreater(df.race.nunique(), 5)


class Models(unittest.TestCase):
    def test_the_overtake_module_imports_and_names_its_three_models(self):
        from undercut_ml.models import overtake
        self.assertEqual(list(overtake.fitters(['logGap']).keys()), ['gap', 'logistic', 'lightgbm'])


if __name__ == '__main__':
    unittest.main()
