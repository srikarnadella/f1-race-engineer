// Collects one session for the race store (data/store.js) as it is driven:
// the cars, every car's laps (the lap dataset's own recorder), the game's
// events, the engineer's calls and radio cards, the weather, and the lap
// traces the debrief kept. A flashback takes back whatever it undid. The
// session is handed to `write` when the next one starts, and on flush().
const { createLapRecorder } = require('./laps');

const NO_CAR = 255;
const SKIP_EVENTS = new Set(['BUTN']); // button presses: many a second, nothing happened
const REWIND_S = 0.5;
const idx = (v) => (v == null || v === NO_CAR ? null : v);

function createSessionRecorder(fieldModel, { write, debrief = null }) {
  const clock = fieldModel.clock || (() => Date.now());
  let rec = null;

  function start() {
    return {
      generation: fieldModel.getGeneration(), uid: null, session: null, playerIdx: null, startedAt: clock(), endedAt: clock(),
      laps: createLapRecorder(fieldModel, { raceId: null }), cars: new Map(), history: new Map(), classification: null,
      events: [], lastEventSeq: 0, calls: [], radio: [], radioSeen: new Map(), weather: [], lastTime: 0, debriefRecord: null,
    };
  }

  // Everything after game time t never happened (a flashback to t).
  function rewind(t) {
    const kept = (xs) => xs.filter((x) => x.sessionTime <= t);
    rec.events = kept(rec.events);
    rec.calls = kept(rec.calls);
    rec.radio = kept(rec.radio);
    rec.weather = kept(rec.weather);
    rec.radioSeen = new Map(rec.radio.map((r) => [r.topic, `${r.severity}|${r.message}`]));
  }

  // Once per engine tick, with the snapshot it built.
  function sync(snap) {
    // A new session: the field has already moved on, so the old one goes as it was last seen.
    if (rec && rec.generation !== fieldModel.getGeneration()) {
      save();
      rec = null;
    }
    if (!rec) rec = start();
    const session = fieldModel.getSession();
    if (!session) return;
    const t = fieldModel.getSessionTime();
    if (t < rec.lastTime - REWIND_S) rewind(t);
    rec.lastTime = t;
    rec.endedAt = clock();
    rec.session = session;
    rec.uid = String(fieldModel.getSessionUID());
    rec.playerIdx = fieldModel.playerIndex();
    rec.classification = fieldModel.getClassification() || rec.classification;
    if (debrief) rec.debriefRecord = debrief.current();
    rec.laps.sync();

    for (const car of fieldModel.orderedByPosition()) {
      const p = car.participant || {};
      const ld = car.lapData;
      rec.cars.set(car.carIndex, {
        carIdx: car.carIndex, driver: p.name || `Car ${car.carIndex}`, teamId: p.teamId ?? null, raceNumber: p.raceNumber ?? null,
        isPlayer: car.carIndex === rec.playerIdx, isAi: p.aiControlled ?? null, grid: ld.gridPosition || null, finish: ld.carPosition,
        resultStatus: ld.resultStatus, numPitStops: ld.numPitStops,
      });
      if (car.sessionHistory) rec.history.set(car.carIndex, car.sessionHistory);
    }

    const player = rec.playerIdx == null ? null : fieldModel.getCar(rec.playerIdx);
    const playerLap = player && player.lapData ? player.lapData.currentLapNum : 0;
    const lapOf = (i) => {
      const c = i == null ? null : fieldModel.getCar(i);
      return c && c.lapData ? c.lapData.currentLapNum : playerLap;
    };

    for (const e of fieldModel.getRecentEvents()) {
      if (e.seq <= rec.lastEventSeq) continue;
      rec.lastEventSeq = e.seq;
      if (SKIP_EVENTS.has(e.code)) continue;
      const carIdx = idx(e.vehicleIdx ?? e.overtakerIdx);
      rec.events.push({
        sessionTime: e.sessionTime ?? t, lapNum: e.code === 'PENA' && e.lapNum > 0 ? e.lapNum : lapOf(carIdx), code: e.code, description: e.name,
        carIdx, otherCarIdx: idx(e.otherVehicleIdx ?? e.overtakenIdx), value: e.timeS ?? e.lapTimeS ?? (e.speedKmh != null ? Math.round(e.speedKmh * 10) / 10 : null),
      });
    }

    const call = snap && snap.strategy && snap.strategy.call;
    const last = rec.calls[rec.calls.length - 1];
    if (call && (!last || last.action !== call.action || last.kind !== (call.kind ?? null))) {
      rec.calls.push({ sessionTime: t, lapNum: playerLap, action: call.action, kind: call.kind ?? null, reason: call.reason ?? null });
    }
    for (const i of (snap && snap.insights) || []) {
      const sig = `${i.severity}|${i.message}`;
      if (rec.radioSeen.get(i.id) === sig) continue;
      rec.radioSeen.set(i.id, sig);
      rec.radio.push({ sessionTime: t, lapNum: playerLap, topic: String(i.id), severity: i.severity ?? null, message: i.message });
    }

    const now = (session.forecast || []).find((f) => f.timeOffsetMin === 0 && f.sessionType === session.sessionType);
    const w = { weather: session.weather, trackTemp: session.trackTemperature, airTemp: session.airTemperature, rainPct: now ? now.rainPercentage : null };
    const lw = rec.weather[rec.weather.length - 1];
    if (!lw || ['weather', 'trackTemp', 'airTemp', 'rainPct'].some((k) => lw[k] !== w[k])) rec.weather.push({ sessionTime: t, lapNum: playerLap, ...w });
  }

  // The session as the store writes it, or null if no lap was completed.
  function finished() {
    if (!rec || !rec.session) return null;
    const official = rec.classification ? rec.classification.cars : null;
    const laps = rec.laps.rows().map((l) => {
      const h = rec.history.get(l.carIndex);
      const hl = h && h.laps[l.lapNum - 1];
      return { ...l, s1: hl ? hl.s1 || null : null, s2: hl ? hl.s2 || null : null, s3: hl ? hl.s3 || null : null, valid: hl ? hl.valid : null };
    });
    if (!laps.length) return null;
    const lapsOf = new Map();
    for (const l of laps) lapsOf.set(l.carIndex, [...(lapsOf.get(l.carIndex) || []), l]);

    const cars = [...rec.cars.values()].map((c) => {
      const mine = lapsOf.get(c.carIdx) || [];
      const fc = official && official[c.carIdx];
      const best = mine.reduce((m, l) => (m == null || l.lapMs < m ? l.lapMs : m), null);
      return {
        ...c,
        grid: (fc && fc.gridPosition) || c.grid,
        finish: (fc && fc.position) || c.finish,
        resultStatus: fc ? fc.resultStatus : c.resultStatus,
        points: fc ? fc.points : null,
        lapsCompleted: fc ? fc.numLaps : mine.length,
        bestLapMs: (fc && fc.bestLapTimeInMS) || best,
        raceTimeMs: fc && fc.totalRaceTimeS > 0 ? Math.round(fc.totalRaceTimeS * 1000) : null,
        penaltiesS: fc ? fc.penaltiesTimeS : null,
        numPitStops: fc ? fc.numPitStops : c.numPitStops,
      };
    });

    // A new stint where the compound changes or the tyres get younger (a stop).
    const stints = [];
    for (const [carIdx, ls] of lapsOf) {
      let cur = null;
      for (const l of ls) {
        if (!cur || (l.compound != null && l.compound !== cur.compound) || (l.tyreAge != null && cur.lastAge != null && l.tyreAge < cur.lastAge)) {
          cur = { carIdx, stintNum: (cur ? cur.stintNum : 0) + 1, compound: l.compound, startLap: l.lapNum, endLap: l.lapNum, lastAge: l.tyreAge };
          stints.push(cur);
        } else Object.assign(cur, { endLap: l.lapNum, lastAge: l.tyreAge ?? cur.lastAge });
      }
    }

    const d = rec.debriefRecord;
    const traces = [];
    if (d) {
      // Laps traced from the line: an out-lap is only traced from the pit exit.
      for (const [lapNum, t] of d.traces) if (t.startedAtLine) traces.push({ carIdx: d.playerIdx ?? rec.playerIdx, lapNum, points: t.points });
      for (const [carIdx, t] of d.rivalBest || []) traces.push({ carIdx, lapNum: t.lapNum, points: t.points });
    }

    return {
      uid: rec.uid, session: rec.session, playerIdx: rec.playerIdx, startedAt: rec.startedAt, endedAt: rec.endedAt, official: !!official,
      cars, laps, stints, traces: traces.filter((t) => rec.cars.has(t.carIdx)),
      events: rec.events, calls: rec.calls, radio: rec.radio, weather: rec.weather,
    };
  }

  function save() {
    const s = finished();
    if (s) write(s);
  }

  // The session so far, up to the last packet (on shutdown, or the end of a replay).
  function flush() {
    if (rec && rec.session && rec.generation === fieldModel.getGeneration()) rec.laps.sync();
    save();
  }

  return { sync, flush };
}

module.exports = { createSessionRecorder };
