// Ask the race (roadmap L1): the only way the local model reaches the data. Each tool is a fixed,
// parameterised query over race.db on a read-only connection; the model picks a tool and its
// arguments, the engine computes every number. No tool takes SQL.
const { DatabaseSync } = require('node:sqlite');
const { compareLaps, describeCorner } = require('../analysis/lapCompare');

const lapTime = (ms) => (ms > 0 ? `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}` : null);
const int = (description) => ({ type: 'integer', description });
const SID = int('session_id from the sessions tool');
const DRIVER = { type: 'string', description: 'A driver name as the sessions use it; leave out for you (the player)' };

const TOOLS = {
  sessions: { description: 'Every saved session: track, type, date, your finish and laps. Start here to get a session_id.', props: {}, required: [] },
  lap_times: { description: 'Every lap of one car in a session: time, sectors, position, tyre, pit and safety-car flags, and whether telemetry was kept.', props: { session_id: SID, driver: DRIVER }, required: ['session_id'] },
  stints: { description: 'The tyre stints of one car in a session: compound and the laps each ran.', props: { session_id: SID, driver: DRIVER }, required: ['session_id'] },
  gaps: { description: 'The running order as the cars crossed the line on one lap: position, driver, gap to the leader.', props: { session_id: SID, lap: int('lap number') }, required: ['session_id', 'lap'] },
  calls: { description: 'The race engineer calls (PUSH, HOLD, BOX...) in a session, with the lap and the reason.', props: { session_id: SID }, required: ['session_id'] },
  events: { description: 'Game events in a session between two laps: overtakes, penalties, safety cars, fastest laps, retirements.', props: { session_id: SID, lap_from: int('first lap'), lap_to: int('last lap') }, required: ['session_id'] },
  compare_laps: { description: 'Two of your laps with telemetry, corner by corner: where lap_b lost or gained time on lap_a, and why.', props: { session_id: SID, lap_a: int('reference lap'), lap_b: int('lap to explain') }, required: ['session_id', 'lap_a', 'lap_b'] },
};

function createRaceTools(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const q = (sql) => db.prepare(sql);
  const sql = {
    sessions: q(`SELECT s.session_id, s.track, s.session_name, s.is_race, s.total_laps, s.started_at_ms, c.grid_position, c.finish_position, c.laps_completed
      FROM session s LEFT JOIN car c ON c.session_id = s.session_id AND c.is_player = 1 ORDER BY s.started_at_ms DESC LIMIT 50`),
    car: q('SELECT car_idx FROM car WHERE session_id = ? AND (CASE WHEN ? IS NULL THEN is_player = 1 ELSE upper(driver) = upper(?) END)'),
    laps: q(`SELECT l.*, EXISTS (SELECT 1 FROM trace_point t WHERE t.session_id = l.session_id AND t.car_idx = l.car_idx AND t.lap_num = l.lap_num) AS traced
      FROM lap l WHERE session_id = ? AND car_idx = ? ORDER BY lap_num`),
    stints: q('SELECT stint_num, compound, start_lap, end_lap FROM stint WHERE session_id = ? AND car_idx = ? ORDER BY stint_num'),
    gaps: q(`SELECT l.position, c.driver, c.is_player, l.gap_to_leader_ms, l.compound, l.tyre_age, l.pit FROM lap l JOIN car c USING (session_id, car_idx)
      WHERE l.session_id = ? AND l.lap_num = ? ORDER BY l.position`),
    calls: q('SELECT lap_num, action, kind, reason FROM engineer_call WHERE session_id = ? ORDER BY seq'),
    events: q('SELECT lap_num, code, description, driver, other_driver, value FROM v_event WHERE session_id = ? AND lap_num BETWEEN ? AND ? ORDER BY session_time_s LIMIT 200'),
    trace: q('SELECT distance_m, lap_time_ms, speed_kmh, throttle, brake, steer, gear FROM trace_point WHERE session_id = ? AND car_idx = ? AND lap_num = ? ORDER BY distance_m'),
  };
  const carOf = (sid, driver) => {
    const r = sql.car.get(sid, driver ?? null, driver ?? null);
    return r ? r.car_idx : null;
  };
  const noCar = (driver) => ({ error: driver ? `No driver called ${driver} in that session` : 'No player car in that session' });

  const run = {
    sessions: () => ({ sessions: sql.sessions.all().map((s) => ({ ...s, is_race: !!s.is_race, date: new Date(Number(s.started_at_ms)).toISOString().slice(0, 10) })) }),
    lap_times: ({ session_id: sid, driver }) => {
      const car = carOf(sid, driver);
      if (car == null) return noCar(driver);
      return {
        laps: sql.laps.all(sid, car).map((l) => ({
          lap: l.lap_num, ms: l.lap_ms, time: lapTime(l.lap_ms), s1_ms: l.s1_ms, s2_ms: l.s2_ms, s3_ms: l.s3_ms, position: l.position,
          compound: l.compound, tyre_age: l.tyre_age, pit: !!l.pit, safety_car: !!l.neutralised, valid: l.valid == null ? null : !!l.valid, has_telemetry: !!l.traced,
        })),
      };
    },
    stints: ({ session_id: sid, driver }) => {
      const car = carOf(sid, driver);
      return car == null ? noCar(driver) : { stints: sql.stints.all(sid, car) };
    },
    gaps: ({ session_id: sid, lap }) => ({ lap, cars: sql.gaps.all(sid, lap).map((c) => ({ ...c, is_player: !!c.is_player, pit: !!c.pit })) }),
    calls: ({ session_id: sid }) => ({ calls: sql.calls.all(sid) }),
    events: ({ session_id: sid, lap_from: from = 0, lap_to: to = 999 }) => ({ events: sql.events.all(sid, from, to) }),
    compare_laps: ({ session_id: sid, lap_a: a, lap_b: b }) => {
      const car = carOf(sid, null);
      if (car == null) return noCar(null);
      const lap = (n) => {
        const points = sql.trace.all(sid, car, n).map((p) => [p.distance_m, p.lap_time_ms, p.speed_kmh, p.throttle, p.brake, p.steer, p.gear]);
        const row = sql.laps.all(sid, car).find((l) => l.lap_num === n);
        return points.length > 10 && row ? { lapNum: n, lapMs: row.lap_ms, points } : null;
      };
      const la = lap(a);
      const lb = lap(b);
      if (!la || !lb) return { error: `No telemetry for lap ${la ? b : a}` };
      const c = compareLaps(la, lb);
      return {
        lap_a: { lap: a, time: lapTime(la.lapMs) },
        lap_b: { lap: b, time: lapTime(lb.lapMs) },
        total_s: c.totalS,
        corners: [...c.corners].sort((x, y) => Math.abs(y.timeS) - Math.abs(x.timeS)).slice(0, 5).map((k) => ({ corner: k.corner, at_km: +(k.atM / 1000).toFixed(1), time_s: k.timeS, summary: k.summary || describeCorner(k) })),
        headline: c.headline,
      };
    },
  };

  // Arguments checked against the schema before any query: known names, integers or strings only.
  function call(name, args) {
    const def = TOOLS[name];
    if (!def) return { error: `No tool called ${name}` };
    const a = args && typeof args === 'object' ? args : {};
    for (const k of Object.keys(a)) if (!def.props[k]) return { error: `${name} takes no argument "${k}"` };
    for (const k of def.required) if (a[k] == null) return { error: `${name} needs ${k}` };
    for (const [k, v] of Object.entries(a)) {
      if (def.props[k].type === 'integer' && !Number.isInteger(v)) return { error: `${name}: ${k} must be an integer` };
      if (def.props[k].type === 'string' && (typeof v !== 'string' || v.length > 60)) return { error: `${name}: ${k} must be a short string` };
    }
    return run[name](a);
  }

  const schemas = Object.entries(TOOLS).map(([name, d]) => ({
    type: 'function',
    function: { name, description: d.description, parameters: { type: 'object', properties: d.props, required: d.required, additionalProperties: false } },
  }));
  return { schemas, run: call, db, close: () => db.close() };
}

module.exports = { createRaceTools };
