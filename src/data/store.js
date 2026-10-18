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
const Database = require('better-sqlite3');
const { TRACKS, SESSION_TYPES } = require('../udp/gameIds');
const { RACE_SESSION_TYPES } = require('../state/race');

const SCHEMA_VERSION = 1;
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
  official       INTEGER NOT NULL              -- 1 once the game's final classification arrived
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

// file: a path, or ':memory:' (tests).
function openStore(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL'); // readers (an LLM tool, a notebook) don't block the bridge's writes
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  const version = db.pragma('user_version', { simple: true });
  if (version > SCHEMA_VERSION) throw new Error(`${file} is schema v${version}; this code knows v${SCHEMA_VERSION}`);
  db.exec(SCHEMA);
  db.exec(VIEWS);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);

  const sql = {
    capture: db.prepare('INSERT INTO capture (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = name RETURNING capture_id'),
    dropSession: db.prepare('DELETE FROM session WHERE session_uid = ?'),
    session: db.prepare(`INSERT INTO session (session_uid, capture_id, track_id, track, session_type, session_name, is_race, total_laps,
      track_length_m, player_car_idx, started_at_ms, ended_at_ms, official) VALUES
      (@uid, @captureId, @trackId, @track, @sessionType, @sessionName, @isRace, @totalLaps, @trackLength, @playerIdx, @startedAt, @endedAt, @official)`),
    car: db.prepare(`INSERT INTO car VALUES (@sid, @carIdx, @driver, @teamId, @raceNumber, @isPlayer, @isAi, @grid, @finish, @resultStatus,
      @points, @lapsCompleted, @bestLapMs, @raceTimeMs, @penaltiesS, @numPitStops)`),
    lap: db.prepare(`INSERT INTO lap VALUES (@sid, @carIndex, @lapNum, @lapMs, @s1, @s2, @s3, @valid, @pit, @neutralised, @compound, @tyreAge,
      @fuelKg, @position, @gapToLeaderMs, @numPitStops, @wearMax)`),
    stint: db.prepare('INSERT INTO stint VALUES (?, ?, ?, ?, ?, ?)'),
    point: db.prepare('INSERT OR IGNORE INTO trace_point VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    event: db.prepare('INSERT INTO event (session_id, session_time_s, lap_num, code, description, car_idx, other_car_idx, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    call: db.prepare('INSERT INTO engineer_call VALUES (?, ?, ?, ?, ?, ?, ?)'),
    radio: db.prepare('INSERT INTO radio_message VALUES (?, ?, ?, ?, ?, ?, ?)'),
    weather: db.prepare('INSERT OR REPLACE INTO weather_sample VALUES (?, ?, ?, ?, ?, ?, ?)'),
  };

  // s: a finished session from data/sessionRecorder.js.
  const writeSession = db.transaction((s) => {
    sql.dropSession.run(s.uid);
    const captureId = sql.capture.pluck().get(s.capture || 'live');
    const sid = sql.session.run({
      uid: s.uid, captureId, trackId: s.session.trackId, track: TRACKS[s.session.trackId] || null,
      sessionType: s.session.sessionType, sessionName: SESSION_TYPES[s.session.sessionType] || null,
      isRace: b(RACE_SESSION_TYPES.has(s.session.sessionType)), totalLaps: s.session.totalLaps,
      trackLength: s.session.trackLength || null, playerIdx: s.playerIdx, startedAt: s.startedAt, endedAt: s.endedAt, official: b(s.official),
    }).lastInsertRowid;
    for (const c of s.cars) sql.car.run({ sid, ...c, isPlayer: b(c.isPlayer), isAi: b(c.isAi) });
    for (const l of s.laps) sql.lap.run({ sid, ...l, valid: b(l.valid), pit: b(l.pit), neutralised: b(l.neutralised) });
    for (const t of s.stints) sql.stint.run(sid, t.carIdx, t.stintNum, t.compound, t.startLap, t.endLap);
    for (const t of s.traces) for (const p of t.points) sql.point.run(sid, t.carIdx, t.lapNum, ...p);
    for (const e of s.events) sql.event.run(sid, e.sessionTime, e.lapNum, e.code, e.description, e.carIdx, e.otherCarIdx, e.value);
    s.calls.forEach((c, k) => sql.call.run(sid, k + 1, c.sessionTime, c.lapNum, c.action, c.kind, c.reason));
    s.radio.forEach((r, k) => sql.radio.run(sid, k + 1, r.sessionTime, r.lapNum, r.topic, r.severity, r.message));
    for (const w of s.weather) sql.weather.run(sid, w.sessionTime, w.lapNum, w.weather, w.trackTemp, w.airTemp, w.rainPct);
    return sid;
  });

  return { db, writeSession, close: () => db.close() };
}

module.exports = { openStore, SCHEMA_VERSION };
