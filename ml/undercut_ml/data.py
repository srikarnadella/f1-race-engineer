"""Where the training data comes from. Read-only: nothing here writes to the datasets or to race.db."""
import sqlite3
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
DATASETS = ROOT / 'datasets'
OVERTAKE_SAMPLES = DATASETS / 'overtake-samples.csv.gz'


def load_overtake_samples(path=None):
    """One row per second of a close battle: race, session, the label y, then the features (the columns after y)."""
    return pd.read_csv(path or OVERTAKE_SAMPLES)


def feature_columns(df):
    """The model inputs are every column after the label."""
    return list(df.columns[df.columns.get_loc('y') + 1:])


def load_laps(db_path, learn_only=True):
    """Every stored lap of every car, from the race store, with its session's track and type.

    learn_only drops the sessions the user switched "learn from this race" off for (session.learn = 0), so a
    model never trains on a race the user excluded. A race store from before that switch has no such column and
    every session counts.
    """
    con = sqlite3.connect(f'file:{Path(db_path).as_posix()}?mode=ro', uri=True)
    try:
        cols = [r[1] for r in con.execute('PRAGMA table_info(session)')]
        keep = ' WHERE s.learn = 1' if learn_only and 'learn' in cols else ''
        return pd.read_sql_query(
            'SELECT s.session_uid, s.track, s.session_name, s.is_race, l.* '
            'FROM lap l JOIN session s USING (session_id)' + keep, con)
    finally:
        con.close()
