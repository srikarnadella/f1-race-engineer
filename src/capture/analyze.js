const fs = require('fs');
const path = require('path');
const PACKET_IDS = require('../udp/packetIds');
const { parseHeader } = require('../udp/parsers/header');
const { parsePacket, PARSED_PACKETS } = require('../udp/parsePacket');
const { createFieldModel } = require('../state/fieldModel');
const { createInsightEngine } = require('../state/insightEngine');
const { createRaceAnalysis } = require('../state/raceAnalysis');
const { buildSnapshot } = require('../server/snapshot');
const { createFocus } = require('../state/focus');
const { THRESHOLDS } = require('../state/carBalance');
const { readLog } = require('./logFile');
const { PACKET_NAMES } = require('./session');

// Validates a live capture against the assumptions this tool was built on
// (F1 25 packet layouts, field meanings), measures the numbers its
// thresholds should be tuned to, and replays the session through the real
// pipeline on a simulated clock to show every call it would make - with the
// driver's marks lined up against the data around them.

// F1 25 total packet sizes. A different size in an F1 26 capture means the
// layout changed and that parser needs a look.
const F1_25_SIZES = {
  0: 1349, 1: 753, 2: 1285, 3: 45, 4: 1284, 5: 1133, 6: 1352, 7: 1239,
  8: 1042, 9: 954, 10: 1041, 11: 1460, 12: 231, 13: 273, 14: 101, 15: 1131,
};
// Packet format 2026, from the first real capture (time trial). 8 and 9
// (final classification, lobby) weren't seen yet.
const F1_26_SIZES = {
  0: 1325, 1: 926, 2: 1399, 3: 45, 4: 1470, 5: 1233, 6: 1448, 7: 1445,
  10: 1133, 11: 1460, 12: 231, 13: 273, 14: 104, 15: 1231, 16: 269,
};
const REFERENCE_SIZES = { 2025: F1_25_SIZES, 2026: F1_26_SIZES };
const TICK_MS = 100;
const RACE_TYPES = new Set([15, 16, 17]);
const MAX_SAMPLES = 400000;
const TIMELINE_LIMIT = 400;
const MARKER_WINDOW_MS = 8000;

function resolveTarget(target) {
  const abs = path.resolve(target);
  if (fs.statSync(abs).isDirectory()) {
    const file = ['packets.f1log.gz', 'packets.f1log'].map((f) => path.join(abs, f)).find((f) => fs.existsSync(f))
      || fs.readdirSync(abs).filter((f) => /\.f1log(\.gz)?$/.test(f)).map((f) => path.join(abs, f))[0];
    if (!file) throw new Error(`no .f1log or .f1log.gz in ${abs}`);
    return { dir: abs, packetsFile: file };
  }
  return { dir: path.dirname(abs), packetsFile: abs };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function percentiles(xs, ps) {
  if (!xs.length) return null;
  const s = Float64Array.from(xs).sort();
  const out = {};
  for (const p of ps) out[`p${p}`] = +s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))].toFixed(4);
  out.n = s.length;
  return out;
}
const share = (xs, pred) => (xs.length ? +(xs.filter(pred).length / xs.length).toFixed(4) : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const push = (arr, v) => {
  if (Number.isFinite(v) && arr.length < MAX_SAMPLES) arr.push(v);
};

async function analyzeCapture(target) {
  const { dir, packetsFile } = resolveTarget(target);
  const markers = Object.values(readJsonl(path.join(dir, 'markers.jsonl')).reduce((byId, m) => {
    // The tap and a tag chosen afterwards share an id: keep the first time, the last tag.
    byId[m.id] = byId[m.id] ? { ...byId[m.id], tag: m.tag, note: m.note || byId[m.id].note } : m;
    return byId;
  }, {})).sort((a, b) => a.tMs - b.tMs);
  const liveOutputs = readJsonl(path.join(dir, 'outputs.jsonl'));
  const meta = fs.existsSync(path.join(dir, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) : null;

  // Parser warnings are part of the findings, not console noise.
  const warnings = new Map();
  const realWarn = console.warn;
  console.warn = (...args) => {
    const key = args.map(String).join(' ');
    warnings.set(key, (warnings.get(key) || 0) + 1);
  };
  // The pipeline timestamps everything with Date.now(); drive it from the
  // capture's own clock so expiries and windows behave as they did live.
  const realNow = Date.now;
  const EPOCH = 1_700_000_000_000;
  let clock = EPOCH;
  Date.now = () => clock;

  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  const ra = createRaceAnalysis(fm);
  let clockMs = 0; // capture time, so auto-switch holds play out as they did live
  const focus = createFocus(() => clockMs);
  let lastFocus = 'drive';

  const packets = new Map(); // id -> { count, sizes: Map, firstT, lastT, parseErrors: Map }
  const formats = new Map();
  const formatNumbers = new Map(); // packetFormat -> count
  const sessions = new Map(); // uid -> summary
  const eventCodes = new Map();
  const names = new Map(); // carIndex -> name (latest)
  const compounds = { actual: new Set(), visual: new Set() };
  const ersModes = new Set();
  let ersMaxJ = 0;
  const biasChanges = [];
  const diffChanges = [];
  const forecast = { offsets: new Set(), checks: 0, matchNow: 0, matchSessionStart: 0, accuracy: new Set(), samplesPerPacket: new Set() };
  const cal = { brakeFront: [], brakeRear: [], exitRear: [], exitAngleGap: [], exitFrontAngle: [] };
  const fuelAtLine = [];
  const laps = [];
  const timeline = [];
  let timelineTruncated = 0;
  const markerContext = [];
  const stats = { badLines: 0, truncated: false };
  let lastTick = -Infinity;
  let lastForecastCheck = -Infinity;
  let firstT = null;
  let lastT = 0;
  let prev = { insights: new Map(), call: '', adjust: '', weather: '', lap: null, player: null };
  let markerIdx = 0;
  let lastSnap = null; // { pl, call, snap } from the latest engine tick
  const fcRecs = [];
  let fcLastT = null;
  let fcState = null; // the defend forecast in force: { attacker, atM }
  const nearCorner = (d, c, L) => {
    let diff = d - c;
    if (diff < -L / 2) diff += L;
    if (diff > L / 2) diff -= L;
    return diff >= -150 && diff <= 450;
  };
  function scorePass(header, data) {
    const s = fm.getSession();
    if (!s || !RACE_TYPES.has(s.sessionType) || data.overtakenIdx !== header.playerCarIndex) return;
    const att = fm.getCar(data.overtakerIdx).lapData;
    const me = fm.getCar(header.playerCarIndex).telemetry;
    const corners = fm.getPlayerCorners();
    if (!att || att.currentLapNum <= 1 || !me || me.speed < 80 || !corners.length) return; // lap 1 / a spun car isn't an attack
    const L = s.trackLength;
    const passes = fm.getPassLog().map((x) => x.atM);
    const counts = corners.map((c) => passes.filter((d) => nearCorner(d, c.startM, L)).length);
    const busiest = corners[counts.indexOf(Math.max(...counts))];
    fcRecs.push({
      t: header.sessionTime,
      hit: !!(fcState && fcState.attacker === data.overtakerIdx && nearCorner(att.lapDistance, fcState.atM, L)),
      forecast: !!(fcState && fcState.attacker === data.overtakerIdx),
      busiestHit: !!(busiest && nearCorner(att.lapDistance, busiest.startM, L)),
      randomHit: corners.filter((c) => nearCorner(att.lapDistance, c.startM, L)).length / corners.length,
    });
  }
  const recentPlayer = []; // rolling raw samples for marker context

  const note = (tMs, kind, text) => {
    if (timeline.length < TIMELINE_LIMIT) timeline.push({ tMs, kind, text });
    else timelineTruncated++;
  };

  try {
    for await (const { tMs, buf } of readLog(packetsFile, stats)) {
      if (firstT === null) firstT = tMs;
      lastT = tMs;
      clock = EPOCH + tMs;

      let header;
      try {
        header = parseHeader(buf);
      } catch {
        continue;
      }
      const id = header.packetId;
      const p = packets.get(id) || { count: 0, sizes: new Map(), firstT: tMs, lastT: tMs, parseErrors: new Map() };
      p.count++;
      p.sizes.set(buf.length, (p.sizes.get(buf.length) || 0) + 1);
      p.lastT = tMs;
      packets.set(id, p);
      const fmt = `${header.packetFormat} · game ${header.gameYear} v${header.gameMajorVersion}.${String(header.gameMinorVersion).padStart(2, '0')} · packet v${header.packetVersion}`;
      formats.set(fmt, (formats.get(fmt) || 0) + 1);
      formatNumbers.set(header.packetFormat, (formatNumbers.get(header.packetFormat) || 0) + 1);

      let parsed;
      try {
        parsed = parsePacket(buf);
      } catch (err) {
        p.parseErrors.set(err.message, (p.parseErrors.get(err.message) || 0) + 1);
        continue;
      }
      const data = parsed.data;
      // Attack-forecast scorecard: each real pass on the player, scored
      // against the forecast in force just before it (before this packet
      // updates the model). Flashback-undone passes are dropped.
      if (fcLastT != null && header.sessionTime < fcLastT - 0.5) {
        for (let i = fcRecs.length - 1; i >= 0; i--) if (fcRecs[i].t > header.sessionTime) fcRecs.splice(i, 1);
      }
      fcLastT = header.sessionTime;
      if (data && id === PACKET_IDS.EVENT && data.code === 'OVTK') scorePass(header, data);
      if (data) {
        try {
          fm.dispatch(id, header, data);
        } catch (err) {
          p.parseErrors.set(`dispatch: ${err.message}`, (p.parseErrors.get(`dispatch: ${err.message}`) || 0) + 1);
        }
      }
      // Marks are placed before this packet is applied - so a mark made
      // during a pause sees the state from just before the pause.
      while (markerIdx < markers.length && markers[markerIdx].tMs <= tMs) addMarkerContext(markers[markerIdx++]);
      const pi = header.playerCarIndex;
      const player = fm.getCar(pi);

      // --- Per-packet validation collectors ---
      if (id === PACKET_IDS.SESSION && data) {
        const key = String(header.sessionUID);
        const s = sessions.get(key) || { sessionUID: key, sessionType: data.sessionType, trackId: data.trackId, totalLaps: data.totalLaps, trackLength: data.trackLength, firstT: tMs, lastT: tMs, weather: new Set(), safetyCar: new Set(), playerCarIndex: pi };
        s.lastT = tMs;
        s.weather.add(data.weather);
        s.safetyCar.add(data.safetyCarStatus);
        sessions.set(key, s);
        forecast.samplesPerPacket.add(data.forecast.length);
        if (data.forecastAccuracy != null) forecast.accuracy.add(data.forecastAccuracy);
        const mine = data.forecast.filter((f) => f.sessionType === data.sessionType);
        for (const f of mine) forecast.offsets.add(f.timeOffsetMin);
        // Is "timeOffset" minutes from now, or from the session start? Check
        // which reading agrees with the weather the game says it is now.
        if (mine.length && tMs - lastForecastCheck >= 10000) {
          lastForecastCheck = tMs;
          forecast.checks++;
          const zero = mine.find((f) => f.timeOffsetMin === 0);
          if (zero && zero.weather === data.weather) forecast.matchNow++;
          const elapsedMin = header.sessionTime / 60;
          const nearest = mine.reduce((a, b) => (Math.abs(b.timeOffsetMin - elapsedMin) < Math.abs(a.timeOffsetMin - elapsedMin) ? b : a));
          if (nearest.weather === data.weather) forecast.matchSessionStart++;
        }
      } else if (id === PACKET_IDS.PARTICIPANTS && data) {
        data.participants.forEach((q, i) => names.set(i, q.name));
      } else if (id === PACKET_IDS.EVENT && data) {
        eventCodes.set(data.code, (eventCodes.get(data.code) || 0) + 1);
      } else if (id === PACKET_IDS.CAR_STATUS && data) {
        for (const c of data.cars) {
          if (c.ersStoreEnergy > ersMaxJ && c.ersStoreEnergy < 1e8) ersMaxJ = c.ersStoreEnergy;
          if (c.actualTyreCompound) compounds.actual.add(c.actualTyreCompound);
          if (c.visualTyreCompound) compounds.visual.add(c.visualTyreCompound);
        }
        const me = data.cars[pi];
        if (me) {
          ersModes.add(me.ersDeployMode);
          if (!biasChanges.length || biasChanges[biasChanges.length - 1].value !== me.frontBrakeBias) biasChanges.push({ tMs, value: me.frontBrakeBias });
        }
      } else if (id === PACKET_IDS.CAR_SETUPS && data && data.cars[pi]) {
        const v = data.cars[pi].onThrottle;
        if (!diffChanges.length || diffChanges[diffChanges.length - 1].value !== v) diffChanges.push({ tMs, value: v, setupBias: data.cars[pi].brakeBias });
      } else if (id === PACKET_IDS.MOTION_EX && data) {
        const tel = player.telemetry;
        const lap = player.lapData;
        if (tel && lap && lap.pitStatus === 0) {
          const s = data.wheelSlipRatio;
          const a = data.wheelSlipAngle;
          if (tel.brake >= THRESHOLDS.BRAKE_ON && tel.speed >= THRESHOLDS.MIN_LOCK_SPEED_KMH) {
            push(cal.brakeFront, Math.min(s[2], s[3]));
            push(cal.brakeRear, Math.min(s[0], s[1]));
          } else if (tel.brake < 0.05 && tel.throttle >= THRESHOLDS.EXIT_MIN_THROTTLE && tel.speed <= THRESHOLDS.EXIT_MAX_SPEED_KMH) {
            push(cal.exitRear, Math.max(s[0], s[1]));
            if (Math.abs(tel.steer) >= THRESHOLDS.UNDERSTEER_STEER) {
              const front = (Math.abs(a[2]) + Math.abs(a[3])) / 2;
              const rear = (Math.abs(a[0]) + Math.abs(a[1])) / 2;
              push(cal.exitFrontAngle, front);
              push(cal.exitAngleGap, front - rear);
            }
          }
          recentPlayer.push({ tMs, lap: lap.currentLapNum, distM: Math.round(lap.lapDistance), speed: tel.speed, gear: tel.gear, throttle: +tel.throttle.toFixed(2), brake: +tel.brake.toFixed(2), steer: +tel.steer.toFixed(2), slip: s.map((v) => +v.toFixed(3)) });
          while (recentPlayer.length && recentPlayer[0].tMs < tMs - MARKER_WINDOW_MS) recentPlayer.shift();
        }
      }

      // --- 10Hz engine tick, as the live bridge runs it ---
      if (tMs - lastTick < TICK_MS) continue;
      lastTick = tMs;
      let snap;
      try {
        clockMs = tMs;
        snap = buildSnapshot(fm, ie, ra, focus);
      } catch (err) {
        const key = `snapshot: ${err.message}`;
        warnings.set(key, (warnings.get(key) || 0) + 1);
        continue;
      }
      if (!snap.player) continue;
      const pl = snap.player;

      const nowInsights = new Map(snap.insights.map((i) => [i.id, `${i.severity}|${i.message}`]));
      for (const [iid, sig] of nowInsights) if (prev.insights.get(iid) !== sig) note(tMs, `insight.${sig.split('|')[0]}`, sig.slice(sig.indexOf('|') + 1));
      prev.insights = nowInsights;
      const call = snap.strategy ? `${snap.strategy.call.action} - ${snap.strategy.call.reason}` : '';
      // A new call, not its live numbers ("On for P13 - 0.4 up" ticking along a
      // qualifying lap). Race calls keep theirs: "rejoin P5" -> "P9" is a change.
      const callGist = snap.analysis && snap.analysis.quali ? call.replace(/[0-9]+([.:][0-9]+)?/g, '#') : call;
      if (callGist !== prev.call) {
        prev.call = callGist;
        if (call) note(tMs, 'call', call);
      }
      const adj = snap.adjust ? snap.adjust.suggestions.map((x) => `${x.action} @ ${x.where} (${x.why})`).join(' ; ') : '';
      if (adj !== prev.adjust) {
        prev.adjust = adj;
        note(tMs, 'adjust', adj || '(none)');
      }
      const wx = snap.analysis && snap.analysis.weather;
      const wxSig = wx ? `${wx.trackState}${wx.nextChange ? ` - ${wx.nextChange.to} in ~${Math.round(wx.nextChange.inLaps)} laps${wx.nextChange.afterFlag ? ' (after the flag)' : ''}` : ''}` : '';
      if (wxSig !== prev.weather) {
        prev.weather = wxSig;
        if (wxSig) note(tMs, 'weather', wxSig);
      }
      if (snap.focus && snap.focus.screen !== lastFocus) {
        lastFocus = snap.focus.screen;
        note(tMs, 'auto-switch', `${snap.focus.screen}${snap.focus.reason ? ` (${snap.focus.reason})` : ''}`);
      }

      // Per-lap summary for the player.
      // A flashback back across the line undoes laps; only forward lap changes record one.
      if (prev.lap !== null && pl.currentLapNum < prev.lap) {
        for (let i = laps.length - 1; i >= 0; i--) if (laps[i].lap >= pl.currentLapNum) laps.splice(i, 1);
        for (let i = fuelAtLine.length - 1; i >= 0; i--) if (fuelAtLine[i].lap > pl.currentLapNum) fuelAtLine.splice(i, 1);
      }
      if (prev.lap !== null && pl.currentLapNum > prev.lap && prev.player) {
        const session = fm.getSession();
        const wear = pl.tyresWear ? +(pl.tyresWear.reduce((a, b) => a + b, 0) / 4).toFixed(1) : null;
        laps.push({
          lap: prev.lap, lapTimeMs: pl.lastLapTimeInMS, position: pl.position, pitStops: pl.numPitStops,
          compound: pl.tyreCompound, tyreAge: pl.tyresAgeLaps, wearAvg: wear,
          fuelKg: pl.fuelInTank != null ? +pl.fuelInTank.toFixed(2) : null,
          fuelRemainingLaps: pl.fuelRemainingLaps != null ? +pl.fuelRemainingLaps.toFixed(2) : null,
          batteryPct: snap.adjust && snap.adjust.current.batteryPct != null ? Math.round(snap.adjust.current.batteryPct) : null,
          brakeBias: snap.adjust ? snap.adjust.current.brakeBias : null,
          diff: snap.adjust ? snap.adjust.current.diff : null,
          safetyCar: session ? session.safetyCarStatus : null,
          balanceIssues: fm.getPlayerBalanceIssues().map((i) => `${i.type}@C${i.corner}x${i.laps}`).join(' ') || '',
        });
        if (session && RACE_TYPES.has(session.sessionType) && pl.fuelInTank != null) {
          fuelAtLine.push({ lap: pl.currentLapNum, fuelKg: pl.fuelInTank, frl: pl.fuelRemainingLaps, lapsLeft: session.totalLaps - pl.currentLapNum + 1, pit: !!pl.pitStatus });
        }
      }
      prev.lap = pl.currentLapNum;
      prev.player = pl;

      lastSnap = { pl, call, snap };
      const fc = snap.analysis && snap.analysis.battle && snap.analysis.battle.defendForecast;
      const behindRow = snap.nearby.filter((n) => n.gapToPlayerMs > 0).sort((x, y) => x.gapToPlayerMs - y.gapToPlayerMs)[0];
      if (fc && fc.where && behindRow) fcState = { attacker: behindRow.carIndex, atM: fc.where.atM };
    }
  } finally {
    console.warn = realWarn;
    Date.now = realNow;
  }
  // Any marks after the last packet (tapped after the session ended).
  while (markerIdx < markers.length) addMarkerContext(markers[markerIdx++]);
  return finish();

  // A driver's mark, with what the dashboard showed and the car was doing.
  // Uses the last state *before* the mark: the game sends nothing while
  // paused, so a mark tapped in the pause menu sits after a gap - in a real
  // race the inputs window came up empty because of exactly that.
  function addMarkerContext(m) {
    const before = recentPlayer.filter((r) => r.tMs <= m.tMs);
    const lastSample = before[before.length - 1];
    const windowEnd = lastSample ? lastSample.tMs : m.tMs;
    const s = lastSnap;
    markerContext.push({
      ...m,
      dataGapS: lastSample && m.tMs - lastSample.tMs > 1000 ? +((m.tMs - lastSample.tMs) / 1000).toFixed(1) : 0,
      replay: s ? {
        lap: s.pl.currentLapNum, distM: Math.round(s.pl.lapDistance), position: s.pl.position, speed: s.pl.speed,
        call: s.call, insights: s.snap.insights.map((i) => `[${i.severity}] ${i.message}`),
        adjust: s.snap.adjust ? s.snap.adjust.suggestions.map((x) => `${x.action} @ ${x.where}`) : [],
      } : { lap: null, distM: null, position: null, speed: null, call: '', insights: [], adjust: [] },
      // The last few seconds of inputs and wheel slip before the tap (or before the pause).
      inputs: before.filter((r) => r.tMs >= windowEnd - 3000).filter((_, k, all) => k % Math.max(1, Math.floor(all.length / 15)) === 0),
    });
  }

  function finish() {
  // --- Verdicts on the open assumptions ---
  const checks = [];
  const check = (name, status, detail) => checks.push({ name, status, detail });

  const fmtList = [...formats.entries()].sort((a, b) => b[1] - a[1]);
  const mainFormat = fmtList[0] ? fmtList[0][0] : null;
  check('Packet format', !mainFormat ? 'FAIL' : /^202[56]/.test(mainFormat) ? 'OK' : 'WARN', mainFormat ? `${mainFormat}${fmtList.length > 1 ? ` (+${fmtList.length - 1} other)` : ''}` : 'no packets');

  // Sizes are checked against the layout for the format the game sent;
  // an unknown future format is compared with the newest one known.
  const mainFormatNum = [...formatNumbers.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f)[0];
  const refFormat = REFERENCE_SIZES[mainFormatNum] ? mainFormatNum : Math.max(...Object.keys(REFERENCE_SIZES).map(Number));
  const reference = REFERENCE_SIZES[refFormat];
  for (const [pid, p] of [...packets.entries()].sort((a, b) => a[0] - b[0])) {
    const sizes = [...p.sizes.keys()];
    const expected = reference[pid];
    const used = PARSED_PACKETS.has(pid);
    const sizeOk = expected == null || (pid === 3 ? sizes.every((s) => s <= 64) : sizes.length === 1 && sizes[0] === expected);
    const errors = [...p.parseErrors.entries()].map(([e, n]) => `${n}× ${e}`).join('; ');
    check(`${PACKET_NAMES[pid] || `#${pid}`} packet${used ? '' : ' (not used)'}`,
      errors ? 'FAIL' : sizeOk ? 'OK' : used ? 'WARN' : 'INFO',
      `${sizes.join('/')} bytes${expected ? ` (${refFormat} layout: ${expected})` : ''} · ${p.count} packets · ${(p.count / Math.max(1, (p.lastT - p.firstT) / 1000)).toFixed(1)}/s${errors ? ` · errors: ${errors}` : ''}`);
  }
  for (const want of [PACKET_IDS.MOTION_EX, PACKET_IDS.CAR_SETUPS, PACKET_IDS.SESSION, PACKET_IDS.LAP_DATA]) {
    if (!packets.has(want)) check(`${PACKET_NAMES[want]} packet`, 'WARN', 'never received - is the UDP send rate / packet set complete?');
  }

  const sampleNames = [...names.values()].filter(Boolean);
  const readable = sampleNames.filter((n) => /^[\x20-\x7EÀ-ɏ]+$/.test(n));
  check('Participant names', sampleNames.length && readable.length === sampleNames.length ? 'OK' : 'WARN',
    sampleNames.length ? `${readable.length}/${sampleNames.length} readable · e.g. ${sampleNames.slice(0, 6).join(', ')}` : 'no Participants packets');

  // fuelRemainingLaps: laps of fuel in the tank, or the MFD's surplus over the race?
  const clean = fuelAtLine.filter((f) => !f.pit);
  const burns = [];
  for (let k = 1; k < clean.length; k++) if (clean[k].lap === clean[k - 1].lap + 1) burns.push(clean[k - 1].fuelKg - clean[k].fuelKg);
  const burn = median(burns.filter((b) => b > 0));
  let fuelVerdict = null;
  if (burn && clean.length >= 3) {
    const errLaps = median(clean.map((f) => Math.abs(f.frl - f.fuelKg / burn)));
    const errSurplus = median(clean.map((f) => Math.abs(f.frl - (f.fuelKg / burn - f.lapsLeft))));
    fuelVerdict = errSurplus < errLaps ? 'surplus' : 'laps-of-fuel';
    check('fuelRemainingLaps meaning', fuelVerdict === 'surplus' ? 'OK' : 'WARN',
      `burn ${burn.toFixed(2)} kg/lap · reads as ${fuelVerdict === 'surplus' ? 'the MFD surplus over the race (what the code assumes)' : 'total laps of fuel - the fuel rule must subtract laps left'} (median error: surplus ${errSurplus.toFixed(2)} vs laps-of-fuel ${errLaps.toFixed(2)})`);
  } else {
    check('fuelRemainingLaps meaning', 'INFO', 'needs 3+ green race laps to decide');
  }

  if (forecast.checks) {
    const now = forecast.matchNow / forecast.checks;
    const start = forecast.matchSessionStart / forecast.checks;
    check('Forecast timeOffset meaning', now >= start ? 'OK' : 'WARN',
      `"minutes from now" matches current weather ${(now * 100).toFixed(0)}% vs "from session start" ${(start * 100).toFixed(0)}% (${forecast.checks} checks) · offsets seen: ${[...forecast.offsets].sort((a, b) => a - b).join(', ')}`);
  } else {
    check('Forecast timeOffset meaning', 'INFO', 'no forecast samples for the current session');
  }

  check('ERS store maximum', ersMaxJ ? (Math.abs(ersMaxJ - 4e6) < 0.3e6 || ersMaxJ < 4e6 ? 'OK' : 'WARN') : 'INFO',
    ersMaxJ ? `${(ersMaxJ / 1e6).toFixed(2)} MJ seen (code assumes 4.00 MJ) · player ERS modes seen: ${[...ersModes].join(', ')}` : 'no Car Status');
  check('Brake bias changes reach the feed', biasChanges.length > 1 ? 'OK' : 'INFO',
    biasChanges.length > 1 ? `${biasChanges.length - 1} change(s): ${biasChanges.map((b) => b.value).join(' → ')}` : `stayed at ${biasChanges[0] ? biasChanges[0].value : '?'} - change it on the MFD during a capture to verify`);
  check('Diff changes reach the setups packet', diffChanges.length > 1 ? 'OK' : 'INFO',
    diffChanges.length > 1 ? `${diffChanges.length - 1} change(s): ${diffChanges.map((d) => d.value).join(' → ')}` : `stayed at ${diffChanges[0] ? diffChanges[0].value : '?'} - change the diff on the MFD during a capture to verify`);
  const attackForecast = {
    passes: fcRecs.length,
    hits: fcRecs.filter((r) => r.hit).length,
    withForecast: fcRecs.filter((r) => r.forecast).length,
    busiestCornerHits: fcRecs.filter((r) => r.busiestHit).length,
    randomHits: +fcRecs.reduce((a, r) => a + r.randomHit, 0).toFixed(1),
  };
  check('Attack forecast (experimental)', 'INFO', fcRecs.length
    ? `${attackForecast.hits}/${fcRecs.length} real passes on you came at the forecast corner · field's busiest corner ${attackForecast.busiestCornerHits}/${fcRecs.length} · random corner ${attackForecast.randomHits}/${fcRecs.length}`
    : 'no passes on you after lap 1 to score it on');
  check('Tyre compounds', 'INFO', `actual ${[...compounds.actual].sort().join(', ')} · visual ${[...compounds.visual].sort().join(', ')}`);
  const warnList = [...warnings.entries()].sort((a, b) => b[1] - a[1]);
  check('Parser / engine warnings', warnList.length ? 'WARN' : 'OK', warnList.length ? warnList.slice(0, 5).map(([w, n]) => `${n}× ${w}`).join(' | ') : 'none');
  if (stats.badLines || stats.truncated) check('Capture file', 'WARN', `${stats.badLines} unreadable line(s)${stats.truncated ? ', file ends mid-block (capture interrupted)' : ''}`);

  // --- Threshold calibration: where real data sits against the rules ---
  const calibration = {
    thresholds: THRESHOLDS,
    brakingFrontSlip: { ...percentiles(cal.brakeFront, [0.5, 1, 5, 50]), shareBeyondLock: share(cal.brakeFront, (v) => v <= THRESHOLDS.LOCK_SLIP) },
    brakingRearSlip: { ...percentiles(cal.brakeRear, [0.5, 1, 5, 50]), shareBeyondLock: share(cal.brakeRear, (v) => v <= THRESHOLDS.LOCK_SLIP) },
    exitRearSlip: { ...percentiles(cal.exitRear, [50, 95, 99, 99.5]), shareBeyondSpin: share(cal.exitRear, (v) => v >= THRESHOLDS.SPIN_SLIP) },
    exitFrontSlipAngle: percentiles(cal.exitFrontAngle, [50, 95, 99]),
    exitFrontMinusRearAngle: { ...percentiles(cal.exitAngleGap, [50, 95, 99]), shareBeyondUndersteer: share(cal.exitAngleGap, (v) => v >= THRESHOLDS.UNDERSTEER_MARGIN) },
  };

  const durationS = firstT === null ? 0 : (lastT - firstT) / 1000;
  return {
    capture: { dir, packetsFile, meta, durationS: Math.round(durationS), packets: [...packets.values()].reduce((a, p) => a + p.count, 0), markers: markers.length },
    checks,
    sessions: [...sessions.values()].map((s) => ({ ...s, weather: [...s.weather], safetyCar: [...s.safetyCar], durationS: Math.round((s.lastT - s.firstT) / 1000) })),
    events: Object.fromEntries(eventCodes),
    attackForecast,
    calibration,
    brakeBias: biasChanges,
    diff: diffChanges,
    laps,
    markers: markerContext,
    timeline,
    timelineTruncated,
    liveOutputs: { count: liveOutputs.length, byKind: liveOutputs.reduce((m, o) => ({ ...m, [o.kind]: (m[o.kind] || 0) + 1 }), {}) },
  };
  }
}

// ---------- Markdown ----------
const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const lapTime = (ms) => (ms > 0 ? `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}` : '–');
const cell = (v) => (v == null || v === '' ? '–' : String(v).replace(/\|/g, '\\|'));

function toMarkdown(r) {
  const L = [];
  L.push(`# Capture analysis`, '', `\`${r.capture.packetsFile}\``, '');
  L.push(`${mmss(r.capture.durationS * 1000)} of data · ${r.capture.packets} packets · ${r.sessions.length} session(s) · ${r.capture.markers} driver mark(s)`, '');

  L.push('## Checks', '', '| | Check | Detail |', '|---|---|---|');
  for (const c of r.checks) L.push(`| ${c.status} | ${cell(c.name)} | ${cell(c.detail)} |`);

  L.push('', '## Sessions', '', '| Type | Track | Laps | Length | Duration | Weather codes | Safety car codes |', '|---|---|---|---|---|---|---|');
  for (const s of r.sessions) L.push(`| ${s.sessionType} | ${s.trackId} | ${s.totalLaps} | ${s.trackLength} m | ${mmss(s.durationS * 1000)} | ${s.weather.join(', ')} | ${s.safetyCar.join(', ')} |`);
  if (Object.keys(r.events).length) L.push('', `Events: ${Object.entries(r.events).map(([k, v]) => `${k} ×${v}`).join(', ')}`);

  L.push('', '## Threshold calibration (player car)', '');
  L.push('Slip ratio: negative = locking, positive = wheelspin. Slip angle in radians. "share" = fraction of samples that would count against the current threshold.', '');
  L.push('```json', JSON.stringify(r.calibration, null, 2), '```');

  L.push('', '## Laps (player)', '', '| Lap | Time | Pos | Tyre | Age | Wear % | Fuel kg | Fuel laps | Battery % | Bias | Diff | SC | Balance issues |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const l of r.laps) L.push(`| ${l.lap} | ${lapTime(l.lapTimeMs)} | ${cell(l.position)} | ${cell(l.compound)} | ${cell(l.tyreAge)} | ${cell(l.wearAvg)} | ${cell(l.fuelKg)} | ${cell(l.fuelRemainingLaps)} | ${cell(l.batteryPct)} | ${cell(l.brakeBias)} | ${cell(l.diff)} | ${cell(l.safetyCar)} | ${cell(l.balanceIssues)} |`);

  L.push('', '## Driver marks', '');
  if (!r.markers.length) L.push('_None. Tap MARK on the dashboard (or press M) during a capture._');
  for (const m of r.markers) {
    L.push(`### ${mmss(m.tMs)} · ${m.tag}${m.note ? ` - ${m.note}` : ''}`, '');
    L.push(`Lap ${cell(m.replay.lap)}, ${cell(m.replay.distM)} m, P${cell(m.replay.position)}, ${cell(m.replay.speed)} km/h`, '');
    if (m.dataGapS) L.push(`_No data for ${m.dataGapS}s before this mark (game paused or in a menu) - context is from just before the gap._`, '');
    L.push(`- Call: ${cell(m.replay.call)}`);
    L.push(`- Radio: ${m.replay.insights.length ? m.replay.insights.map(cell).join(' · ') : '(none)'}`);
    L.push(`- Adjust: ${m.replay.adjust.length ? m.replay.adjust.map(cell).join(' · ') : '(none)'}`);
    if (m.inputs.length) {
      L.push('', '| t | Lap m | km/h | Gear | Thr | Brk | Steer | Slip RL/RR/FL/FR |', '|---|---|---|---|---|---|---|---|');
      for (const i of m.inputs) L.push(`| ${((i.tMs - m.tMs) / 1000).toFixed(1)}s | ${i.distM} | ${i.speed} | ${i.gear} | ${i.throttle} | ${i.brake} | ${i.steer} | ${i.slip.join(' / ')} |`);
    }
    L.push('');
  }

  L.push('', '## Dashboard timeline (replayed with the current code)', '');
  for (const e of r.timeline) L.push(`- \`${mmss(e.tMs)}\` **${e.kind}** ${cell(e.text)}`);
  if (r.timelineTruncated) L.push(`- … ${r.timelineTruncated} more changes (see report.json)`);
  if (r.liveOutputs.count) L.push('', `Live outputs log: ${r.liveOutputs.count} changes (${Object.entries(r.liveOutputs.byKind).map(([k, v]) => `${k} ${v}`).join(', ')}) - see outputs.jsonl for what the dashboard showed during the session.`);
  return L.join('\n') + '\n';
}

module.exports = { analyzeCapture, toMarkdown, resolveTarget, F1_25_SIZES };
