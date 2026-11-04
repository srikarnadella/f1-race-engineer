const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../src/data/store');
const { createRaceTools } = require('../src/llm/tools');
const { askRace, lookups } = require('../src/llm/ask');
const { auditFromStore } = require('../src/data/storeAudit');
const { syntheticPackets, replay } = require('./helpers/synthetic');

// Ask the race, more insights, end to end: the new tools over a recorded session, and the engine
// picking the right one for the question (a small model doesn't reliably pick a tool, so it isn't asked to).
let fixture = null;
function tools(t) {
  if (!fixture) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-insight-'));
    const file = path.join(dir, 'race.db');
    const store = openStore(file);
    replay(syntheticPackets(), { pipelineOptions: { store } }).flush();
    store.close();
    fixture = { dir, file };
  }
  const tl = createRaceTools(fixture.file);
  t.after(() => tl.close());
  return tl;
}
test.after(() => fixture && fs.rmSync(fixture.dir, { recursive: true, force: true }));
const sidOf = (tl) => tl.run('sessions', {}).sessions[0].session_id;

test('insight tools: each is offered with a schema, takes only the session, and refuses anything else', (t) => {
  const tl = tools(t);
  for (const name of ['tyres', 'pit_stops', 'lap_losses', 'field_pace', 'calls_review', 'track_history', 'race_summary']) {
    const def = tl.schemas.find((x) => x.function.name === name);
    assert.ok(def, name);
    assert.deepStrictEqual(def.function.parameters.required, ['session_id']);
    assert.match(tl.run(name, {}).error, /needs session_id/);
    assert.match(tl.run(name, { session_id: 1, lap: 3 }).error, /takes no argument "lap"/);
  }
  const bound = tl.bind(sidOf(tl));
  assert.ok(bound.schemas.some((x) => x.function.name === 'tyres'));
  assert.ok(!bound.schemas.some((x) => x.function.parameters.properties.session_id), 'bound to the session');
});

test('tyres: one entry per stint of yours, the same stints the stints tool lists', (t) => {
  const tl = tools(t);
  const sid = sidOf(tl);
  const r = tl.run('tyres', { session_id: sid });
  const stints = tl.run('stints', { session_id: sid }).stints;
  assert.deepStrictEqual(r.stints.map((x) => [x.stint, x.tyre, x.from_lap, x.to_lap]), stints.map((x) => [x.stint, x.tyre, x.from_lap, x.to_lap]));
  for (const x of r.stints) assert.ok(x.clean_laps <= x.laps && typeof x.text === 'string');
});

test('pit stops: priced exactly as the calls audit prices them', (t) => {
  const tl = tools(t);
  const sid = sidOf(tl);
  const r = tl.run('pit_stops', { session_id: sid });
  const audit = auditFromStore(tl.db, sid);
  const mine = audit.stops.filter((x) => x.isPlayer).sort((a, b) => a.lapNum - b.lapNum);
  assert.deepStrictEqual(r.stops.map((x) => [x.lap_in, x.cost_s, x.green]), mine.map((x) => [x.lapNum, Math.round(x.costMs / 100) / 10, x.green]));
  if (!mine.length) assert.match(r.text, /no pit stop/i);
});

test('lap losses: either what cost you time, or why it can\'t say', (t) => {
  const tl = tools(t);
  const r = tl.run('lap_losses', { session_id: sidOf(tl) });
  if (r.error) assert.match(r.error, /clean laps/);
  else assert.ok(r.consistency.typical && Array.isArray(r.worst));
});

test('field pace: you are in the ranking, and the fastest lap is named', (t) => {
  const tl = tools(t);
  const r = tl.run('field_pace', { session_id: sidOf(tl) });
  assert.ok(r.ranking.length > 1, 'more than one car');
  assert.ok(r.ranking.some((c) => c.you));
  assert.ok(r.fastest_lap && r.fastest_lap.time);
  assert.match(r.text, /Race pace/);
});

test('calls review: the audit\'s own verdict counts', (t) => {
  const tl = tools(t);
  const sid = sidOf(tl);
  const r = tl.run('calls_review', { session_id: sid });
  const sm = auditFromStore(tl.db, sid).summary;
  if (!sm.calls) assert.match(r.text, /no engineer calls/i);
  else assert.deepStrictEqual([r.summary.right, r.summary.wrong], [sm.right, sm.wrong]);
});

test('track history: one race at the track is no history; a session that isn\'t a race says so', (t) => {
  const tl = tools(t);
  const sid = sidOf(tl);
  const s = tl.run('sessions', {}).sessions.find((x) => x.session_id === sid);
  const r = tl.run('track_history', { session_id: sid });
  if (s.is_race) assert.match(r.text, /only race/i);
  else assert.match(r.error, /not a race/);
});

test('race summary: points that each come from a result the engine has', (t) => {
  const tl = tools(t);
  const r = tl.run('race_summary', { session_id: sidOf(tl) });
  assert.ok(r.points.length >= 2);
  assert.match(r.points[0], /^You (started|finished)/);
  assert.ok(r.points.some((p) => /^Best lap: lap \d+, \d:\d\d\.\d{3}\./.test(p)));
  assert.ok(r.text.startsWith('The race in points:'));
});

// --- The engine picks the tool ---
const fake = { run: (name) => (name === 'lap_times' ? { laps: [{ lap: 3, ms: 80000, pit: false, safety_car: false, valid: true }, { lap: 22, ms: 81500, pit: false, safety_car: false, valid: true }] } : name === 'results' ? { results: [] } : {}) };
const routed = (q) => lookups(fake, q).map((x) => x.name);

test('routing: a summary, the stops, the tyres, the laps that cost time, the field, the calls, the history', () => {
  assert.deepStrictEqual(routed('Summarize the race'), ['race_summary']);
  assert.deepStrictEqual(routed('Give me the highlights of my race'), ['race_summary']);
  assert.deepStrictEqual(routed('How did the race go?'), ['race_summary']);
  assert.deepStrictEqual(routed('Was my pit stop good?'), ['pit_stops']);
  assert.deepStrictEqual(routed('When did I pit, and what tyres did I go onto?'), ['pit_stops']);
  assert.deepStrictEqual(routed('Did I lose time in the pits?'), ['pit_stops']);
  assert.deepStrictEqual(routed('How did my tyres hold up?'), ['tyres']);
  assert.deepStrictEqual(routed('What was the tyre degradation in each stint?'), ['tyres']);
  assert.deepStrictEqual(routed('Where did the tyres fall off?'), ['tyres']);
  assert.deepStrictEqual(routed('Which laps cost me the most time?'), ['lap_losses']);
  assert.deepStrictEqual(routed('What were my biggest mistakes?'), ['lap_losses']);
  assert.deepStrictEqual(routed('How consistent was I?'), ['lap_losses']);
  assert.deepStrictEqual(routed('Who had the best race pace?'), ['field_pace']);
  assert.deepStrictEqual(routed('Who set the fastest lap?'), ['field_pace']);
  assert.deepStrictEqual(routed('Were the engineer\'s calls right?'), ['calls_review']);
  assert.deepStrictEqual(routed('Could I trust the radio calls?'), ['calls_review']);
  assert.deepStrictEqual(routed('Am I improving at this track?'), ['track_history']);
  assert.deepStrictEqual(routed('How does this compare with my other races here?'), ['track_history']);
});

test('routing: what the engine already answered, and what the brief answers, stay as they were', () => {
  assert.deepStrictEqual(routed('What can I do better?'), ['lap_coaching']);
  assert.deepStrictEqual(routed('How can I improve my lap?'), ['lap_coaching'], 'improving a lap is coaching, not history');
  assert.deepStrictEqual(routed('Where was I slow in the corners?'), [], 'no summary word, no tool: the brief answers');
  assert.deepStrictEqual(routed('Where did I lose time on lap 22 compared with my best lap?'), ['compare_laps']);
  assert.deepStrictEqual(routed('Should I change my brake bias?'), ['car_balance']);
  assert.deepStrictEqual(routed('How did I use my battery?'), ['battery']);
  assert.deepStrictEqual(routed('What was my best lap?'), []);
  assert.deepStrictEqual(routed('What was my quickest lap?'), [], 'my own fastest lap is in the brief, not the field\'s pace');
  assert.deepStrictEqual(routed('What was my fastest lap?'), []);
  assert.deepStrictEqual(routed('What rank did I finish?'), []);
  assert.deepStrictEqual(routed('Who finished right behind me?'), []);
  assert.deepStrictEqual(routed('Where did I start and where did I finish?'), []);
});

test('ask: a summary question is answered from the points, and the engine answers when the model won\'t', async (t) => {
  const tl = tools(t);
  const sid = sidOf(tl);
  let sent = null;
  const ollama = { ask: async (req) => { sent = req; return { answer: 'The recording doesn\'t show that.', toolCalls: [] }; } };
  const out = await askRace({ ollama, tools: tl, sessionId: sid, model: 'qwen3:1.7b', question: 'Summarize the race' });
  assert.deepStrictEqual(out.lookedUp, ['race_summary']);
  assert.match(sent.system, /Looked up for this question/);
  assert.match(sent.system, /The race in points:/);
  assert.strictEqual(out.fromEngine, true);
  assert.match(out.answer, /You (started|finished) P\d+/);
  assert.ok(out.evidence.length >= 2);
  assert.strictEqual(out.grounded, true, JSON.stringify(out.unsupported));
});

test('ask: a pit-stop question puts the engine\'s stop review in front of the model', async (t) => {
  const tl = tools(t);
  let sent = null;
  const ollama = { ask: async (req) => { sent = req; return { answer: 'You made no pit stop.', toolCalls: [] }; } };
  const out = await askRace({ ollama, tools: tl, sessionId: sidOf(tl), model: 'qwen3:1.7b', question: 'Was my pit stop good?' });
  assert.deepStrictEqual(out.lookedUp, ['pit_stops']);
  assert.match(sent.system, /Looked up for this question \(answer from this\):[\s\S]*(Stop 1:|You made no pit stop)/);
  assert.deepStrictEqual(sent.tools.schemas.map((x) => x.function.name), ['show_chart'], 'the engine looked it up: the model only words it');
});
