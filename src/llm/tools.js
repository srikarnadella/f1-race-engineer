// Ask the race (roadmap L1): the only way the local model reaches the data. Each tool is a fixed,
// parameterised query over race.db on a read-only connection; the model picks a tool and its
// arguments, the engine computes every number. No tool takes SQL.
//
// Written for small models: tyres by name, times in seconds, events filtered to what happened to you
// and to the race, and bind(sessionId) to answer about one session without a session_id argument.
const { DatabaseSync } = require('node:sqlite');
const { compareLaps, describeCorner, lapCorners, resample } = require('../analysis/lapCompare');
const { analyzeSteering } = require('./steering');
const { adviseCorners, liftAndCoast, balanceAdvice, batteryLap } = require('./coaching');
const { median } = require('../lib/stats');
const { stopsOf } = require('../analysis/callsAudit');
const { stintReport, stopReview, lapLosses, fieldPace, callsReview, trackHistory, raceSummary } = require('./insights');

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
  lap_coaching: { description: 'What to do better, corner by corner: one of your laps against your best lap (braking point, apex speed, getting back to full throttle, coasting), biggest loss first. Leave lap out for a typical lap of yours.', props: { session_id: SID, lap: int('your lap to coach; leave out for a typical one') }, required: ['session_id'] },
  lift_and_coast: { description: 'Where to lift and coast to save fuel: the braking zones after your longest flat-out runs, where you coast now, and your fuel use a lap.', props: { session_id: SID, lap: int('lap to read; leave out for your best lap') }, required: ['session_id'] },
  car_balance: { description: 'Brake bias and differential: what the car did at each corner on each lap (front or rear wheels locking, wheelspin or understeer on exit), the bias and diff you ran, and what to change.', props: { session_id: SID }, required: ['session_id'] },
  battery: { description: 'The battery round one of your laps: where you deployed and where it charged back, the lowest point, what was left at the line, and what to change. Leave lap out for your best lap.', props: { session_id: SID, lap: int('lap to read; leave out for your best lap') }, required: ['session_id'] },
  tyres: { description: 'Your tyre stints one at a time: clean laps, average and best lap, and whether the pace got slower or quicker over the stint, with the range it could be.', props: { session_id: SID }, required: ['session_id'] },
  pit_stops: { description: 'Your pit stops: the laps in and out, the tyres, what each cost against the cars that did not stop and against the stops of the rest of the field, and your place before and after.', props: { session_id: SID }, required: ['session_id'] },
  lap_losses: { description: 'How consistent you were, and the laps that cost the most time against your typical lap, each with what was recorded on it (collisions, penalties, passes, an invalid lap, locking).', props: { session_id: SID }, required: ['session_id'] },
  field_pace: { description: 'Race pace across the field: the typical clean lap of every car ranked, where you ranked, and who set the fastest lap.', props: { session_id: SID }, required: ['session_id'] },
  calls_review: { description: 'The calls the race engineer made, graded against the laps that followed: how many were right and wrong, and each one.', props: { session_id: SID }, required: ['session_id'] },
  track_history: { description: 'Your races at the track of this session in date order: result, best lap and typical lap, and how this race compares.', props: { session_id: SID }, required: ['session_id'] },
  steering_balance: { description: 'Oversteer and understeer read from your steering lap by lap against your own usual at each corner: where you needed extra lock with less speed, or caught a slide on or off the throttle, which of those repeated, and what to try (wings, off-throttle and on-throttle diff).', props: { session_id: SID }, required: ['session_id'] },
  race_summary: { description: 'The race in a few points: result, best lap, stops, race pace, the lap that cost the most, the engineer calls and one thing to work on.', props: { session_id: SID }, required: ['session_id'] },
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
    issues: q('SELECT lap_num, distance_m, kind, wheel, brake_bias, diff_on_throttle FROM corner_issue WHERE session_id = ? ORDER BY lap_num, distance_m'),
    settings: q('SELECT lap_num, brake_bias, diff_on_throttle, diff_off_throttle, engine_braking, ers_mode FROM car_setting WHERE session_id = ? ORDER BY session_time_s'),
    allLaps: q(`SELECT l.car_idx, c.driver, c.is_player, l.lap_num, l.lap_ms, l.pit, l.neutralised, l.valid, l.position
      FROM lap l JOIN car c USING (session_id, car_idx) WHERE l.session_id = ? ORDER BY l.car_idx, l.lap_num`),
    trace: q('SELECT distance_m, lap_time_ms, speed_kmh, throttle, brake, steer, gear, ers_pct, ers_mode FROM trace_point WHERE session_id = ? AND car_idx = ? AND lap_num = ? ORDER BY distance_m'),
  };
  // A lap's telemetry as lapCompare reads it, or null.
  function traceOf(sid, car, n, rows) {
    const row = rows.find((l) => l.lap_num === n);
    if (!row) return null;
    const points = sql.trace.all(sid, car, n).map((p) => [p.distance_m, p.lap_time_ms, p.speed_kmh, p.throttle, p.brake, p.steer, p.gear, p.ers_pct, p.ers_mode]);
    return points.length > 10 ? { lapNum: n, lapMs: row.lap_ms, points } : null;
  }
  // Your racing laps with telemetry, resampled every 5 m, and the corners of your best one: what the steering
  // analysis and its chart read. null if there is no player car.
  function steeringInput(sid) {
    const car = carOf(sid, null);
    if (car == null) return null;
    const rows = /** @type {any[]} */ (sql.laps.all(sid, car));
    const ok = rows.filter((l) => l.lap_num > 1 && !l.pit && !l.neutralised && l.valid !== 0)
      .map((l) => ({ row: l, t: traceOf(sid, car, l.lap_num, rows) })).filter((x) => x.t);
    if (!ok.length) return { laps: [], corners: [] };
    const best = ok.reduce((a, b) => (b.row.lap_ms < a.row.lap_ms ? b : a));
    return { laps: ok.map((x) => ({ lap: x.row.lap_num, r: resample(x.t.points, x.t.points[x.t.points.length - 1][0]) })), corners: lapCorners(best.t.points) };
  }
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
    lap_coaching: ({ session_id: sid, lap }) => {
      const car = carOf(sid, null);
      if (car == null) return noCar(null);
      const rows = /** @type {any[]} */ (sql.laps.all(sid, car));
      const traced = rows.filter((l) => l.lap_num > 1 && !l.pit && !l.neutralised && l.valid !== 0 && traceOf(sid, car, l.lap_num, rows));
      if (traced.length < 2) return { error: 'Needs two clean laps with telemetry' };
      const best = traced.reduce((a, b) => (b.lap_ms < a.lap_ms ? b : a));
      // A typical lap: the one closest to your median clean lap, not the best.
      const mid = median(traced.map((l) => l.lap_ms));
      const which = lap ?? traced.filter((l) => l !== best).reduce((a, b) => (Math.abs(b.lap_ms - mid) < Math.abs(a.lap_ms - mid) ? b : a)).lap_num;
      if (which === best.lap_num) return { error: `Lap ${which} is your best lap: there's nothing faster of yours to coach it against` };
      const la = traceOf(sid, car, best.lap_num, rows);
      const lb = traceOf(sid, car, which, rows);
      if (!lb) return { error: `No telemetry for lap ${which}` };
      const c = compareLaps(la, lb);
      const lost = c.corners.filter((k) => k.timeS > 0).reduce((a, k) => a + k.timeS, 0);
      return {
        lap: which, best_lap: best.lap_num, typical: lap == null,
        verdict: `Lap ${which} (${lapTime(lb.lapMs)}) was ${Math.abs(c.totalS).toFixed(3)} s ${c.totalS >= 0 ? 'slower' : 'faster'} than your best, lap ${best.lap_num} (${lapTime(la.lapMs)})`,
        in_corners_s: +lost.toFixed(2),
        between_corners_s: +Math.max(0, c.totalS - lost).toFixed(2),
        advice: adviseCorners(c.corners, { best: best.lap_num, lap: which }).slice(0, 5),
      };
    },
    lift_and_coast: ({ session_id: sid, lap }) => {
      const car = carOf(sid, null);
      if (car == null) return noCar(null);
      const rows = /** @type {any[]} */ (sql.laps.all(sid, car));
      const clean = rows.filter((l) => l.lap_num > 1 && !l.pit && !l.neutralised && l.valid !== 0);
      const best = clean.filter((l) => traceOf(sid, car, l.lap_num, rows)).reduce((a, b) => (!a || b.lap_ms < a.lap_ms ? b : a), null);
      const which = lap ?? (best && best.lap_num);
      const t = which != null && traceOf(sid, car, which, rows);
      if (!t) return { error: `No telemetry for lap ${which ?? '(none)'}` };
      // Fuel a lap: the median drop in the tank between consecutive clean laps.
      const drops = [];
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1];
        const b = rows[i];
        if (b.lap_num === a.lap_num + 1 && a.fuel_kg != null && b.fuel_kg != null && !b.pit && !a.pit && a.fuel_kg > b.fuel_kg) drops.push(a.fuel_kg - b.fuel_kg);
      }
      return liftAndCoast(lapCorners(t.points), { lap: which, fuelPerLapKg: drops.length ? median(drops) : null });
    },
    battery: ({ session_id: sid, lap }) => {
      const car = carOf(sid, null);
      if (car == null) return noCar(null);
      const rows = /** @type {any[]} */ (sql.laps.all(sid, car));
      const best = rows.filter((l) => l.lap_num > 1 && !l.pit && !l.neutralised && l.valid !== 0 && traceOf(sid, car, l.lap_num, rows)).reduce((a, b) => (!a || b.lap_ms < a.lap_ms ? b : a), null);
      const which = lap ?? (best && best.lap_num);
      const t = which != null && traceOf(sid, car, which, rows);
      if (!t) return { error: `No telemetry for lap ${which ?? '(none)'}` };
      return batteryLap(t.points, lapCorners(t.points), { lap: which });
    },
    car_balance: ({ session_id: sid }) => {
      const car = carOf(sid, null);
      if (car == null) return noCar(null);
      const rows = /** @type {any[]} */ (sql.issues.all(sid));
      const settings = /** @type {any[]} */ (sql.settings.all(sid));
      if (!rows.length && !settings.length) return { error: 'This session was saved before Undercut kept what the car did at each corner and your bias and diff settings; sessions from now on have them.' };
      const laps = /** @type {any[]} */ (sql.laps.all(sid, car));
      const racing = laps.filter((l) => l.lap_num > 1 && !l.pit && !l.neutralised);
      // Corner numbers as the lap comparisons count them, from your best lap with telemetry.
      const best = racing.filter((l) => traceOf(sid, car, l.lap_num, laps)).reduce((a, b) => (!a || b.lap_ms < a.lap_ms ? b : a), null);
      const corners = best ? lapCorners(traceOf(sid, car, best.lap_num, laps).points) : [];
      const last = settings[settings.length - 1] || {};
      const out = balanceAdvice(rows, { corners, racingLaps: racing.length, bias: last.brake_bias ?? null, diff: last.diff_on_throttle ?? null });
      const changes = settings.filter((x, i) => i > 0 && (x.brake_bias !== settings[i - 1].brake_bias || x.diff_on_throttle !== settings[i - 1].diff_on_throttle));
      return {
        settings: { brake_bias: settings[0] ? settings[0].brake_bias : null, diff_on_throttle: settings[0] ? settings[0].diff_on_throttle : null, diff_off_throttle: settings[0] ? settings[0].diff_off_throttle : null },
        changed: changes.map((x) => ({ lap: x.lap_num, brake_bias: x.brake_bias, diff_on_throttle: x.diff_on_throttle })),
        ...out,
      };
    },
    tyres: ({ session_id: sid }) => {
      const mine = anyRun.lap_times({ session_id: sid });
      if (mine.error) return mine;
      return stintReport(mine.laps, anyRun.stints({ session_id: sid }).stints);
    },
    pit_stops: ({ session_id: sid }) => {
      const mine = anyRun.lap_times({ session_id: sid });
      if (mine.error) return mine;
      const laps = sql.allLaps.all(sid).map((l) => ({ carIndex: l.car_idx, lapNum: l.lap_num, lapMs: l.lap_ms, pit: !!l.pit, neutralised: !!l.neutralised, isPlayer: !!l.is_player }));
      return stopReview({ stops: stopsOf(laps), laps: mine.laps, stints: anyRun.stints({ session_id: sid }).stints });
    },
    lap_losses: ({ session_id: sid }) => {
      const mine = anyRun.lap_times({ session_id: sid });
      if (mine.error) return mine;
      return lapLosses({ laps: mine.laps, events: anyRun.events({ session_id: sid }).events || [], issues: /** @type {any[]} */ (sql.issues.all(sid)) });
    },
    field_pace: ({ session_id: sid }) => {
      const cars = new Map();
      for (const l of /** @type {any[]} */ (sql.allLaps.all(sid))) {
        if (!cars.has(l.car_idx)) cars.set(l.car_idx, { driver: l.driver, you: !!l.is_player, laps: [] });
        cars.get(l.car_idx).laps.push({ lap: l.lap_num, ms: l.lap_ms, pit: !!l.pit, safety_car: !!l.neutralised, valid: l.valid == null ? null : !!l.valid });
      }
      return cars.size ? fieldPace([...cars.values()]) : { error: 'No laps recorded for this session' };
    },
    calls_review: ({ session_id: sid }) => callsReview(require('../data/storeAudit').auditFromStore(db, sid)),
    track_history: ({ session_id: sid }) => {
      const t = require('../data/trends').trends(db).tracks.find((x) => x.races.some((r) => r.sessionId === sid));
      return t ? trackHistory({ track: t.track, races: t.races, sessionId: sid }) : { error: 'Track history compares races; this session is not a race (or has no clean laps)' };
    },
    steering_balance: ({ session_id: sid }) => {
      const inp = steeringInput(sid);
      if (!inp) return noCar(null);
      const settings = /** @type {any[]} */ (sql.settings.all(sid));
      const last = settings[settings.length - 1] || {};
      return analyzeSteering({ ...inp, setting: { brake_bias: last.brake_bias, diff_on_throttle: last.diff_on_throttle, diff_off_throttle: last.diff_off_throttle }, issues: /** @type {any[]} */ (sql.issues.all(sid)) });
    },
    race_summary: ({ session_id: sid }) => {
      const sess = anyRun.sessions().sessions.find((x) => x.session_id === sid);
      if (!sess) return { error: 'No such session' };
      const safe = (name) => { try { const r = anyRun[name]({ session_id: sid }); return r && !r.error ? r : null; } catch (_) { return null; } };
      return raceSummary({ session: sess, laps: (anyRun.lap_times({ session_id: sid }).laps || []), stops: safe('pit_stops'), losses: safe('lap_losses'), pace: safe('field_pace'), calls: safe('calls_review'), coaching: safe('lap_coaching') });
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

  // The new insight tools call the ones above by name, with only the arguments they need.
  const anyRun = /** @type {Record<string, (a?: any) => any>} */ (run);

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
