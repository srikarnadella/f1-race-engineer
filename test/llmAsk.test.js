const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../src/data/store');
const { createRaceTools } = require('../src/llm/tools');
const { sessionBrief, checkGrounding, askRace } = require('../src/llm/ask');
const { syntheticPackets, replay } = require('./helpers/synthetic');

// Ask the race: the engine hands the model the session's facts (the brief) and checks the answer
// against them afterwards. A small model answers best from facts in front of it; the tools are
// for depth (corners, other drivers, incidents).
let fixture = null;
function tools(t) {
  if (!fixture) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-ask-'));
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

test('ask: the brief carries the session, the result and every lap of yours', (t) => {
  const tl = tools(t);
  const s = tl.run('sessions', {}).sessions[0];
  const { text, facts } = sessionBrief(tl, s.session_id);
  assert.match(text, new RegExp(`${s.track} ${s.type}`));
  assert.match(text, new RegExp(`finished P${s.finish}`));
  const laps = tl.run('lap_times', { session_id: s.session_id }).laps;
  for (const l of laps) assert.match(text, new RegExp(`^Lap ${l.lap}: ${l.time.replace('.', '\\.')}`, 'm'));
  const best = laps.filter((l) => !l.pit && !l.safety_car).reduce((a, b) => (b.ms < a.ms ? b : a));
  assert.match(text, new RegExp(`Best lap: lap ${best.lap}, ${best.time.replace('.', '\\.')}`));
  assert.ok(facts.includes(best.time));
});

test('ask: an answer whose lap times, laps and positions are all in the data is grounded; an invented one is caught', () => {
  const facts = 'Lap 2: 1:30.948 P3 soft\nLap 3: 1:31.200 P4 soft\nfinished P4';
  assert.deepStrictEqual(checkGrounding('Your best was lap 2, a 1:30.948, and you finished P4.', facts), { grounded: true, unsupported: [] });
  assert.deepStrictEqual(checkGrounding('Your best was lap 9 in 1:29.500, from P1.', facts), { grounded: false, unsupported: ['1:29.500', 'lap 9', 'P1'] });
  // Spelt-out sector or gap seconds aren't checked: only what a reader would take as a record.
  assert.strictEqual(checkGrounding('You lost about 0.3 s in sector 2.', facts).grounded, true);
});

test('ask: the model gets the brief, rules to stay on it, and tools bound to the session; the answer comes back checked', async (t) => {
  const tl = tools(t);
  const s = tl.run('sessions', {}).sessions[0];
  let sent = null;
  const ollama = {
    ask: async (req) => {
      sent = req;
      return { answer: 'The recording doesn\'t show that.', toolCalls: [] };
    },
  };
  const out = await askRace({ ollama, tools: tl, sessionId: s.session_id, model: 'qwen3:1.7b', question: 'What was the weather?' });
  assert.match(sent.system, /only/i);
  assert.match(sent.system, /doesn't show that/);
  assert.match(sent.system, new RegExp(`${s.track} ${s.type}`));
  assert.ok(!sent.tools.schemas.some((x) => x.function.name === 'sessions'), 'bound to the session');
  assert.strictEqual(sent.think, false, 'Qwen3 answers without thinking out loud: quicker');
  assert.deepStrictEqual(out, { answer: 'The recording doesn\'t show that.', toolCalls: [], lookedUp: [], charts: [], evidence: [], grounded: true, unsupported: [], session: { id: s.session_id, track: s.track, type: s.type, date: s.date } });
});

test('ask: a seconds figure the data never gave is caught too (a small model does its own sums wrong)', () => {
  const facts = 'Lap 22: 1:18.196 (+1.504) P7\nLap 5 lost 0.43 s to lap 2 at corner 2';
  assert.strictEqual(checkGrounding('Lap 22 was 1.504 s slower; corner 2 cost 0.43 seconds.', facts).grounded, true);
  assert.deepStrictEqual(checkGrounding('Lap 22 was 0.504 seconds slower.', facts).unsupported, ['0.504 s']);
});

test('ask: each lap in the brief carries its gap to your best, so the model never subtracts', (t) => {
  const tl = tools(t);
  const s = tl.run('sessions', {}).sessions[0];
  const { text } = sessionBrief(tl, s.session_id);
  assert.match(text, /^Lap \d+: \d:\d{2}\.\d{3} \(best\)/m);
  assert.match(text, /^Lap \d+: \d:\d{2}\.\d{3} \(\+\d+\.\d{3}\)/m);
});

test('ask: the engine looks up what the question is about, so a small model needn\'t pick the tool', (t) => {
  const { lookups } = require('../src/llm/ask');
  const tl = tools(t);
  const s = tl.run('sessions', {}).sessions[0];
  const bound = tl.bind(s.session_id);
  const traced = tl.run('lap_times', { session_id: s.session_id }).laps.filter((l) => l.has_telemetry).map((l) => l.lap);
  const where = lookups(bound, `Where did I lose time on lap ${traced[1]} compared with lap ${traced[0]}?`);
  assert.deepStrictEqual(where.map((x) => x.name), ['compare_laps']);
  assert.deepStrictEqual(where[0].args, { lap_a: traced[0], lap_b: traced[1] });
  const order = lookups(bound, `Who was ahead of me at the end of lap ${traced[0]}?`);
  assert.deepStrictEqual(order.map((x) => x.name), ['gaps']);
  const someone = tl.run('results', { session_id: s.session_id }).results.find((r) => !r.you).driver;
  assert.ok(lookups(bound, `How did ${someone.toLowerCase()} do?`).some((x) => x.name === 'lap_times' && x.args.driver === someone));
  assert.deepStrictEqual(lookups(bound, 'What was my best lap?'), [], 'the brief has it');
});

test('ask: a question about something chartable comes back with the chart, and the model is told what it shows', async (t) => {
  const tl = tools(t);
  const s = tl.run('sessions', {}).sessions[0];
  let sent = null;
  const ollama = { ask: async (req) => { sent = req; return { answer: 'You moved up.', toolCalls: [] }; } };
  const out = await askRace({ ollama, tools: tl, sessionId: s.session_id, model: 'qwen3:1.7b', question: 'How did my position change through the race?' });
  assert.deepStrictEqual(out.charts.map((c) => c.kind), ['positions']);
  assert.ok(sent.system.includes(out.charts[0].finding), 'the chart\'s finding is in front of the model');
  assert.ok(out.evidence.some((e) => e.includes(out.charts[0].finding)), 'and in the evidence shown with the answer');
});

test('ask: the model can put up a chart itself, from the built-in kinds only', async (t) => {
  const tl = tools(t);
  const s = tl.run('sessions', {}).sessions[0];
  const ollama = {
    ask: async (req) => {
      assert.ok(req.tools.schemas.some((x) => x.function.name === 'show_chart'));
      const shown = req.tools.run('show_chart', { kind: 'lap_times' });
      const refused = req.tools.run('show_chart', { kind: 'pie' });
      return { answer: 'Here are your laps.', toolCalls: [{ name: 'show_chart', args: { kind: 'lap_times' }, result: shown }, { name: 'show_chart', args: { kind: 'pie' }, result: refused }] };
    },
  };
  const out = await askRace({ ollama, tools: tl, sessionId: s.session_id, model: 'qwen3:1.7b', question: 'Anything else?' });
  assert.deepStrictEqual(out.charts.map((c) => c.kind), ['lap_times']);
});
