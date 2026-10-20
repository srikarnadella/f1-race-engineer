const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { syntheticPackets, replay } = require('./helpers/synthetic');
const { createLapRecorder, createCallRecorder } = require('../src/data/laps');
const { auditCalls } = require('../src/analysis/callsAudit');

// The calls audit (roadmap U1): after a race, the Debrief grades each call against what then happened -
// the same grading `npm run backtest` prints from the datasets, on the same laps and calls.
test('debrief audit: every call of the race graded, as the backtest grades it from the same race', () => {
  let laps = null;
  let calls = null;
  const p = replay(syntheticPackets(), {
    onTick: ({ snap, pipeline }) => {
      // Recorded independently, as scripts/build-dataset.js does.
      laps = laps || createLapRecorder(pipeline.fieldModel, { raceId: null });
      calls = calls || createCallRecorder(pipeline.fieldModel, { raceId: null });
      laps.sync();
      calls.sync(snap);
    },
  });
  const id = p.debrief.current().id;
  const audit = p.debrief.audit(id);
  const expected = auditCalls(calls.rows(), laps.rows());
  assert.ok(expected.calls.length >= 2, 'the synthetic race makes calls');
  assert.deepStrictEqual(audit.summary, expected.summary);
  assert.deepStrictEqual(audit.calls.map(({ lapNum, action, kind, verdict, why }) => ({ lapNum, action, kind, verdict, why })),
    expected.calls.map(({ lapNum, action, kind, verdict, why }) => ({ lapNum, action, kind, verdict, why })));
  assert.deepStrictEqual(p.debrief.audit('nope'), { error: 'No such session' });
});

test('debrief audit: kept with the saved session, and only for races', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debrief-audit-'));
  try {
    const p = replay(syntheticPackets(), { pipelineOptions: { debriefDir: dir } });
    const id = p.debrief.current().id;
    const live = p.debrief.audit(id);
    p.flush(); // the session is saved
    const { createDebrief } = require('../src/engine/debrief');
    const reloaded = createDebrief(p.fieldModel, { dir });
    assert.deepStrictEqual(reloaded.audit(id), live);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Qualifying makes no race calls to grade.
  const PACKET_IDS = require('../src/udp/packetIds');
  const { createFieldModel } = require('../src/state/fieldModel');
  const { createDebrief } = require('../src/engine/debrief');
  const fm = createFieldModel({ clock: () => 1000 });
  const header = { sessionUID: 5n, sessionTime: 1, playerCarIndex: 0 };
  fm.dispatch(PACKET_IDS.SESSION, header, { sessionType: 5, trackId: 10, totalLaps: 0, trackLength: 5000, safetyCarStatus: 0, forecast: [] });
  const d = createDebrief(fm);
  d.tick();
  assert.deepStrictEqual(d.audit(d.current().id), { error: 'Calls are graded in races only' });
});
