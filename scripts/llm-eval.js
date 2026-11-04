#!/usr/bin/env node
// Ask the race (roadmap L4): which local models answer questions about your races correctly.
// Every expected answer is computed from race.db through the same tools, never typed in by hand.
// Each answer is scored: the expected facts are in it, nothing in it is invented (the grounding
// check), and how long it took on this PC. Needs Ollama running with the models downloaded.
//
//   npm run llm-eval [-- --model qwen3:1.7b] [--db path/to/race.db] [--sessions 19,15]
const path = require('path');
const { parseArgs } = require('util');
const { createOllama } = require('../src/llm/ollama');
const { createRaceTools } = require('../src/llm/tools');
const { askRace } = require('../src/llm/ask');

const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Questions for one race session, each with what a right answer must contain.
function questionsFor(tools, sid) {
  const run = (name, args = {}) => tools.run(name, { session_id: sid, ...args });
  const s = tools.run('sessions', {}).sessions.find((x) => x.session_id === sid);
  const { laps } = run('lap_times');
  const { results } = run('results');
  const clean = laps.filter((l) => l.lap > 1 && !l.pit && !l.safety_car && l.valid !== false);
  const best = clean.reduce((a, b) => (b.ms < a.ms ? b : a));
  const mid = laps[Math.floor(laps.length / 2)];
  const pits = laps.filter((l) => l.pit);
  const behind = results.find((r) => r.position === s.finish + 1);
  // The tyre a stop put on: the stint starting at the stop (a lap row shows the new tyre on the in-lap already).
  const { stints } = run('stints');
  const afterStop = (inLap) => (stints.find((st) => st.from_lap >= inLap && st.from_lap <= inLap + 2) || {}).tyre || 'unknown';
  const qs = [
    { q: 'What was my best lap?', expect: [new RegExp(esc(best.time)), new RegExp(`lap ${best.lap}\\b`, 'i')] },
    { q: 'Where did I start and where did I finish?', expect: [new RegExp(`P${s.grid}\\b|${s.grid}(st|nd|rd|th)`), new RegExp(`P${s.finish}\\b|${s.finish}(st|nd|rd|th)`)] },
    // If you won, "you" is the right answer, not your in-game name.
    { q: 'Who won the race?', expect: [results[0].you ? /\byou\b/i : new RegExp(results[0].driver, 'i')] },
    { q: `What position was I in at the end of lap ${mid.lap}?`, expect: [new RegExp(`P${mid.position}\\b|${mid.position}(st|nd|rd|th)`)] },
    pits.length
      ? { q: 'When did I pit, and what tyres did I go onto?', expect: [new RegExp(`\\b(${pits.map((p) => p.lap).join('|')})\\b`), new RegExp(afterStop(pits[0].lap), 'i')] }
      : { q: 'Did I make a pit stop?', expect: [/\b(no|not|didn't|did not|none)\b/i] },
    behind ? { q: 'Who finished right behind me?', expect: [new RegExp(behind.driver, 'i')] } : null,
    { q: 'What was the track temperature?', expect: [/doesn't show|does not show|not in the|no (data|record)/i] },
  ].filter(Boolean);
  // Coaching: the corner the engine's rules rank first; lift and coast: one of its candidate corners.
  const coach = run('lap_coaching');
  if (!coach.error && coach.advice.length) qs.push({ q: 'What can I do better?', expect: [new RegExp(`corner ${coach.advice[0].corner}\\b`, 'i')], tool: 'lap_coaching' });
  const coast = run('lift_and_coast');
  if (!coast.error && coast.candidates.length) qs.push({ q: 'Where should I lift and coast to save fuel?', expect: [new RegExp(`corner (${coast.candidates.map((c) => c.corner).join('|')})\\b`, 'i')], tool: 'lift_and_coast' });
  // A "no": a corner you don't coast into. The grounding check can't see a flipped negation; this can.
  const noCoast = !coast.error && coast.candidates.find((c) => !/already coast/.test(c.text));
  if (noCoast) qs.push({ q: `Do I already lift and coast before corner ${noCoast.corner}?`, expect: [/\b(no|not|don't|do not|0 m)\b/i], tool: 'lift_and_coast' });
  // Brake bias and differential: the change the rules suggest, or that none is needed.
  const bal = run('car_balance');
  if (!bal.error) {
    const change = bal.advice.length && /(\d+) to (\d+)%/.exec(bal.advice[0]);
    qs.push({ q: 'Should I change my brake bias or differential?', expect: [change ? new RegExp(`\\b${change[2]}%`) : /\b(no changes?|nothing to change|no need|don't need|keep)\b/i], tool: 'car_balance' });
  }
  // The battery: what the lap started or ended with.
  const bat = run('battery');
  // Any battery figure from the data: start, end, lowest, a run's use, a stretch used or charged.
  const batPcts = bat.error ? [] : [bat.startPct, bat.endPct, bat.lowestPct, ...bat.straights.map((z) => Math.max(0, z.usedPct)), ...bat.deployed.map((x) => x.pct), ...bat.harvested.map((x) => x.pct)];
  if (!bat.error) qs.push({ q: 'How did I use my battery?', expect: [new RegExp(`\\b(${[...new Set(batPcts)].join('|')})%`)], tool: 'battery' });
  // Needs a tool: where time went between two laps with telemetry.
  const traced = clean.filter((l) => l.has_telemetry && l.lap !== best.lap);
  if (best.has_telemetry && traced.length) {
    const other = traced[traced.length - 1];
    const c = run('compare_laps', { lap_a: best.lap, lap_b: other.lap });
    const worst = (c.corners || []).filter((k) => k.lap_b_lost_s > 0)[0];
    // The right corner, and said as a loss (a small model flips "lost" and "gained").
    if (worst) qs.push({ q: `Where did I lose the most time on lap ${other.lap} compared with my best lap?`, expect: [new RegExp(`corner ${worst.corner}\\b|turn ${worst.corner}\\b|${worst.at_km} ?km`, 'i'), /\blost\b|\blose\b/i], tool: 'compare_laps' });
  }
  return { session: s, qs };
}

async function main() {
  const { values } = parseArgs({ options: { model: { type: 'string', multiple: true }, db: { type: 'string' }, sessions: { type: 'string' } } });
  const db = values.db || path.join(process.env.APPDATA || '', 'Undercut', 'data', 'race.db');
  const tools = createRaceTools(db);
  const ollama = createOllama();
  if (!(await ollama.detect()).installed) throw new Error('Ollama is not running');
  const have = (await ollama.models()).map((m) => m.name);
  const models = values.model || have;
  const sids = values.sessions ? values.sessions.split(',').map(Number) : tools.run('sessions', {}).sessions.filter((s) => s.is_race && s.laps_completed >= 5).slice(0, 2).map((s) => s.session_id);
  for (const model of models) {
    if (!have.includes(model)) {
      console.log(`${model}: not downloaded, skipped`);
      continue;
    }
    let right = 0;
    let grounded = 0;
    let n = 0;
    let ms = 0;
    for (const sid of sids) {
      const { session, qs } = questionsFor(tools, sid);
      console.log(`\n${model} - ${session.track} ${session.type} (${session.date})`);
      for (const { q, expect, tool } of qs) {
        const t0 = Date.now();
        let out;
        try {
          out = await askRace({ ollama, tools, sessionId: sid, model, question: q });
        } catch (err) {
          out = { answer: `ERROR ${err.message}`, grounded: false, unsupported: [], toolCalls: [] };
        }
        const took = Date.now() - t0;
        const ok = expect.every((re) => re.test(out.answer));
        n++;
        ms += took;
        right += ok ? 1 : 0;
        grounded += out.grounded ? 1 : 0;
        const used = (out.toolCalls || []).map((c) => c.name).join(',');
        console.log(`  ${ok ? 'RIGHT' : 'WRONG'} ${out.grounded ? '      ' : 'UNGROUNDED'} ${(took / 1000).toFixed(1)}s  ${q}${tool ? ` [needs ${tool}]` : ''}${used ? ` (used ${used})` : ''}`);
        console.log(`        ${out.answer.replace(/\s+/g, ' ').slice(0, 220)}${out.unsupported && out.unsupported.length ? `  <- not in the data: ${out.unsupported.join(', ')}` : ''}`);
      }
    }
    console.log(`\n${model}: ${right}/${n} right, ${grounded}/${n} grounded, ${(ms / n / 1000).toFixed(1)} s a question`);
  }
  tools.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
