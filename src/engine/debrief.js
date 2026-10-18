// Post-session debrief: a lap-by-lap record of the player's session plus a
// summary of the field, kept after the session ends. The game starts a new
// session (new sessionUID -> FieldModel reset) as soon as you leave the
// results screen, so the record lives here, outside the live model, and the
// last few sessions are kept for the Debrief screen.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { median } = require('../lib/stats');
const { RACE_SESSION_TYPES } = require('../state/race');
const { SESSION_TYPES, TRACKS } = require('../udp/gameIds');
const { compareLaps, consistency } = require('../analysis/lapCompare');
const { rivalAnalysis } = require('../analysis/rivals');

const KEEP_SESSIONS = 10;

const nameOf = (car, idx) => (car.participant && car.participant.name) || `Car ${idx}`;

// Fastest valid sector times in a car's Session History.
function bestSectors(sh) {
  const best = [null, null, null];
  for (const l of sh.laps) {
    if (!l.valid || !(l.lapMs > 0)) continue;
    ['s1', 's2', 's3'].forEach((k, i) => { if (l[k] > 0 && (best[i] == null || l[k] < best[i])) best[i] = l[k]; });
  }
  return best;
}

// Saved sessions: one gzipped JSON file per session in `dir` (data/sessions),
// written once when the session ends. The Maps go to arrays and back.
function toFile(rec) {
  // Only the rival laps lap compare offers: all 21 would double the file, and every saved session is reloaded at start.
  const rivalBest = [...rec.rivalBest].sort((x, y) => x[1].lapMs - y[1].lapMs).slice(0, RIVAL_CHOICES);
  return zlib.gzipSync(JSON.stringify({ ...rec, field: [...rec.field], traces: [...rec.traces], rivalBest }));
}
function fromFile(buf) {
  const rec = JSON.parse(zlib.gunzipSync(buf));
  return { ...rec, field: new Map(rec.field), traces: new Map(rec.traces), rivalBest: new Map(rec.rivalBest || []), generation: null };
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const RIVAL_ID = /^r\d+$/;
const RIVAL_CHOICES = 5; // rivals' best laps offered in lap compare

// dir: where to save finished sessions (null = keep them in memory only,
// e.g. the demo replay, tests and capture analysis).
function createDebrief(fieldModel, { dir = null } = {}) {
  const clock = fieldModel.clock || (() => Date.now());
  let current = null;
  const history = [];
  if (dir && fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json.gz')).sort().reverse().slice(0, KEEP_SESSIONS);
    for (const n of files) {
      try {
        history.push(fromFile(fs.readFileSync(path.join(dir, n))));
      } catch (err) {
        console.warn(`[debrief] skipping unreadable session ${n}: ${err.message}`);
      }
    }
  }

  function save(rec) {
    if (!dir || rec.saved) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date(rec.startedAt).toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const name = `${stamp}_${(TRACKS[rec.trackId] || 'track').replace(/\W+/g, '-')}_${(SESSION_TYPES[rec.sessionType] || 'session').replace(/\W+/g, '-')}.json.gz`;
      // Write then rename, so a crash mid-write can't leave a half-written file.
      fs.writeFileSync(path.join(dir, name + '.tmp'), toFile(rec));
      fs.renameSync(path.join(dir, name + '.tmp'), path.join(dir, name));
      rec.saved = true;
    } catch (err) {
      console.warn(`[debrief] couldn't save the session: ${err.message}`);
    }
  }

  function start(generation, session) {
    return {
      id: `${clock().toString(36)}`,
      generation,
      startedAt: clock(),
      sessionType: session ? session.sessionType : null,
      trackId: session ? session.trackId : null,
      totalLaps: session ? session.totalLaps : null,
      laps: [], // the player's completed laps
      pending: null, // { lapNum, s1, s2, invalid } for the lap in progress
      gridPosition: null,
      field: new Map(), // carIndex -> { name, position, bestMs, stops, compounds: [], status }
      penalties: [],
      lastEventSeq: 0,
      safetyCars: 0,
      fastestLap: null, // { name, ms }
      traces: new Map(), // lapNum -> the player's input trace (debrief lap comparison)
      rivalBest: new Map(), // carIndex -> { name, ...trace } of that car's best clean lap
      classification: null, // Final Classification: the official result
      lapPositions: null, // every car's position at the start of each lap
      playerIdx: null,
      trackLength: session ? session.trackLength : null,
    };
  }

  function archive() {
    if (current && current.laps.length) {
      save(current);
      history.unshift(current);
      if (history.length > KEEP_SESSIONS) history.pop();
    }
  }

  // Called on the engine's 10Hz tick.
  function tick() {
    const gen = fieldModel.getGeneration();
    const session = fieldModel.getSession();
    if (!current || current.generation !== gen) {
      archive();
      current = start(gen, session);
    }
    if (session && current.sessionType == null) Object.assign(current, { sessionType: session.sessionType, trackId: session.trackId, totalLaps: session.totalLaps });
    if (session && session.trackLength) current.trackLength = session.trackLength;
    for (const trace of fieldModel.takePlayerLapTraces()) current.traces.set(trace.lapNum, trace);
    // Each rival's best clean lap from the line - one per car keeps a saved session small.
    for (const t of fieldModel.takeRivalLapTraces()) {
      const car = fieldModel.getCar(t.carIndex);
      const rec = car.lapHistory.find((l) => l.lapNum === t.lapNum);
      if (!t.startedAtLine || t.invalid || !(t.lapMs > 0) || !rec || rec.pit || rec.neutralised || t.lapNum < 2) continue;
      // Online, other cars' telemetry may be withheld (sent as zeros).
      if (!t.points.some((p) => p[2] > 0)) continue;
      const had = current.rivalBest.get(t.carIndex);
      if (!had || t.lapMs < had.lapMs) current.rivalBest.set(t.carIndex, { name: (car.participant && car.participant.name) || `Car ${t.carIndex}`, ...t });
    }
    // A flashback: a best lap the rival hasn't driven yet never happened.
    for (const [idx, t] of current.rivalBest) {
      const ld = fieldModel.getCar(idx).lapData;
      if (ld && ld.currentLapNum <= t.lapNum) current.rivalBest.delete(idx);
    }

    const pi = fieldModel.playerIndex();
    const player = pi == null ? null : fieldModel.getCar(pi);
    if (pi != null) current.playerIdx = pi;
    const fc = fieldModel.getClassification();
    if (fc) current.classification = fc;
    const lp = fieldModel.getLapPositions();
    if (lp) current.lapPositions = lp;
    const ld = player && player.lapData;
    if (ld) {
      if (current.gridPosition == null && ld.gridPosition > 0) current.gridPosition = ld.gridPosition;
      // A flashback back across the line: laps from here on never happened.
      if (current.lastLapSeen != null && ld.currentLapNum < current.lastLapSeen) {
        current.laps = current.laps.filter((l) => l.lap < ld.currentLapNum);
        for (const n of [...current.traces.keys()]) if (n >= ld.currentLapNum) current.traces.delete(n);
        current.pendingFor = null;
      }
      current.lastLapSeen = ld.currentLapNum;
      // Sector times are only reported for the lap in progress, so they're
      // remembered until the lap completes.
      if (!current.pending || current.pending.lapNum !== ld.currentLapNum) {
        current.pending = { lapNum: ld.currentLapNum, s1: null, s2: null, invalid: false };
      }
      const p = current.pending;
      if (ld.sector1TimeInMS > 0) p.s1 = ld.sector1TimeInMS;
      if (ld.sector2TimeInMS > 0) p.s2 = ld.sector2TimeInMS;
      if (ld.currentLapInvalid) p.invalid = true;

      const done = player.lapHistory[player.lapHistory.length - 1];
      const recorded = current.laps[current.laps.length - 1];
      if (done && (!recorded || done.lapNum > recorded.lap)) {
        const sectors = current.pendingFor && current.pendingFor.lapNum === done.lapNum ? current.pendingFor : null;
        const s3 = sectors && sectors.s1 && sectors.s2 ? done.lapMs - sectors.s1 - sectors.s2 : null;
        const st = player.status;
        current.laps.push({
          lap: done.lapNum,
          timeMs: done.lapMs,
          s1: sectors ? sectors.s1 : null,
          s2: sectors ? sectors.s2 : null,
          s3: s3 > 0 ? s3 : null,
          invalid: sectors ? sectors.invalid : false,
          pit: done.pit,
          neutralised: done.neutralised,
          position: ld.carPosition,
          compound: st ? st.visualTyreCompound : null,
          tyreAge: st ? st.tyresAgeLaps : null,
          wearAvg: player.damage ? +(avg(player.damage.tyresWear)).toFixed(1) : null,
          fuelKg: st ? +st.fuelInTank.toFixed(2) : null,
          batteryPct: st && Number.isFinite(st.ersStoreEnergy) ? Math.round((st.ersStoreEnergy / 4e6) * 100) : null,
        });
      }
      // By the time a lap shows up in lapHistory, LapData has already moved
      // on to the next lap - so the sectors are read from the copy taken on
      // the previous tick.
      current.pendingFor = { ...p };
    }

    // The field: best laps, positions, stops, tyre sequence.
    for (const car of fieldModel.orderedByPosition()) {
      const rec = current.field.get(car.carIndex) || { name: null, position: null, bestMs: null, stops: 0, compounds: [], status: null };
      rec.name = nameOf(car, car.carIndex);
      rec.position = car.lapData.carPosition;
      rec.stops = car.lapData.numPitStops;
      rec.status = car.lapData.resultStatus;
      rec.isPlayer = car.carIndex === pi;
      for (const l of car.lapHistory) if (!l.pit && l.lapMs > 0 && (rec.bestMs == null || l.lapMs < rec.bestMs)) rec.bestMs = l.lapMs;
      const compound = car.status ? car.status.visualTyreCompound : null;
      if (compound && rec.compounds[rec.compounds.length - 1] !== compound) rec.compounds.push(compound);
      if (car.miniSectors) rec.miniSectors = car.miniSectors.slice();
      if (car.sessionHistory) rec.bestSectors = bestSectors(car.sessionHistory);
      current.field.set(car.carIndex, rec);
    }

    for (const e of fieldModel.getRecentEvents()) {
      if (e.seq <= current.lastEventSeq) continue;
      current.lastEventSeq = e.seq;
      // Same rule as the radio: only penalty types whose F1 26 meaning is certain.
      if (e.code === 'PENA' && e.vehicleIdx === pi && [0, 1, 4, 5, 6].includes(e.penaltyType)) current.penalties.push({ what: e.name, lap: e.lapNum, timeS: e.timeS });
      if (e.code === 'SCAR' && !(e.safetyCarEventType > 0)) current.safetyCars++;
      if (e.code === 'FTLP' && e.vehicleIdx != null) {
        const car = fieldModel.getCar(e.vehicleIdx);
        current.fastestLap = { name: e.vehicleIdx === pi ? 'You' : nameOf(car, e.vehicleIdx), ms: e.lapTimeS > 0 ? Math.round(e.lapTimeS * 1000) : null, isPlayer: e.vehicleIdx === pi };
      }
    }
    // The official result means the session is over - save now rather than
    // when the next session starts (which may never come if the game closes).
    if (current.classification && current.laps.length) save(current);
  }

  function summarize(s) {
    const laps = s.laps;
    const clean = laps.filter((l) => !l.pit && !l.neutralised && !l.invalid && l.timeMs > 0);
    const best = clean.length ? clean.reduce((a, b) => (b.timeMs < a.timeMs ? b : a)) : null;
    const pick = (k) => clean.map((l) => l[k]).filter((v) => v > 0);
    const bestS = ['s1', 's2', 's3'].map((k) => (pick(k).length ? Math.min(...pick(k)) : null));
    const pace = clean.length ? Math.round(median(clean.map((l) => l.timeMs))) : null;
    const sd = clean.length >= 3 ? Math.round(Math.sqrt(avg(clean.map((l) => (l.timeMs - avg(clean.map((c) => c.timeMs))) ** 2)))) : null;
    // Stints: a new one starts when tyre age drops (a stop) or the compound changes.
    const stints = [];
    for (const l of laps) {
      const last = stints[stints.length - 1];
      if (!last || l.compound !== last.compound || (l.tyreAge != null && last.lastAge != null && l.tyreAge < last.lastAge)) {
        stints.push({ compound: l.compound, fromLap: l.lap, toLap: l.lap, laps: 1, lastAge: l.tyreAge });
      } else {
        Object.assign(last, { toLap: l.lap, laps: last.laps + 1, lastAge: l.tyreAge });
      }
    }
    const field = [...s.field.values()].filter((f) => f.position > 0).sort((a, b) => a.position - b.position);
    const fieldBest = field.reduce((m, f) => (f.bestMs && (m == null || f.bestMs < m) ? f.bestMs : m), null);
    const me = field.find((f) => f.isPlayer);
    const official = s.classification && s.playerIdx != null ? s.classification.cars[s.playerIdx] : null;
    const finish = official && official.position ? official.position : me ? me.position : laps.length ? laps[laps.length - 1].position : null;
    const grid = official && official.gridPosition ? official.gridPosition : s.gridPosition;
    // Your best sector against the fastest anyone set (Session History).
    const fieldSectors = [0, 1, 2].map((i) => field.reduce((m, f) => (f.bestSectors && f.bestSectors[i] && (!m || f.bestSectors[i] < m.ms) ? { ms: f.bestSectors[i], name: f.isPlayer ? 'You' : f.name } : m), null));
    return {
      id: s.id,
      live: s === current,
      startedAt: s.startedAt,
      sessionType: s.sessionType,
      sessionName: SESSION_TYPES[s.sessionType] || 'Session',
      isRace: RACE_SESSION_TYPES.has(s.sessionType),
      track: TRACKS[s.trackId] || (s.trackId != null ? `Track ${s.trackId}` : ''),
      totalLaps: s.totalLaps,
      grid,
      finish,
      positionsGained: grid && finish ? grid - finish : null,
      official: !!official,
      points: official ? official.points : null,
      fieldBestSectors: fieldSectors,
      positionChart: positionChart(s, field),
      bestLap: best ? { lap: best.lap, ms: best.timeMs } : null,
      theoreticalBestMs: bestS.every((v) => v) ? bestS.reduce((a, b) => a + b, 0) : null,
      bestSectors: bestS,
      medianPaceMs: pace,
      consistencyMs: sd,
      cleanLaps: clean.length,
      fieldBestMs: fieldBest,
      fastestLap: s.fastestLap,
      pitStops: me ? me.stops : null,
      penalties: s.penalties,
      safetyCars: s.safetyCars,
      stints: stints.map(({ lastAge, ...rest }) => rest),
      laps,
      comparable: comparableLaps(s).map((l) => l.lap),
      field: field.map(({ name, position, bestMs, stops, compounds, isPlayer, status }) => ({ name, position, bestMs, stops, compounds, isPlayer: !!isPlayer, status })),
    };
  }

  // Positions lap by lap for every car: [{ name, isPlayer, positions[] }].
  function positionChart(s, field) {
    const lp = s.lapPositions;
    if (!lp || lp.laps.length < 2) return null;
    const byIdx = new Map([...s.field.entries()]);
    const cars = [];
    for (let c = 0; c < lp.laps[0].length; c++) {
      const positions = lp.laps.map((row) => row[c] || null);
      if (!positions.some(Boolean)) continue;
      const rec = byIdx.get(c);
      cars.push({ name: rec ? rec.name : `Car ${c}`, isPlayer: c === s.playerIdx, positions });
    }
    return { lapStart: lp.lapStart, cars, maxPos: field.length || cars.length };
  }

  // The current session (if it has laps) followed by finished ones.
  function view() {
    const sessions = [];
    if (current && current.laps.length) sessions.push(summarize(current));
    for (const s of history) sessions.push(summarize(s));
    return { sessions };
  }

  const find = (id) => (current && current.id === id ? current : history.find((s) => s.id === id)) || null;

  // A lap is comparable if it was recorded from the line, wasn't a pit or
  // invalid lap, and its trace exists.
  function comparableLaps(s) {
    return s.laps
      .filter((l) => s.traces.has(l.lap) && s.traces.get(l.lap).startedAtLine && !l.pit && !l.invalid)
      .map((l) => ({ lap: l.lap, timeMs: l.timeMs, neutralised: l.neutralised }));
  }

  // The fastest rivals' best laps, for "vs" in lap compare: ids are 'r<carIndex>'.
  const rivalChoices = (s) => [...(s.rivalBest || new Map())]
    .sort((x, y) => x[1].lapMs - y[1].lapMs)
    .slice(0, RIVAL_CHOICES)
    .map(([idx, t]) => ({ id: `r${idx}`, name: t.name, lapNum: t.lapNum, timeMs: t.lapMs }));

  // Lap B against lap A (default: the best comparable lap vs the latest).
  // b may be a rival's best lap ('r<carIndex>'): then their lap is the
  // reference and yours (a, or your best) is measured against it - where
  // you lose time to them, brake point by brake point.
  function compare(id, a, b) {
    const s = find(id);
    if (!s) return { error: 'No such session' };
    const laps = comparableLaps(s).filter((l) => !l.neutralised);
    const rivals = rivalChoices(s);
    const rivalB = typeof b === 'string' && RIVAL_ID.test(b) && s.rivalBest ? s.rivalBest.get(Number(b.slice(1))) : null;
    if (laps.length < (rivalB ? 1 : 2)) return { error: 'Needs two complete, clean laps with telemetry' };
    const best = laps.reduce((x, y) => (y.timeMs < x.timeMs ? y : x));
    const lapA = s.traces.get(a != null ? a : best.lap);
    const lapB = rivalB || s.traces.get(b != null ? Number(b) : laps.filter((l) => l.lap !== best.lap).pop().lap);
    if (!lapA || !lapB) return { error: 'No telemetry for that lap' };
    const recA = s.laps.find((l) => l.lap === lapA.lapNum);
    const recB = rivalB ? null : s.laps.find((l) => l.lap === lapB.lapNum);
    const mine = { ...lapA, lapMs: recA ? recA.timeMs : lapA.lapMs };
    const out = rivalB ? compareLaps(rivalB, mine) : compareLaps(mine, { ...lapB, lapMs: recB ? recB.timeMs : lapB.lapMs });
    if (rivalB) out.lapA = { ...out.lapA, rival: rivalB.name, id: b };
    return {
      laps,
      rivals,
      ...out,
      consistency: consistency(laps.map((l) => s.traces.get(l.lap))),
    };
  }

  function rivals(id) {
    const s = find(id);
    if (!s) return { error: 'No such session' };
    const r = rivalAnalysis([...s.field.values()], s.trackLength);
    return r || { error: 'No mini-sector times yet - they fill in from the first full lap' };
  }

  // On shutdown: keep the session in progress too.
  const flush = () => { if (current && current.laps.length) save(current); };

  return { tick, view, compare, rivals, flush };
}

module.exports = { RIVAL_ID, createDebrief };
