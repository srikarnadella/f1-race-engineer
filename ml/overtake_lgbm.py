"""Kept so `python ml/overtake_lgbm.py` still works: the code lives in the undercut_ml package (ml/undercut_ml).

    python ml/overtake_lgbm.py [datasets/overtake-samples.csv.gz]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from undercut_ml.models.overtake import main  # noqa: E402

if __name__ == '__main__':
    main()
