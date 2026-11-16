const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createDebrief, DEBRIEF_VERSION } = require('../src/engine/debrief');
const { DEFAULTS, loadSettings, saveSettings, SETTINGS_VERSION } = require('../desktop/settings');
const { syntheticPackets, replay } = require('./helpers/synthetic');

// Roadmap Q6: the files the app keeps besides race.db say which format they are in, so a later change can
// read the old ones, and an older Undercut doesn't misread a newer one.
test('versions: each file format has a whole-number version', () => {
  assert.ok(Number.isInteger(SETTINGS_VERSION) && SETTINGS_VERSION >= 1);
  assert.ok(Number.isInteger(DEBRIEF_VERSION) && DEBRIEF_VERSION >= 1);
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'undercut-ver-'));
const debriefFile = (rec) => zlib.gzipSync(JSON.stringify({ id: 'x', uid: '9', startedAt: 1, field: [], traces: [], rivalBest: [], laps: [], ...rec }));

test('versions: a saved settings file says its version, and one without (written before) still loads', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'settings.json');
    saveSettings(file, { ...DEFAULTS, httpPort: 9001 });
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).version, SETTINGS_VERSION);
    assert.strictEqual(loadSettings(file).httpPort, 9001);
    assert.ok(!('version' in loadSettings(file)), 'the version is the file\'s, not a setting');
    fs.writeFileSync(file, JSON.stringify({ httpPort: 9002 })); // before versions
    assert.strictEqual(loadSettings(file).httpPort, 9002);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('versions: a settings file from a newer Undercut keeps the settings this one knows and is not overwritten by defaults', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ version: SETTINGS_VERSION + 1, httpPort: 9003, somethingNew: true }));
    assert.strictEqual(loadSettings(file).httpPort, 9003);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('versions: a saved debrief says its version; one without (written before) still loads; a newer one is skipped, not misread', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'a.json.gz'), debriefFile({ id: 'old' })); // no v
    fs.writeFileSync(path.join(dir, 'b.json.gz'), debriefFile({ id: 'cur', v: DEBRIEF_VERSION }));
    fs.writeFileSync(path.join(dir, 'c.json.gz'), debriefFile({ id: 'new', v: DEBRIEF_VERSION + 1 }));
    const warn = console.warn;
    const warned = [];
    console.warn = (m) => warned.push(m);
    let d;
    try {
      d = createDebrief({ clock: () => 0 }, { dir });
    } finally {
      console.warn = warn;
    }
    assert.strictEqual(d.uidOf('old'), '9');
    assert.strictEqual(d.uidOf('cur'), '9');
    assert.strictEqual(d.uidOf('new'), null, 'not loaded');
    assert.ok(warned.some((m) => /newer/.test(m) && /c\.json\.gz/.test(m)), warned.join('|'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('versions: a debrief the app saves carries the version', () => {
  const dir = tmp();
  try {
    replay(syntheticPackets(), { pipelineOptions: { debriefDir: dir } }).flush();
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json.gz'));
    assert.ok(files.length > 0);
    for (const n of files) assert.strictEqual(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, n)))).v, DEBRIEF_VERSION);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
