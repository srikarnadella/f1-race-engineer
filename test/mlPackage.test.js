const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Roadmap P1: the Python package's unit tests, run when this checkout has the venv (CI has no Python, so it skips
// there; the JavaScript side of every exported model is checked by test/gbdt.test.js on the parity fixture).
const root = path.join(__dirname, '..');
const python = [path.join(root, '.venv', 'Scripts', 'python.exe'), path.join(root, '.venv', 'bin', 'python')].find((p) => fs.existsSync(p));

test('ml package: its Python unit tests pass', { skip: python ? false : 'no .venv here (python -m venv .venv && pip install -r ml/requirements.txt)' }, () => {
  const r = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests'], { cwd: path.join(root, 'ml'), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr.slice(-1500));
});
