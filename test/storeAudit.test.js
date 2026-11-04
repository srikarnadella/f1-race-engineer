const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/data/store');
const { auditFromStore, findStoreSession } = require('../src/data/storeAudit');
const { syntheticPackets, replay } = require('./helpers/synthetic');

// Race analysis, Strategy, for races saved before the calls were kept with the session: the race store
// has every car's laps and the engineer's calls, so the calls audit runs on them instead.
function setup() {
  const store = openStore(':memory:');
  const p = replay(syntheticPackets(), { pipelineOptions: { store } });
  const live = p.debrief.audit(p.debrief.current().id);
  const summary = p.debrief.view().sessions[0];
  p.flush();
  return { store, live, summary };
}

test('store audit: the calls graded from race.db as the debrief grades them live', () => {
  const { store, live, summary } = setup();
  const sid = findStoreSession(store.db, { uid: summary.uid, track: summary.track, sessionType: summary.sessionType, startedAt: summary.startedAt });
  assert.ok(sid, 'found by the game\'s session id');
  const a = auditFromStore(store.db, sid);
  assert.strictEqual(a.source, 'race.db');
  assert.ok(a.calls.length >= 2);
  assert.deepStrictEqual(a.summary, live.summary);
  assert.deepStrictEqual(a.calls.map((c) => [c.lapNum, c.action, c.verdict]), live.calls.map((c) => [c.lapNum, c.action, c.verdict]));
});

test('store audit: an old save without the session id is matched by track, type and start time', () => {
  const { store, summary } = setup();
  const near = findStoreSession(store.db, { uid: null, track: summary.track, sessionType: summary.sessionType, startedAt: summary.startedAt + 5 * 60e3 });
  assert.ok(near);
  assert.strictEqual(findStoreSession(store.db, { uid: null, track: summary.track, sessionType: summary.sessionType, startedAt: summary.startedAt + 3 * 3600e3 }), null, 'hours apart is another race');
  assert.strictEqual(findStoreSession(store.db, { uid: null, track: 'Monza', sessionType: summary.sessionType, startedAt: summary.startedAt }), null);
});
