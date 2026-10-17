const { parsePacket } = require('./udp/parsePacket');
const { createFieldModel } = require('./state/fieldModel');
const { createInsightEngine } = require('./state/insightEngine');
const { createRaceAnalysis } = require('./state/raceAnalysis');
const { createTrackMemory } = require('./state/trackMemory');
const { createDebrief } = require('./state/debrief');
const { createFocus } = require('./state/focus');
const { buildSnapshot } = require('./server/snapshot');

// The engine, wired once: packets in, the dashboard snapshot out. The live
// bridge, the capture analyzer, the demo builder and the tests all run this,
// so none of them can drift from what the driver actually sees.
// `now` is the engine's clock: the wall clock live, the recording's in a replay.
// `source` lets the dashboard label a replay - the public demo must never
// pass itself off as a live session.
function createPipeline({ now = () => Date.now(), memory = createTrackMemory(), debriefDir = null, source = 'live', capturing = false } = {}) {
  const fieldModel = createFieldModel({ clock: now });
  const insightEngine = createInsightEngine(fieldModel);
  const raceAnalysis = createRaceAnalysis(fieldModel, { memory });
  const focus = createFocus(now);
  const debrief = createDebrief(fieldModel, { dir: debriefDir });

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
  const build = (withDebrief) => ({ source, capturing, ...(withDebrief ? { debrief: debriefView } : {}), ...buildSnapshot(fieldModel, insightEngine, raceAnalysis, focus) });
  let latest = build(true);

  function tick() {
    debrief.tick();
    const withDebrief = ++tickCount % 10 === 0;
    if (withDebrief) debriefView = debrief.view();
    latest = build(withDebrief);
    return latest;
  }

  function flush() {
    debrief.flush();
    raceAnalysis.flush();
  }

  return { feed, dispatch, tick, snapshot: () => latest, flush, fieldModel, insightEngine, raceAnalysis, focus, debrief };
}

module.exports = { createPipeline };
