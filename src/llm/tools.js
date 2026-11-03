// Ask the race (roadmap L1): the only way the local model reaches the data. Each tool is a fixed,
// parameterised query over race.db on a read-only connection; the model picks a tool and its
// arguments, the engine computes every number. No tool takes SQL.
//
// Written for small models: tyres by name, times in seconds, events filtered to what happened to you
// and to the race, and bind(sessionId) to answer about one session without a session_id argument.
const { DatabaseSync } = require('node:sqlite');
const { compareLaps, describeCorner } = require('../analysis/lapCompare');

const TYRE = { 16: 'soft', 17: 'medium', 18: 'hard', 7: 'inter', 8: 'wet' };
const tyre = (c) => TYRE[c] || (c == null ? null : 'unknown');
const lapTime = (ms) => (ms > 0 ? `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}` : null);
const sec = (ms) => (ms == null ? null : Math.round(ms) / 1000);
const int = (description) => ({ type: 'integer', description });
const SID = int('session_id from the sessions tool');
const DRIVER = { type: 'string', description: 'A driver name as the session lists it; leave out for you (the player)' };
// Events worth an answer; the rest (speed traps, start lights, buttons) is noise to a model.
const EVENT_CODES = ['OVTK', 'COLL', 'PENA', 'SCAR', 'RDFL', 'FTLP', 'RTMT', 'FLBK', 'CHQF', 'DTSV', 'SGSV'];
const RACE_WIDE = new Set(['SCAR', 'RDFL', 'CHQF', 'FLBK', 'FTLP']);
const STATUS = { 3: 'finished', 4: 'did not finish', 5: 'disqualified', 6: 'not classified', 7: 'retired' };

const TOOLS = {
  sessions: { description: 'Every saved session: track, type, date, your grid and finish. Start here to get a session_id.', props: {}, required: [] },
  lap_times: { description: 'Every lap of one car: lap time, sectors in seconds, position at the line, tyre and its age, and whether it was a pit, safety-car or invalid lap.', props: { session_id: SID, driver: DRIVER }, required: ['session_id'] },
  stints: { description: 'The tyre stints of one car: which tyre and the laps each ran.', props: { session_id: SID, driver: DRIVER }, required: ['session_id'] },
  gaps: { description: 'The running order as the cars crossed the line at the end of one lap: position, driver, seconds behind the leader, tyre.', props: { session_id: SID, lap: int('lap number') }, required: ['session_id', 'lap'] },
  results: { description: 'The finishing order: position, driver, grid, pit stops, best lap, penalties, and whether they finished.', props: { session_id: SID }, required: ['session_id'] },
  calls: { description: 'The race engineer calls (PUSH, HOLD, BOX...) in the session, with the lap and the reason.', props: { session_id: SID }, required: ['session_id'] },
  events: { description: 'What happened to you and to the race, in order: overtakes, collisions, penalties, safety cars, retirements, fastest laps. Optionally only between two laps, or about another driver.', props: { session_id: SID, lap_from: int('first lap'), lap_to: int('last lap'), driver: DRIVER }, required: ['session_id'] },
  compare_laps: { description: 'Two of your laps with telemetry, corner by corner: where lap_b lost or gained time on lap_a, and why (braking, apex and exit speed).', props: { session_id: SID, lap_a: int('reference lap'), lap_b: int('lap to explain') }, required: ['session_id', 'lap_a', 'lap_b'] },
};

// Sessions ingested from a recording store their start as an offset into it; the recording's
// name is its local start time (2026-10-19_173010). Returns epoch ms, or null if unknown.
function sessionStart(startedAtMs, captureName) {
  if (startedAtMs > 1e12) return startedAtMs;
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(captureName || '');
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() + startedAtMs;
}

// The day as you lived it (local time), not UTC: an evening race isn't tomorrow's.
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function createRaceTools(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const q = (sql) => db.prepare(sql);
  const codes = EVENT_CODES.map((c) => `'${c}'`).join(',');
  const sql = {
    sessions: q(`SELECT s.session_id, s.track, s.session_name, s.is_race, s.total_laps, s.started_at_ms, k.name AS capture, c.grid_position, c.finish_position, c.laps_completed
      FROM session s JOIN capture k USING (capture_id) LEFT JOIN car c ON c.session_id = s.session_id AND c.is_player = 1`),
    car: q('SELECT car_idx FROM car WHERE session_id = ? AND (CASE WHEN ? IS NULL THEN is_player = 1 ELSE upper(driver) = upper(?) END)'),
    laps: q(`SELECT l.*, EXISTS (SELECT 1 FROM trace_point t WHERE t.session_id = l.session_id AND t.car_idx = l.car_idx AND t.lap_num = l.lap_num) AS traced
      FROM lap l WHERE session_id = ? AND car_idx = ? ORDER BY lap_num`),
    stints: q('SELECT stint_num, compound, start_lap, end_lap FROM stint WHERE session_id = ? AND car_idx = ? ORDER BY stint_num'),
    gaps: q(`SELECT l.position, c.driver, c.is_player, l.gap_to_leader_ms, l.compound, l.tyre_age, l.pit FROM lap l JOIN car c USING (session_id, car_idx)
      WHERE l.session_id = ? AND l.lap_num = ? ORDER BY l.position`),
    calls: q('SELECT lap_num, action, kind, reason FROM engineer_call WHERE session_id = ? ORDER BY seq'),
    results: q(`SELECT finish_position, driver, is_player, grid_position, num_pit_stops, best_lap_ms, penalties_s, result_status FROM car
      WHERE session_id = ? AND finish_position > 0 ORDER BY finish_position`),
    events: q(`SELECT e.lap_num, e.code, e.description, a.driver, b.driver AS other_driver, e.value, e.car_idx, e.other_car_idx
      FROM event e LEFT JOIN car a ON a.session_id = e.session_id AND a.car_idx = e.car_idx LEFT JOIN car b ON b.session_id = e.session_id AND b.car_idx = e.other_car_idx
      WHERE e.session_id = ? AND e.lap_num BETWEEN ? AND ? AND e.code IN (${codes}) ORDER BY e.session_time_s`),
    trace: q('SELECT distance_m, lap_time_ms, speed_kmh, throttle, brake, steer, gear FROM trace_point WHERE session_id = ? AND car_idx = ? AND lap_num = ? ORDER BY distance_m'),
  };
  const carOf = (sid, driver) => {
    const r = sql.car.get(sid, driver ?? null, driver ?? null);
    return r ? r.car_idx : null;
  };
  const noCar = (driver) => ({ error: driver ? `No driver called ${driver} in that session` : 'No player car in that session' });

  const run = {
    sessions: () => ({
      sessions: sql.sessions.all()
        .map((s) => ({ s, at: sessionStart(Number(s.started_at_ms), s.capture) }))
        .sort((x, y) => (y.at || 0) - (x.at || 0))
        .map(({ s, at }) => ({
          session_id: s.session_id, track: s.track, type: s.session_name, is_race: !!s.is_race, total_laps: s.total_laps,
          date: at ? localDay(at) : null, grid: s.grid_position, finish: s.finish_position, laps_completed: s.laps_completed,
        })),
    }),
    lap_times: ({ session_id: sid, driver }) => {
      const car = carOf(sid, driver);
      if (car == null) return noCar(driver);
      return {
        laps: sql.laps.all(sid, car).map((l) => ({
          lap: l.lap_num, time: lapTime(l.lap_ms), ms: l.lap_ms, s1: sec(l.s1_ms), s2: sec(l.s2_ms), s3: sec(l.s3_ms), position: l.position,
          tyre: tyre(l.compound), tyre_age: l.tyre_age, pit: !!l.pit, safety_car: !!l.neutralised, valid: l.valid == null ? null : !!l.valid, has_telemetry: !!l.traced,
          gap_to_leader_s: sec(l.gap_to_leader_ms),
        })),
      };
    },
    stints: ({ session_id: sid, driver }) => {
      const car = carOf(sid, driver);
      return car == null ? noCar(driver) : { stints: sql.stints.all(sid, car).map((s) => ({ stint: s.stint_num, tyre: tyre(s.compound), from_lap: s.start_lap, to_lap: s.end_lap })) };
    },
    gaps: ({ session_id: sid, lap }) => ({
      lap,
      cars: sql.gaps.all(sid, lap).map((c) => ({ position: c.position, driver: c.driver, you: !!c.is_player, gap_to_leader_s: sec(c.gap_to_leader_ms), tyre: tyre(c.compound), tyre_age: c.tyre_age, pit: !!c.pit })),
    }),
    calls: ({ session_id: sid }) => ({ calls: sql.calls.all(sid) }),
    results: ({ session_id: sid }) => ({
      results: sql.results.all(sid).map((c) => ({
        position: c.finish_position, driver: c.driver, you: !!c.is_player, grid: c.grid_position, stops: c.num_pit_stops, best_lap: lapTime(c.best_lap_ms),
        penalties_s: c.penalties_s || 0, status: STATUS[c.result_status] || 'running',
      })),
    }),
    events: ({ session_id: sid, lap_from: from = 0, lap_to: to = 999, driver }) => {
      const me = carOf(sid, null);
      const who = driver ? carOf(sid, driver) : me;
      if (driver && who == null) return noCar(driver);
      const rows = sql.events.all(sid, from, to).filter((e) => (e.car_idx === who || e.other_car_idx === who) || (!driver && RACE_WIDE.has(String(e.code))));
      return {
        events: rows.slice(0, 80).map((e) => ({
          lap: e.lap_num, code: e.code, what: e.description, driver: e.driver, other_driver: e.other_driver, value: e.value,
          involves_you: e.car_idx === me || e.other_car_idx === me,
          by_you: e.car_idx === me, // the overtaker, the one penalised
        })),
      };
    },
    compare_laps: ({ session_id: sid, lap_a: a, lap_b: b }) => {
      const car = carOf(sid, null);
      if (car == null) return noCar(null);
      const rows = sql.laps.all(sid, car);
      const lap = (n) => {
        const points = sql.trace.all(sid, car, n).map((p) => [p.distance_m, p.lap_time_ms, p.speed_kmh, p.throttle, p.brake, p.steer, p.gear]);
        const row = rows.find((l) => l.lap_num === n);
        return points.length > 10 && row ? { lapNum: n, lapMs: row.lap_ms, points } : null;
      };
      const la = lap(a);
      const lb = lap(b);
      if (!la || !lb) return { error: `No telemetry for lap ${la ? b : a}` };
      const c = compareLaps(la, lb);
      // Spelt out from lap_b's side ("Lap 5 lost 0.43 s to lap 2 at corner 2"), biggest loss first:
      // a small model mixes up "lost" and "gained" otherwise.
      const corners = [...c.corners].sort((x, y) => y.timeS - x.timeS).slice(0, 5).map((k) => {
        const why = (k.summary || describeCorner(k)).split(' - ')[1];
        return {
          corner: k.corner, at_km: +(k.atM / 1000).toFixed(1), lap_b_lost_s: +k.timeS.toFixed(2),
          text: `Lap ${b} ${k.timeS >= 0 ? 'lost' : 'gained'} ${Math.abs(k.timeS).toFixed(2)} s ${k.timeS >= 0 ? 'to' : 'on'} lap ${a} at corner ${k.corner} (${(k.atM / 1000).toFixed(1)} km)${why ? `: ${why}` : ''}`,
        };
      });
      return {
        lap_a: { lap: a, time: lapTime(la.lapMs) },
        lap_b: { lap: b, time: lapTime(lb.lapMs) },
        total_s: c.totalS,
        verdict: `Lap ${b} was ${Math.abs(c.totalS).toFixed(3)} s ${c.totalS >= 0 ? 'slower' : 'faster'} than lap ${a}`,
        // The answer to "where did I lose the most time" stated outright: a small model doesn't rank.
        most_time_lost: corners.find((k) => k.lap_b_lost_s > 0)?.text || `Lap ${b} lost no time to lap ${a} at any corner`,
        corners,
      };
    },
  };

  // Arguments checked against the schema before any query: known names, integers or strings only.
  function invalid(name, a, defs) {
    const def = defs[name];
    if (!def) return { error: `No tool called ${name}` };
    for (const k of Object.keys(a)) if (!def.props[k]) return { error: `${name} takes no argument "${k}"` };
    for (const k of def.required) if (a[k] == null) return { error: `${name} needs ${k}` };
    for (const [k, v] of Object.entries(a)) {
      if (def.props[k].type === 'integer' && !Number.isInteger(v)) return { error: `${name}: ${k} must be an integer` };
      if (def.props[k].type === 'string' && (typeof v !== 'string' || v.length > 60)) return { error: `${name}: ${k} must be a short string` };
    }
    return null;
  }
  const argsOf = (args) => (args && typeof args === 'object' ? args : {});
  function call(name, args) {
    const a = argsOf(args);
    return invalid(name, a, TOOLS) || run[name](a);
  }

  const schemasOf = (defs) => Object.entries(defs).map(([name, d]) => ({
    type: 'function',
    function: { name, description: d.description, parameters: { type: 'object', properties: d.props, required: d.required, additionalProperties: false } },
  }));

  // One session's tools: no sessions tool, no session_id argument (one less thing to get wrong).
  function bind(sessionId) {
    const defs = {};
    for (const [name, d] of Object.entries(TOOLS)) {
      if (name === 'sessions') continue;
      const { session_id: _, ...props } = d.props;
      defs[name] = { ...d, props, required: d.required.filter((k) => k !== 'session_id') };
    }
    return {
      schemas: schemasOf(defs),
      run: (name, args) => {
        const a = argsOf(args);
        return invalid(name, a, defs) || run[name]({ ...a, session_id: sessionId });
      },
    };
  }

  // For charts (the engine's, never the model's): two of your laps' speed over distance, resampled
  // to the same points by lapCompare, with the corners. null if either lap has no telemetry.
  function compareTrace(sid, a, b) {
    const car = carOf(sid, null);
    if (car == null) return null;
    const rows = sql.laps.all(sid, car);
    const lap = (n) => {
      const points = sql.trace.all(sid, car, n).map((p) => [p.distance_m, p.lap_time_ms, p.speed_kmh, p.throttle, p.brake, p.steer, p.gear]);
      const row = rows.find((l) => l.lap_num === n);
      return points.length > 10 && row ? { lapNum: n, lapMs: row.lap_ms, points } : null;
    };
    const la = lap(a);
    const lb = lap(b);
    if (!la || !lb) return null;
    const c = compareLaps(la, lb);
    return { d: c.trace.d, speedA: c.trace.a.speed, speedB: c.trace.b.speed, delta: c.trace.delta, totalS: c.totalS, corners: c.corners };
  }

  return { schemas: schemasOf(TOOLS), run: (name, args) => call(name, args), bind, compareTrace, db, close: () => db.close() };
}

module.exports = { createRaceTools, sessionStart };
