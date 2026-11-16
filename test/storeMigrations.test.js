const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore, MIGRATIONS, SCHEMA_VERSION } = require('../src/data/store');

// race.db is the user's own record of every race, so opening an older file must upgrade it in numbered
// steps, keep what is in it, and leave a copy of the file as it was.
function inTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-mig-'));
  try {
    return fn(dir, path.join(dir, 'race.db'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const version = (db) => Number(db.prepare('PRAGMA user_version').get().user_version);
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

// A file as the first release wrote it: version 1, no battery columns, one marker row.
function makeV1(file) {
  const s = openStore(file);
  s.db.exec('ALTER TABLE trace_point DROP COLUMN ers_pct; ALTER TABLE trace_point DROP COLUMN ers_mode');
  s.db.exec("INSERT INTO capture (name) VALUES ('kept')");
  s.db.exec('PRAGMA user_version = 1');
  s.close();
}

test('migrations: the steps are numbered 2, 3, ... with no gap, and the schema version is the last', () => {
  MIGRATIONS.forEach((m, i) => assert.strictEqual(m.version, i + 2, `step ${i} is v${m.version}`));
  assert.strictEqual(SCHEMA_VERSION, MIGRATIONS.length + 1);
});

test('migrations: a new file starts at the latest version with every column', () => {
  const s = openStore(':memory:');
  assert.strictEqual(version(s.db), SCHEMA_VERSION);
  assert.ok(columns(s.db, 'trace_point').includes('ers_pct'));
  s.close();
});

test('migrations: a version 1 file is upgraded, keeps its rows, and a copy of it is left beside it', () => {
  inTempDir((dir, file) => {
    makeV1(file);
    const s = openStore(file);
    assert.strictEqual(version(s.db), SCHEMA_VERSION);
    assert.ok(columns(s.db, 'trace_point').includes('ers_mode'));
    assert.deepStrictEqual(s.db.prepare('SELECT name FROM capture').all().map((r) => r.name), ['kept']);
    s.close();
    const copy = `${file}.before-v${SCHEMA_VERSION}`;
    assert.ok(fs.existsSync(copy), 'the copy exists');
    const { DatabaseSync } = require('node:sqlite');
    const old = new DatabaseSync(copy, { readOnly: true });
    assert.strictEqual(version(old), 1, 'the copy is the file as it was');
    assert.ok(!columns(old, 'trace_point').includes('ers_pct'));
    old.close();
  });
});

test('migrations: an up-to-date file is not touched again and makes no copy', () => {
  inTempDir((dir, file) => {
    openStore(file).close();
    openStore(file).close();
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.includes('before')), []);
  });
});

test('migrations: a file from a newer Undercut is refused, not downgraded', () => {
  inTempDir((dir, file) => {
    const s = openStore(file);
    s.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    s.close();
    assert.throws(() => openStore(file), /schema v\d+/);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    assert.strictEqual(version(db), SCHEMA_VERSION + 5, 'left as it was');
    db.close();
  });
});

test('migrations: each pending step runs once, in order', () => {
  inTempDir((dir, file) => {
    openStore(file).close();
    const ran = [];
    const steps = [2, 3, 4].map((v) => ({ version: v, name: `s${v}`, up: () => ran.push(v) }));
    // The file is at SCHEMA_VERSION; pretend the real steps are these three and it is at 1.
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA user_version = 1');
    raw.close();
    const s = openStore(file, { migrations: steps });
    assert.deepStrictEqual(ran, [2, 3, 4]);
    assert.strictEqual(version(s.db), 4);
    s.close();
    openStore(file, { migrations: steps }).close();
    assert.deepStrictEqual(ran, [2, 3, 4], 'not again');
  });
});

test('migrations: a step that fails leaves the file at the version it had, with none of the step applied', () => {
  inTempDir((dir, file) => {
    openStore(file).close();
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA user_version = 1');
    raw.close();
    const steps = [{ version: 2, name: 'bad', up: (db) => { db.exec('CREATE TABLE half_done (x)'); throw new Error('boom'); } }];
    assert.throws(() => openStore(file, { migrations: steps }), /boom/);
    const db = new DatabaseSync(file);
    assert.strictEqual(version(db), 1);
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'half_done'").get().n, 0);
    db.close();
  });
});

test('migrations: a file with no version stamp but old tables (the battery columns missing) still upgrades', () => {
  inTempDir((dir, file) => {
    const { DatabaseSync } = require('node:sqlite');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE trace_point (session_id INTEGER NOT NULL, car_idx INTEGER NOT NULL, lap_num INTEGER NOT NULL, distance_m REAL NOT NULL, lap_time_ms INTEGER NOT NULL, speed_kmh INTEGER NOT NULL, throttle REAL NOT NULL, brake REAL NOT NULL, steer REAL NOT NULL, gear INTEGER NOT NULL, PRIMARY KEY (session_id, car_idx, lap_num, distance_m)) WITHOUT ROWID');
    old.close();
    const s = openStore(file);
    assert.ok(columns(s.db, 'trace_point').includes('ers_pct'));
    assert.strictEqual(version(s.db), SCHEMA_VERSION);
    s.close();
  });
});

test('migrations: Ask the race\'s read-only tools also refuse a file from a newer Undercut, and open the current one', () => {
  const { createRaceTools } = require('../src/llm/tools');
  inTempDir((dir, file) => {
    openStore(file).close();
    createRaceTools(file).close(); // current: opens
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    assert.throws(() => createRaceTools(file), /schema v\d+/);
  });
});
