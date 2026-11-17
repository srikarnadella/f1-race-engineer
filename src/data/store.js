// The race store: every session as related tables in one SQLite file
// (data/race.db, local only), for questions like "what happened on lap 12?".
// Parent to child:
//
//   capture ─< session ─< car ─< lap
//                 │        ├──< stint
//                 │        └──< trace_point (the player's laps, rivals' best)
//                 ├──< event          (game events: overtakes, penalties, SC...)
//                 ├──< engineer_call  (PUSH / HOLD / BOX / PIT, when it changed)
//                 ├──< radio_message  (each new radio card)
//                 └──< weather_sample (when the weather or temperatures change)
//
// A session is written once, in one transaction, when it ends (or the bridge
// stops). Writing it again (same game session UID) replaces it, so re-running
// the ingest never duplicates anything. Times are integers in ms unless named
// _s; booleans are 0/1. The views (v_*) are the readable way in.
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { TRACKS } = require('../udp/gameIds');
const { RACE_SESSION_TYPES, sessionName } = require('../state/race');
const { sessionStart } = require('../lib/sessionTime');

// Schema versions, kept in the file's PRAGMA user_version. Version 1 is the first release's tables (SCHEMA below,
// written as IF NOT EXISTS, which also adds any whole new table to an old file). A new column on a table that
// already shipped is a numbered step here instead: add one at the end, never edit one that has shipped, and keep it
// safe to run on a file that already has the change. `up(db)` runs in a transaction with the version bump.
const MIGRATIONS = [
  {
    version: 2,
    name: 'battery columns on trace_point',
    up(db) {
      const cols = db.prepare('PRAGMA table_info(trace_point)').all().map((c) => c.name);
      if (!cols.includes('ers_pct')) db.exec('ALTER TABLE trace_point ADD COLUMN ers_pct REAL');
      if (!cols.includes('ers_mode')) db.exec('ALTER TABLE trace_point ADD COLUMN ers_mode INTEGER');
    },
  },
  {
    version: 3,
    name: 'learn switch on session',
    up(db) {
      const cols = db.prepare('PRAGMA table_info(session)').all().map((c) => c.name);
      if (!cols.includes('learn')) db.exec('ALTER TABLE session ADD COLUMN learn INTEGER NOT NULL DEFAULT 1');
    },
  },
];
const SCHEMA_VERSION = MIGRATIONS.length + 1;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS capture (
  capture_id     INTEGER PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE          -- captures/<name>, or 'live' for a session without one
);
CREATE TABLE IF NOT EXISTS session (
  session_id     INTEGER PRIMARY KEY,
  session_uid    TEXT NOT NULL UNIQUE,         -- the game's 64-bit session id
  capture_id     INTEGER NOT NULL REFERENCES capture ON DELETE CASCADE,
  track_id       INTEGER,
  track          TEXT,
  session_type   INTEGER,
  session_name   TEXT,
  is_race        INTEGER NOT NULL,
  total_laps     INTEGER,
  track_length_m INTEGER,
  player_car_idx INTEGER,
  started_at_ms  INTEGER NOT NULL,             -- epoch ms
  ended_at_ms    INTEGER NOT NULL,
  official       INTEGER NOT NULL,             -- 1 once the game's final classification arrived
  learn          INTEGER NOT NULL DEFAULT 1    -- 0: the user switched "learn from this race" off
);
CREATE TABLE IF NOT EXISTS car (
  session_id       INTEGER NOT NULL REFERENCES session ON DELETE CASCADE,
  car_idx          INTEGER NOT NULL,
  driver           TEXT NOT NULL,
  team_id          INTEGER,
  race_number      INTEGER,
  is_player        INTEGER NOT NULL,
  is_ai            INTEGER,
  grid_position    INTEGER,
  finish_position  INTEGER,                    -- official when session.official, else last seen
  result_status    INTEGER,                    -- 2 active, 3 finished, 4 DNF, 5 DSQ, 7 retired
  points           INTEGER,
  laps_completed   INTEGER,
  best_lap_ms      INTEGER,
  race_time_ms     INTEGER,
  penalties_s      INTEGER,
  num_pit_stops    INTEGER,
  PRIMARY KEY (session_id, car_idx)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lap (
  session_id       INTEGER NOT NULL,
  car_idx          INTEGER NOT NULL,
  lap_num          INTEGER NOT NULL,
  lap_ms           INTEGER NOT NULL,
  s1_ms            INTEGER,
  s2_ms            INTEGER,
  s3_ms            INTEGER,
  valid            INTEGER,                    -- null: the game's lap history wasn't seen
  pit              INTEGER NOT NULL,           -- touched the pit lane (in-lap or out-lap)
  neutralised      INTEGER NOT NULL,           -- any part under SC, VSC or red flag
  compound         INTEGER,                    -- visual: 16 soft, 17 medium, 18 hard, 7 inter, 8 wet
  tyre_age         INTEGER,
  fuel_kg          REAL,
  position         INTEGER,                    -- as the car crossed the line
  gap_to_leader_ms INTEGER,
  num_pit_stops    INTEGER,
  wear_max_pct     REAL,
  PRIMARY KEY (session_id, car_idx, lap_num),
  FOREIGN KEY (session_id, car_idx) REFERENCES car ON DELETE CASCADE
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS stint (
  session_id INTEGER NOT NULL,
  car_idx    INTEGER NOT NULL,
  stint_num  INTEGER NOT NULL,
  compound   INTEGER,
  start_lap  INTEGER NOT NULL,
  end_lap    INTEGER NOT NULL,
  PRIMARY KEY (session_id, car_idx, stint_num),
  FOREIGN KEY (session_id, car_idx) REFERENCES car ON DELETE CASCADE
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS trace_point (
  session_id    INTEGER NOT NULL,
  car_idx       INTEGER NOT NULL,
  lap_num       INTEGER NOT NULL,
  distance_m    REAL NOT NULL,
  lap_time_ms   INTEGER NOT NULL,
  speed_kmh     INTEGER NOT NULL,
  throttle      REAL NOT NULL,                 -- 0..1
  brake         REAL NOT NULL,                 -- 0..1
  steer         REAL NOT NULL,                 -- -1 (left) .. 1
  gear          INTEGER NOT NULL,
  ers_pct       REAL,                          -- the battery, % of the 4 MJ store (the player's laps)
  ers_mode      INTEGER,                       -- deploy mode: 0 none, 1 medium, 2 hotlap, 3 overtake / boost
  PRIMARY KEY (session_id, car_idx, lap_num, distance_m),
  FOREIGN KEY (session_id, car_idx) REFERENCES car ON DELETE CASCADE
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS event (
  event_id       INTEGER PRIMARY KEY,
  session_id     INTEGER NOT NULL REFERENCES session ON DELETE CASCADE,
  session_time_s REAL NOT NULL,
  lap_num        INTEGER NOT NULL,             -- the car's lap, or the player's for race-wide events
  code           TEXT NOT NULL,                -- OVTK, PENA, SCAR, FTLP, RTMT, RDFL, COLL...
  description    TEXT NOT NULL,
  car_idx        INTEGER,                      -- who it's about (the overtaker, the penalised car)
  other_car_idx  INTEGER,                      -- the car overtaken / collided with
  value          REAL                          -- penalty s, fastest-lap s, speed-trap km/h
);
CREATE INDEX IF NOT EXISTS event_by_lap ON event (session_id, lap_num);
CREATE TABLE IF NOT EXISTS engineer_call (
  session_id     INTEGER NOT NULL REFERENCES session ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  session_time_s REAL NOT NULL,
  lap_num        INTEGER NOT NULL,
  action         TEXT NOT NULL,
  kind           TEXT,
  reason         TEXT,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS radio_message (
  session_id     INTEGER NOT NULL REFERENCES session ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  session_time_s REAL NOT NULL,
  lap_num        INTEGER NOT NULL,
  topic          TEXT NOT NULL,                -- the card's id: the same topic updates in place
  severity       TEXT,
  message        TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS corner_issue (
  session_id       INTEGER NOT NULL REFERENCES session ON DELETE CASCADE,
  session_time_s   REAL NOT NULL,
  lap_num          INTEGER NOT NULL,
  distance_m       INTEGER NOT NULL,             -- where the braking zone starts (the corner)
  kind             TEXT NOT NULL,                -- front_lock, rear_lock, wheelspin, understeer
  wheel            TEXT,                         -- FL, FR, RL, RR, Fronts, Rears
  brake_bias       INTEGER,                      -- front %, at the time
  diff_on_throttle INTEGER                       -- %, at the time
);
CREATE INDEX IF NOT EXISTS corner_issue_by_lap ON corner_issue (session_id, lap_num);
CREATE TABLE IF NOT EXISTS car_setting (
  session_id        INTEGER NOT NULL REFERENCES session ON DELETE CASCADE,
  session_time_s    REAL NOT NULL,
  lap_num           INTEGER NOT NULL,
  brake_bias        INTEGER,                     -- front %
  diff_on_throttle  INTEGER,
  diff_off_throttle INTEGER,
  engine_braking    INTEGER,
  ers_mode          INTEGER,                     -- 0 none, 1 medium, 2 hotlap, 3 overtake / boost
  PRIMARY KEY (session_id, session_time_s)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS setup_run (
  session_id     INTEGER NOT NULL REFERENCES session ON DELETE CASCADE,
  session_time_s REAL NOT NULL,
  lap_num        INTEGER NOT NULL,             -- the player's lap it was first seen on
  setup          TEXT NOT NULL,                -- JSON: the fourteen values of analysis/setupCompare.js by key
  PRIMARY KEY (session_id, session_time_s)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS setup_note (
  track_id      INTEGER NOT NULL,
  setup_key     TEXT NOT NULL,                 -- analysis/setupLibrary.js identity(): a hash of the setup's values
  name          TEXT NOT NULL DEFAULT '',
  favorite      INTEGER NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT '',
  setup         TEXT NOT NULL,                 -- JSON of the values, so a named setup survives its sessions
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (track_id, setup_key)
) WITHOUT ROWID;                                -- not under session: re-reading a recording or deleting a race must not take a name away
CREATE TABLE IF NOT EXISTS weather_sample (
  session_id     INTEGER NOT NULL REFERENCES session ON DELETE CASCADE,
  session_time_s REAL NOT NULL,
  lap_num        INTEGER NOT NULL,
  weather        INTEGER,                      -- 0 clear .. 5 storm
  track_temp_c   INTEGER,
  air_temp_c     INTEGER,
  rain_pct       INTEGER,
  PRIMARY KEY (session_id, session_time_s)
) WITHOUT ROWID;
`;

// Views hold no data: rebuilt on every open, so a changed view reaches an existing file.
const VIEWS = `
DROP VIEW IF EXISTS v_lap;
DROP VIEW IF EXISTS v_result;
DROP VIEW IF EXISTS v_event;
CREATE VIEW v_lap AS
  SELECT s.session_id, s.track, s.session_name, c.driver, c.is_player, l.*,
         printf('%d:%06.3f', l.lap_ms / 60000, (l.lap_ms % 60000) / 1000.0) AS lap_time
  FROM lap l JOIN car c USING (session_id, car_idx) JOIN session s USING (session_id);
CREATE VIEW v_result AS
  SELECT s.session_id, s.track, s.session_name, c.finish_position, c.driver, c.is_player, c.grid_position,
         c.grid_position - c.finish_position AS places_gained, c.points, c.num_pit_stops, c.best_lap_ms,
         c.race_time_ms, c.penalties_s, c.result_status
  FROM car c JOIN session s USING (session_id)
  ORDER BY s.session_id, c.finish_position;
CREATE VIEW v_event AS
  SELECT e.session_id, e.lap_num, e.session_time_s, e.code, e.description,
         a.driver AS driver, b.driver AS other_driver, e.value
  FROM event e
  LEFT JOIN car a ON a.session_id = e.session_id AND a.car_idx = e.car_idx
  LEFT JOIN car b ON b.session_id = e.session_id AND b.car_idx = e.other_car_idx;
`;

const b = (v) => (v == null ? null : v ? 1 : 0);

// file: a path, or ':memory:' (tests). An older file is upgraded step by step (see MIGRATIONS) after a copy of it
// is left beside it as <file>.before-v<N>; a file from a newer Undercut is refused. Options: migrations (tests).
function openStore(file, { migrations = MIGRATIONS } = {}) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL'); // readers (an LLM tool, a notebook) don't block the bridge's writes
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000'); // a backfill in a worker and a live save share the file: wait, do not fail
  const latest = migrations.length ? migrations[migrations.length - 1].version : 1;
  const stamped = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (stamped > latest) {
    db.close();
    throw new Error(`${file} is schema v${stamped}; this code knows v${latest}`);
  }
  const hasTables = Number(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().n) > 0;
  // Never stamped but with tables: written before versions were kept, so version 1.
  const from = stamped || (hasTables ? 1 : latest);
  const pending = migrations.filter((m) => m.version > from);
  const backup = `${file}.before-v${latest}`;
  if (pending.length && hasTables && file !== ':memory:' && !fs.existsSync(backup)) {
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`); // a consistent copy, WAL included
  }
  db.exec(SCHEMA);
  for (const m of pending) {
    db.exec('BEGIN');
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      db.close();
      throw err;
    }
  }
  if (!stamped && !pending.length) db.exec(`PRAGMA user_version = ${latest}`);
  db.exec(VIEWS);

  const sql = {
    capture: db.prepare('INSERT INTO capture (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = name RETURNING capture_id'),
    dropSession: db.prepare('DELETE FROM session WHERE session_uid = ?'),
    learnOf: db.prepare('SELECT learn FROM session WHERE session_uid = ?'),
    setLearn: db.prepare('UPDATE session SET learn = ? WHERE session_uid = ?'),
    session: db.prepare(`INSERT INTO session (session_uid, capture_id, track_id, track, session_type, session_name, is_race, total_laps,
      track_length_m, player_car_idx, started_at_ms, ended_at_ms, official, learn) VALUES
      (@uid, @captureId, @trackId, @track, @sessionType, @sessionName, @isRace, @totalLaps, @trackLength, @playerIdx, @startedAt, @endedAt, @official, @learn)`),
    car: db.prepare(`INSERT INTO car VALUES (@sid, @carIdx, @driver, @teamId, @raceNumber, @isPlayer, @isAi, @grid, @finish, @resultStatus,
      @points, @lapsCompleted, @bestLapMs, @raceTimeMs, @penaltiesS, @numPitStops)`),
    lap: db.prepare(`INSERT INTO lap VALUES (@sid, @carIndex, @lapNum, @lapMs, @s1, @s2, @s3, @valid, @pit, @neutralised, @compound, @tyreAge,
      @fuelKg, @position, @gapToLeaderMs, @numPitStops, @wearMax)`),
    stint: db.prepare('INSERT INTO stint VALUES (?, ?, ?, ?, ?, ?)'),
    point: db.prepare('INSERT OR IGNORE INTO trace_point (session_id, car_idx, lap_num, distance_m, lap_time_ms, speed_kmh, throttle, brake, steer, gear, ers_pct, ers_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    event: db.prepare('INSERT INTO event (session_id, session_time_s, lap_num, code, description, car_idx, other_car_idx, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    call: db.prepare('INSERT INTO engineer_call VALUES (?, ?, ?, ?, ?, ?, ?)'),
    radio: db.prepare('INSERT INTO radio_message VALUES (?, ?, ?, ?, ?, ?, ?)'),
    weather: db.prepare('INSERT OR REPLACE INTO weather_sample VALUES (?, ?, ?, ?, ?, ?, ?)'),
    issue: db.prepare('INSERT INTO corner_issue VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    setting: db.prepare('INSERT OR REPLACE INTO car_setting VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    setupRun: db.prepare('INSERT OR REPLACE INTO setup_run VALUES (?, ?, ?, ?)'),
    setupSessions: db.prepare('SELECT session_id, session_type, session_name, started_at_ms FROM session WHERE track_id = ? ORDER BY started_at_ms'),
    noteGet: db.prepare('SELECT * FROM setup_note WHERE track_id = ? AND setup_key = ?'),
    noteSet: db.prepare('INSERT OR REPLACE INTO setup_note (track_id, setup_key, name, favorite, note, setup, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    notes: db.prepare('SELECT * FROM setup_note'),
    libSessions: db.prepare(`SELECT k.name AS capture, s.session_id, s.session_uid, s.track_id, s.track, s.session_type, s.session_name, s.is_race, s.total_laps, s.started_at_ms, c.car_idx, c.grid_position, c.finish_position
      FROM session s JOIN capture k USING (capture_id) JOIN car c ON c.session_id = s.session_id AND c.is_player = 1
      WHERE EXISTS (SELECT 1 FROM setup_run r WHERE r.session_id = s.session_id) ORDER BY s.started_at_ms`),
    libLaps: db.prepare('SELECT lap_num, lap_ms, valid, pit, neutralised, compound, fuel_kg FROM lap WHERE session_id = ? AND car_idx = ? ORDER BY lap_num'),
    libWeather: db.prepare('SELECT weather, track_temp_c, air_temp_c, rain_pct FROM weather_sample WHERE session_id = ? ORDER BY session_time_s'),
    setupRuns: db.prepare('SELECT lap_num, setup FROM setup_run WHERE session_id = ? ORDER BY session_time_s'),
    trackHistory: db.prepare(`SELECT k.name AS capture, s.session_type, s.session_name, s.is_race, s.total_laps, s.started_at_ms, c.grid_position, c.finish_position, c.num_pit_stops,
      (SELECT MIN(l.lap_ms) FROM lap l WHERE l.session_id = s.session_id AND l.car_idx = c.car_idx AND l.pit = 0 AND l.neutralised = 0 AND l.valid IS NOT 0 AND l.lap_ms > 0) AS best_lap_ms
      FROM session s JOIN capture k USING (capture_id) JOIN car c ON c.session_id = s.session_id AND c.is_player = 1 WHERE s.track_id = ? ORDER BY s.started_at_ms`),
    playerLaps: db.prepare('SELECT l.lap_num, l.lap_ms, l.valid, l.pit, l.neutralised, l.compound FROM lap l JOIN car c USING (session_id, car_idx) WHERE l.session_id = ? AND c.is_player = 1 ORDER BY l.lap_num'),
  };
  // Car and lap rows carry fields the tables don't keep (raceId, ...).
  sql.car.setAllowUnknownNamedParameters(true);
  sql.lap.setAllowUnknownNamedParameters(true);

  // s: a finished session from data/sessionRecorder.js.
  const write = (s) => {
    const before = sql.learnOf.get(s.uid); // a race written again keeps the user's choice
    sql.dropSession.run(s.uid);
    const captureId = sql.capture.get(s.capture || 'live').capture_id;
    const sid = sql.session.run({
      uid: s.uid, captureId, trackId: s.session.trackId, track: TRACKS[s.session.trackId] || null,
      sessionType: s.session.sessionType, sessionName: sessionName(s.session),
      isRace: b(RACE_SESSION_TYPES.has(s.session.sessionType)), totalLaps: s.session.totalLaps,
      trackLength: s.session.trackLength || null, playerIdx: s.playerIdx, startedAt: s.startedAt, endedAt: s.endedAt, official: b(s.official), learn: before ? before.learn : 1,
    }).lastInsertRowid;
    for (const c of s.cars) sql.car.run({ sid, ...c, isPlayer: b(c.isPlayer), isAi: b(c.isAi) });
    for (const l of s.laps) sql.lap.run({ sid, ...l, valid: b(l.valid), pit: b(l.pit), neutralised: b(l.neutralised) });
    for (const t of s.stints) sql.stint.run(sid, t.carIdx, t.stintNum, t.compound, t.startLap, t.endLap);
    for (const t of s.traces) for (const p of t.points) sql.point.run(sid, t.carIdx, t.lapNum, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7] ?? null, p[8] ?? null);
    for (const e of s.events) sql.event.run(sid, e.sessionTime, e.lapNum, e.code, e.description, e.carIdx, e.otherCarIdx, e.value);
    s.calls.forEach((c, k) => sql.call.run(sid, k + 1, c.sessionTime, c.lapNum, c.action, c.kind, c.reason));
    s.radio.forEach((r, k) => sql.radio.run(sid, k + 1, r.sessionTime, r.lapNum, r.topic, r.severity, r.message));
    for (const w of s.weather) sql.weather.run(sid, w.sessionTime, w.lapNum, w.weather, w.trackTemp, w.airTemp, w.rainPct);
    for (const i of s.issues || []) sql.issue.run(sid, i.sessionTime, i.lapNum, i.distM, i.kind, i.wheel, i.brakeBias, i.diffOn);
    for (const c of s.settings || []) sql.setting.run(sid, c.sessionTime, c.lapNum, c.brakeBias, c.diffOn, c.diffOff, c.engineBraking, c.ersMode);
    for (const r of s.setups || []) sql.setupRun.run(sid, r.sessionTime, r.lapNum, JSON.stringify(r.values));
    return sid;
  };
  // One transaction per session: all of it is stored, or none.
  function writeSession(s) {
    db.exec('BEGIN');
    try {
      const sid = write(s);
      db.exec('COMMIT');
      return sid;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // Every child row goes with it (ON DELETE CASCADE). False if there was no such session.
  const deleteSession = (uid) => sql.dropSession.run(String(uid)).changes > 0;

  // Whether the app may learn from this race (null: no such race). Switching it off is the caller's cue to
  // forget what the race taught (state/trackMemory.js).
  const learns = (uid) => {
    const r = sql.learnOf.get(String(uid));
    return r ? r.learn === 1 : null;
  };
  const setLearn = (uid, on) => sql.setLearn.run(on ? 1 : 0, String(uid)).changes > 0;

  // The sessions at a track with the setups run and the player's laps (analysis/setupHistory.js ranks them).
  const setupSessions = (trackId) => sql.setupSessions.all(trackId).map((s) => ({
    sessionType: s.session_type, name: String(s.session_name), startedAt: Number(s.started_at_ms),
    runs: sql.setupRuns.all(s.session_id).map((r) => ({ fromLap: r.lap_num, setup: JSON.parse(String(r.setup)) })),
    laps: sql.playerLaps.all(s.session_id).map((l) => ({ lapNum: l.lap_num, lapMs: l.lap_ms, valid: l.valid == null ? null : l.valid === 1, pit: l.pit === 1, neutralised: l.neutralised === 1, compound: l.compound })),
  }));

  // One row per session at a track, for the player: the pre-race briefing (analysis/briefing.js) reads it.
  const trackHistory = (trackId) => sql.trackHistory.all(trackId).map((r) => ({
    sessionType: Number(r.session_type), name: String(r.session_name), isRace: r.is_race === 1, totalLaps: Number(r.total_laps), startedAt: sessionStart(Number(r.started_at_ms), String(r.capture)) ?? Number(r.started_at_ms),
    grid: r.grid_position == null ? null : Number(r.grid_position), finish: r.finish_position == null ? null : Number(r.finish_position),
    stops: r.num_pit_stops == null ? null : Number(r.num_pit_stops), bestLapMs: r.best_lap_ms == null ? null : Number(r.best_lap_ms),
  }));

  // Every session with a recorded setup, for the setup library (analysis/setupLibrary.js): your runs, laps and the weather.
  const setupLibrarySessions = () => sql.libSessions.all().map((s) => ({
    uid: String(s.session_uid), sessionId: Number(s.session_id), trackId: Number(s.track_id), track: s.track == null ? null : String(s.track), sessionType: Number(s.session_type),
    name: String(s.session_name), isRace: s.is_race === 1, totalLaps: Number(s.total_laps), startedAt: sessionStart(Number(s.started_at_ms), String(s.capture)) ?? Number(s.started_at_ms),
    grid: s.grid_position == null ? null : Number(s.grid_position), finish: s.finish_position == null ? null : Number(s.finish_position),
    runs: sql.setupRuns.all(s.session_id).map((r) => ({ fromLap: Number(r.lap_num), setup: JSON.parse(String(r.setup)) })),
    laps: sql.libLaps.all(s.session_id, s.car_idx).map((l) => ({ lapNum: Number(l.lap_num), lapMs: Number(l.lap_ms), valid: l.valid == null ? null : l.valid === 1, pit: l.pit === 1, neutralised: l.neutralised === 1, compound: l.compound == null ? null : Number(l.compound), fuelKg: l.fuel_kg == null ? null : Number(l.fuel_kg) })),
    weather: sql.libWeather.all(s.session_id).map((w) => ({ weather: w.weather == null ? null : Number(w.weather), trackTemp: w.track_temp_c == null ? null : Number(w.track_temp_c), airTemp: w.air_temp_c == null ? null : Number(w.air_temp_c), rainPct: w.rain_pct == null ? null : Number(w.rain_pct) })),
  }));

  const noteRow = (r) => ({ trackId: Number(r.track_id), key: String(r.setup_key), name: String(r.name), favorite: r.favorite === 1, note: String(r.note), values: JSON.parse(String(r.setup)), updatedAt: Number(r.updated_at_ms) });
  const setupNotes = () => sql.notes.all().map(noteRow);
  // Names, stars and notes for a setup, by track and key. Only the fields given change; the rest stay. Refuses bad input.
  function saveSetupNote(input) {
    const bad = (why) => { throw new Error(`setup note: ${why}`); };
    if (!input || typeof input !== 'object') bad('nothing to save');
    const { trackId, key, name, favorite, note, values } = input;
    if (!Number.isInteger(trackId) || trackId < 0 || trackId > 255) bad('no such track');
    if (typeof key !== 'string' || !/^[0-9a-f]{12}$/.test(key)) bad('no such setup');
    if (name !== undefined && (typeof name !== 'string' || name.trim().length > 60)) bad('a name is at most 60 characters');
    if (note !== undefined && (typeof note !== 'string' || note.length > 500)) bad('a note is at most 500 characters');
    if (favorite !== undefined && typeof favorite !== 'boolean') bad('a favorite is on or off');
    if (values !== undefined && !(values && typeof values === 'object' && Object.values(values).every((v) => v === null || (typeof v === 'number' && Number.isFinite(v))))) bad('the setup values must be numbers');
    const before = sql.noteGet.get(trackId, key);
    if (!before && !values) bad('a new setup note needs its values');
    sql.noteSet.run(trackId, key, name !== undefined ? name.trim() : before ? String(before.name) : '', favorite !== undefined ? (favorite ? 1 : 0) : before ? Number(before.favorite) : 0,
      note !== undefined ? note : before ? String(before.note) : '', values !== undefined ? JSON.stringify(values) : String(before.setup), Date.now());
  }

  return { db, writeSession, setupSessions, setupLibrarySessions, setupNotes, saveSetupNote, trackHistory, deleteSession, learns, setLearn, close: () => db.close() };
}

module.exports = { openStore, MIGRATIONS, SCHEMA_VERSION };
