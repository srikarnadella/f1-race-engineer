const { parsePacket } = require('./udp/parsePacket');
const { createFieldModel } = require('./state/fieldModel');
const { createInsightEngine } = require('./engine/insightEngine');
const { createRaceAnalysis } = require('./engine/raceAnalysis');
const { createTrackMemory } = require('./state/trackMemory');
const { createDebrief } = require('./engine/debrief');
const { createFocus } = require('./engine/focus');
const { createSpotter } = require('./analysis/spotter');
const { setupView } = require('./analysis/setupView');
const { bestSetup } = require('./analysis/setupHistory');
const { createOutlines } = require('./state/trackOutline');
const { briefing } = require('./analysis/briefing');
const { TRACKS } = require('./udp/gameIds');
const { buildSnapshot } = require('./server/snapshot');
const { createSessionRecorder } = require('./data/sessionRecorder');

// The engine, wired once: packets in, the dashboard snapshot out. The live
// bridge, the capture analyzer, the demo builder and the tests all run this,
// so none of them can drift from what the driver actually sees.
// `now` is the engine's clock: the wall clock live, the recording's in a replay.
// `source` lets the dashboard label a replay - the public demo must never
// pass itself off as a live session.
// `store` (data/store.js) keeps every session in the race database; `captureName` is where it came from.
// setCapture(name | null) starts or ends a recording without a restart (the desktop app's Record button).
function createPipeline({ now = () => Date.now(), memory = createTrackMemory(), debriefDir = null, source = 'live', capturing = false, store = null, captureName = null, udpPort = null, setups: initialSetups = null, intake = null, outlines = createOutlines() } = {}) {
  // The community setup sheet, read into { game, circuits } (data/setupSheet.js); null until one is imported.
  let setups = initialSetups;
  const fieldModel = createFieldModel({ clock: now });
  const insightEngine = createInsightEngine(fieldModel);
  const raceAnalysis = createRaceAnalysis(fieldModel, { memory });
  const focus = createFocus(now);
  const debrief = createDebrief(fieldModel, { dir: debriefDir });
  const recorder = store && createSessionRecorder(fieldModel, {
    debrief,
    write: (s) => {
      try {
        store.writeSession({ ...s, capture: captureName });
        bests.clear(); // a session just joined the history
        briefings.clear();
      } catch (err) {
        console.error(`[store] couldn't save the session: ${err.message}`);
      }
    },
  });

  // Your fastest clean lap's setup at each track and kind, from the store; read once, and again after a session is saved.
  const bests = new Map();
  const bestHere = (session) => {
    if (!store || !session || session.trackId == null) return null;
    const kind = session.sessionType >= 5 && session.sessionType <= 14 ? 'q' : 'r';
    const key = `${session.trackId}:${kind}`;
    if (!bests.has(key)) {
      try {
        bests.set(key, bestSetup(store.setupSessions(session.trackId), kind));
      } catch (err) {
        console.error(`[setup] history unavailable: ${err.message}`);
        bests.set(key, null);
      }
    }
    return bests.get(key);
  };

  // Your setup names and stars, read once and again after a save (the table is small, the tick is not the place to ask).
  let notesCache = null;
  const setupNotes = () => {
    if (!store) return [];
    if (!notesCache) {
      try {
        notesCache = store.setupNotes();
      } catch (err) {
        console.error(`[setup] notes unavailable: ${err.message}`);
        notesCache = [];
      }
    }
    return notesCache;
  };
  const invalidateNotes = () => { notesCache = null; };

  // The pre-race briefing for the track, from the store and the track memory; read once, and again after a session is saved.
  const briefings = new Map();
  const briefingHere = (session) => {
    if (!store || !session || session.trackId == null) return null;
    if (!briefings.has(session.trackId)) {
      try {
        const m = (kind) => memory.get(session.trackId, kind);
        briefings.set(session.trackId, { track: TRACKS[session.trackId] || null, ...briefing({ sessions: store.trackHistory(session.trackId), memory: { pitLossMs: m('pitLossMs'), deg16: m('deg16'), deg17: m('deg17'), deg18: m('deg18') } }) });
      } catch (err) {
        console.error(`[briefing] unavailable: ${err.message}`);
        briefings.set(session.trackId, null);
      }
    }
    return briefings.get(session.trackId);
  };

  const dispatch = (packetId, header, data) => fieldModel.dispatch(packetId, header, data);

  // One raw packet; false if it was unreadable or the state rejected it.
  function feed(buf) {
    try {
      const { header, data } = parsePacket(buf);
      if (data !== null) dispatch(header.packetId, header, data);
      return true;
    } catch {
      return false;
    }
  }

  // The debrief (lap-by-lap record) is larger and changes once a lap, so it
  // rides along on every 10th tick - once a second at 10 Hz.
  let tickCount = 0;
  let debriefView = debrief.view();
  function setCapture(name) {
    capturing = !!name;
    captureName = name || null;
  }
  // "Car left / car right", from the Motion packet; remembered between ticks so a flicker is not a call.
  const spotter = createSpotter();
  const spot = () => {
    const pi = fieldModel.playerIndex();
    const me = pi == null ? null : fieldModel.getCar(pi).world;
    if (!me) return { left: false, right: false };
    const rivals = fieldModel.getWorlds().filter((c) => c.idx !== pi).map((c) => ({ idx: c.idx, x: c.world ? c.world.x : 0, z: c.world ? c.world.z : 0, inactive: !c.world, inPit: c.inPit }));
    const r = spotter.update(me, rivals, fieldModel.clock());
    return { left: r.left != null, right: r.right != null };
  };
  // The map: every car's place (Motion), and the track's outline learned from your clean laps (state/trackOutline.js).
  // The outline is 240 points, so it rides along once a second like the debrief, not on every tick.
  const mapView = (withOutline) => {
    const session = fieldModel.getSession();
    const pi = fieldModel.playerIndex();
    if (!session || pi == null) return null;
    const cars = [];
    for (const w of fieldModel.getWorlds()) {
      if (!w.world) continue;
      const c = fieldModel.getCar(w.idx);
      cars.push({ idx: w.idx, x: Math.round(w.world.x * 10) / 10, z: Math.round(w.world.z * 10) / 10, position: c.lapData ? c.lapData.carPosition : null, you: w.idx === pi, pit: w.inPit });
    }
    return { trackId: session.trackId, cars, ...(withOutline ? { outline: outlines.get(session.trackId) } : {}) };
  };
  const learnOutline = () => {
    const session = fieldModel.getSession();
    const me = playerCar();
    if (!session || !me || !me.world || !me.lapData) return;
    outlines.observe({ trackId: session.trackId, length: session.trackLength, distance: me.lapData.lapDistance, x: me.world.x, z: me.world.z, speedKmh: me.telemetry ? me.telemetry.speed : null, inPit: !!me.lapData.pitStatus });
  };

  const playerCar = () => (fieldModel.playerIndex() == null ? null : fieldModel.getCar(fieldModel.playerIndex()));
  const build = (withDebrief) => ({ source, capturing, spotter: spot(), map: mapView(withDebrief), briefing: briefingHere(fieldModel.getSession()), setup: setupView({ session: fieldModel.getSession(), car: playerCar(), setups, best: bestHere(fieldModel.getSession()), notes: setupNotes() }) || { available: false, track: null, circuit: null, kind: 'r', editable: false, inGarage: false, rows: [], off: 0, notes: null, source: null, history: null, current: null }, ...(udpPort ? { udpPort } : {}), ...(intake ? { intake: intake.view() } : {}), ...(withDebrief ? { debrief: debriefView } : {}), ...buildSnapshot(fieldModel, insightEngine, raceAnalysis, focus) });
  let latest = build(true);

  function tick() {
    debrief.tick();
    learnOutline();
    const withDebrief = ++tickCount % 10 === 0;
    if (withDebrief) debriefView = debrief.view();
    latest = build(withDebrief);
    debrief.noteCall(latest);
    if (recorder) recorder.sync(latest);
    return latest;
  }

  function flush() {
    debrief.flush();
    raceAnalysis.flush();
    if (recorder) recorder.flush();
  }

  const setSetups = (next) => { setups = next; };

  // Recordings were read into the store: what the history and the briefing found before is out of date.
  const invalidateHistory = () => { bests.clear(); briefings.clear(); };

  return { feed, dispatch, tick, snapshot: () => latest, flush, setCapture, setSetups, invalidateHistory, invalidateNotes, fieldModel, insightEngine, raceAnalysis, focus, debrief };
}

module.exports = { createPipeline };
