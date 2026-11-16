"""What the app reads: trees as JSON, and a fixture of Python's own predictions that the JavaScript tests check."""
import json


def tree_json(node):
    """One LightGBM tree as nested {f, t, l, r} splits (x[f] <= t goes left) and {v} leaves."""
    if 'leaf_value' in node:
        return {'v': node['leaf_value']}
    assert node['decision_type'] == '<=', node['decision_type']
    return {'f': node['split_feature'], 't': node['threshold'], 'dl': node['default_left'],
            'm': node['missing_type'], 'l': tree_json(node['left_child']), 'r': tree_json(node['right_child'])}


def write_json(path, obj, separators=None):
    path.write_text(json.dumps(obj, separators=separators) + '\n', encoding='utf-8')


def parity_fixture(note, features, rows, probabilities):
    return {'note': note, 'features': features,
            'rows': [{'x': [float(v) for v in r], 'p': float(q)} for r, q in zip(rows, probabilities)]}
