// Ask the race: one question about one saved session. The engine computes the session's facts
// (the brief) and puts them in front of the model; the tools, bound to the session, are for depth
// (corner by corner, other drivers, incidents). A small model answers best from facts it can see.
// Afterwards every lap time, lap number and position in the answer is checked against the brief
// and the tool results: one that isn't there is flagged, never shown as if it were the record.
const { MODELS } = require('./catalog');

const RULES = `You are Undercut's race engineer, answering a driver's question after an F1 26 session.
Use only the session facts below and what the tools return. Every lap time, lap number, position and
gap you give must appear in them: never estimate, round into new numbers, or invent a cause.
Say which lap or laps your answer comes from.
For where time went on a lap (corners, braking, speed), call compare_laps; don't answer that from the lap list.
Only if the facts and the tools can't show the answer, reply exactly: "The recording doesn't show that."
Answer in one to three short sentences, plainly. "You" is the driver. Lap times look like 1:30.948.
Tools: compare_laps for where time went between two of your laps (corners, braking, speed);
lap_times with a driver for another car's laps; gaps for the order and gaps at the end of a lap;
events for overtakes, collisions and penalties; results for the finishing order.`;

const list = (xs) => (xs.length ? xs.join(', ') : 'none');

// The session's facts as short lines, all from the race store through the tools.
function sessionBrief(tools, sessionId) {
  const s = tools.run('sessions', {}).sessions.find((x) => x.session_id === sessionId);
  if (!s) return { text: 'No such session.', facts: '', session: null };
  const run = (name, args = {}) => tools.run(name, { session_id: sessionId, ...args });
  const { laps = [] } = run('lap_times');
  const { stints = [] } = run('stints');
  const { results = [] } = run('results');
  const { events = [] } = run('events');
  const { calls = [] } = run('calls');

  const lines = [];
  lines.push(`Session: ${s.track} ${s.type}${s.date ? ` on ${s.date}` : ''}, ${s.total_laps} laps scheduled.${s.finish ? ` You ${s.grid ? `started P${s.grid} and ` : ''}finished P${s.finish}` : ''}${s.laps_completed != null ? `, ${s.laps_completed} laps completed` : ''}.`);
  if (results.length) {
    const me = results.find((r) => r.you);
    lines.push(`Result: ${results.slice(0, 3).map((r) => `P${r.position} ${r.you ? 'you' : r.driver}`).join(', ')}.`);
    const ahead = me && results.find((r) => r.position === me.position - 1);
    const behind = me && results.find((r) => r.position === me.position + 1);
    // Each sentence has the other driver as its subject, so "behind you" can't be read backwards.
    if (behind) lines.push(`${behind.driver} finished right behind you, in P${behind.position}.`);
    if (ahead) lines.push(`${ahead.driver} finished right ahead of you, in P${ahead.position}.`);
  }
  // Lap 1 is the standing start: not a lap to judge pace by.
  const clean = laps.filter((l) => l.lap > 1 && !l.pit && !l.safety_car && l.valid !== false && l.ms > 0);
  const best = clean.length ? clean.reduce((a, b) => (b.ms < a.ms ? b : a)) : null;
  if (best) {
    const worst = clean.reduce((a, b) => (b.ms > a.ms ? b : a));
    lines.push(`Best lap: lap ${best.lap}, ${best.time}. Slowest clean lap: lap ${worst.lap}, ${worst.time}.`);
  }
  if (stints.length) lines.push(`Tyres: ${stints.map((x) => `${x.tyre} laps ${x.from_lap}-${x.to_lap}`).join(', then ')}.`);
  // A stop flags its in-lap and out-lap: one stop per run of pit laps.
  const stops = [];
  for (const l of laps) {
    const last = stops[stops.length - 1];
    if (!l.pit) continue;
    if (last && l.lap === last.to + 1) last.to = l.lap;
    else stops.push({ from: l.lap, to: l.lap });
  }
  // The tyres each stop changed, from the stints (a lap row already shows the new tyre on the in-lap).
  const swap = (x) => {
    const after = stints.find((st) => st.from_lap >= x.from && st.from_lap <= x.to + 1);
    const before = after && stints[stints.indexOf(after) - 1];
    return after && before ? `: you came in on ${before.tyre} tyres and went out on ${after.tyre}` : '';
  };
  lines.push(stops.length
    ? `Pit stops: ${stops.length} (${stops.map((x) => `${x.to > x.from ? `in on lap ${x.from}, out on lap ${x.to}` : `lap ${x.from}`}${swap(x)}`).join('; ')}).`
    : 'Pit stops: you made no pit stop.');
  // A tyre change with no pit lap recorded (a red flag, say): stated, not left to work out.
  const quiet = stints.slice(1).filter((st) => !stops.some((x) => st.from_lap >= x.from && st.from_lap <= x.to + 1));
  if (quiet.length) lines.push(`Separately, the tyres changed with no pit lap recorded: ${quiet.map((st) => `${(stints[stints.indexOf(st) - 1] || {}).tyre} to ${st.tyre} before lap ${st.from_lap}`).join('; ')}.`);
  lines.push(`Safety car or VSC laps: ${list(laps.filter((l) => l.safety_car).map((l) => l.lap))}.`);
  const pens = events.filter((e) => e.code === 'PENA' && e.involves_you).map((e) => `lap ${e.lap}: ${e.what}${e.value ? ` (${e.value} s)` : ''}`);
  lines.push(`Penalties: ${list(pens)}.`);
  const traced = laps.filter((l) => l.has_telemetry).map((l) => l.lap);
  lines.push(`Laps with telemetry, for compare_laps: ${list(traced)}.`);
  if (laps.length) {
    // Each lap's gap to your best is given, so the model never subtracts lap times itself.
    lines.push('Your laps (time, seconds off your best lap, position at the line, tyre and its age in laps):');
    for (const l of laps) {
      const notes = [l.pit ? 'pit' : '', l.safety_car ? 'safety car' : '', l.valid === false ? 'invalid' : ''].filter(Boolean);
      const off = !best ? '' : l === best ? ' (best)' : ` (${l.ms >= best.ms ? '+' : '-'}${(Math.abs(l.ms - best.ms) / 1000).toFixed(3)})`;
      lines.push(`Lap ${l.lap}: ${l.time}${off} P${l.position} ${l.tyre || 'tyre unknown'} (${l.tyre_age})${notes.length ? ` - ${notes.join(', ')}` : ''}`);
    }
  }
  // Passes back and forth on one lap cancel out: the net result per driver per lap.
  const net = new Map();
  for (const e of events.filter((x) => x.code === 'OVTK' && x.involves_you)) {
    const who = e.by_you ? e.other_driver : e.driver;
    const k = `${e.lap}|${who}`;
    net.set(k, (net.get(k) || 0) + (e.by_you ? 1 : -1));
  }
  const passes = [...net].filter(([, n]) => n !== 0).slice(0, 15)
    .map(([k, n]) => { const [lap, who] = k.split('|'); return n > 0 ? `lap ${lap}: you passed ${who}` : `lap ${lap}: ${who} passed you`; });
  if (passes.length) lines.push(`Overtakes involving you: ${passes.join('; ')}.`);
  const hits = events.filter((e) => e.code === 'COLL' && e.involves_you).slice(0, 8).map((e) => `lap ${e.lap}`);
  if (hits.length) lines.push(`Collisions involving you: ${hits.join(', ')}.`);
  // The routine "all fine" push says nothing: only calls with something in them.
  const said = calls.filter((c) => !/^Tyres and fuel OK$/i.test(c.reason || ''));
  if (said.length) lines.push(`Engineer calls: ${said.slice(0, 20).map((c) => `lap ${c.lap_num} ${c.action}${c.reason ? ` (${c.reason})` : ''}`).join('; ')}.`);
  const text = lines.join('\n');
  return { text, facts: text, session: s };
}

// Every lap time, "lap N" and "PN" in the answer must appear in the facts.
function checkGrounding(answer, facts) {
  const f = facts.toLowerCase();
  const has = (re) => re.test(f);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const unsupported = [];
  for (const t of answer.match(/\b\d{1,2}:\d{2}\.\d{3}\b/g) || []) if (!f.includes(t) && !unsupported.includes(t)) unsupported.push(t);
  for (const m of answer.matchAll(/\blaps? (\d{1,3})\b/gi)) {
    const k = `lap ${m[1]}`;
    if (!has(new RegExp(`\\blaps? ${esc(m[1])}\\b|\\blap ${esc(m[1])}:`)) && !unsupported.includes(k)) unsupported.push(k);
  }
  for (const m of answer.matchAll(/\bP(\d{1,2})\b/g)) {
    if (!has(new RegExp(`\\bp${m[1]}\\b|"position":${m[1]}\\b`)) && !unsupported.includes(m[0])) unsupported.push(m[0]);
  }
  // Seconds with two or three decimals read as measured: compared by value (0.43 = 0.430).
  const known = new Set((f.match(/\d+\.\d+/g) || []).map((x) => Math.round(Number(x) * 100)));
  for (const m of answer.matchAll(/\b(\d+\.\d{2,3}) ?(?:s|secs?|seconds)\b/gi)) {
    const k = `${m[1]} s`;
    if (!known.has(Math.round(Number(m[1]) * 100)) && !unsupported.includes(k)) unsupported.push(k);
  }
  return { grounded: !unsupported.length, unsupported };
}

// What the question is about, looked up by the engine: a small model doesn't reliably pick a tool.
// Where time went on a lap -> compare_laps; the order on a lap -> gaps; a driver named -> their laps
// and incidents. The brief already answers the rest.
const TIME_WORDS = /\b(lose|lost|losing|gain|gained|faster|slower|quicker|compare|compared|difference|why|where)\b/i;
const ORDER_WORDS = /\b(ahead|behind|gap|order|leader|leading|front)\b/i;
function lookups(bound, question) {
  const out = [];
  const add = (name, args) => out.push({ name, args, result: bound.run(name, args) });
  const named = [...question.matchAll(/\blaps? (\d{1,3})(?:\s*(?:and|&|vs\.?|versus|to)\s*(?:lap )?(\d{1,3}))?/gi)].flatMap((m) => [m[1], m[2]]);
  const laps = [...new Set(named.filter(Boolean).map(Number))];
  if (TIME_WORDS.test(question) && laps.length) {
    const { laps: mine = [] } = bound.run('lap_times', {});
    const clean = mine.filter((l) => l.lap > 1 && !l.pit && !l.safety_car && l.valid !== false);
    const best = clean.length ? clean.reduce((a, b) => (b.ms < a.ms ? b : a)) : null;
    // "lap B compared with lap A": the first lap named is the one explained, else against your best.
    const [b, a] = laps.length >= 2 ? laps : [laps[0], best && best.lap];
    if (a != null && a !== b) add('compare_laps', { lap_a: a, lap_b: b });
  } else if (ORDER_WORDS.test(question) && laps.length === 1) {
    add('gaps', { lap: laps[0] });
  }
  const { results = [] } = bound.run('results', {});
  const q = question.toLowerCase();
  for (const r of results) {
    if (r.you || !r.driver || !new RegExp(`\\b${r.driver.toLowerCase().replace(/[^a-z]/g, '.')}\\b`).test(q)) continue;
    add('lap_times', { driver: r.driver });
    add('events', { driver: r.driver });
  }
  return out;
}

// A lap comparison as sentences to answer from: the overall gap, the corner that cost most, the
// rest, and how much of the gap the corners explain (in rain or traffic it's mostly between them).
function comparisonText(c) {
  const lost = c.corners.filter((k) => k.lap_b_lost_s > 0);
  const inCorners = lost.reduce((a, k) => a + k.lap_b_lost_s, 0);
  const lines = [`Comparison of lap ${c.lap_b.lap} (${c.lap_b.time}) with lap ${c.lap_a.lap} (${c.lap_a.time}): ${c.verdict}.`, `Most time lost at one corner: ${c.most_time_lost}.`];
  if (lost.length > 1) lines.push(`Other corners: ${lost.slice(1).map((k) => k.text).join('; ')}.`);
  const gained = c.corners.filter((k) => k.lap_b_lost_s < 0);
  if (gained.length) lines.push(`Corners where lap ${c.lap_b.lap} was quicker: ${gained.map((k) => k.text).join('; ')}.`);
  if (c.total_s > 0.2) {
    const share = Math.round((inCorners / c.total_s) * 100);
    lines.push(share < 50
      ? `The braking zones explain only ${inCorners.toFixed(2)} s of the ${c.total_s.toFixed(3)} s (${share}%): most of the time went between corners, on the straights and fast sections.`
      : `The braking zones explain ${inCorners.toFixed(2)} s of the ${c.total_s.toFixed(3)} s (${share}%).`);
  }
  return lines.join('\n');
}

const thinks = (model) => !!(MODELS.find((m) => m.id === model) || {}).thinks;

async function askRace({ ollama, tools, sessionId, model, question }) {
  const brief = sessionBrief(tools, sessionId);
  if (!brief.session) throw new Error('No such session');
  const bound = tools.bind(sessionId);
  const found = lookups(bound, question);
  // A lap the question names, its line repeated up front: in a 25-lap list a small model reads the wrong row.
  // Said as a sentence: a small model reads "you were P2" more reliably than a table row.
  const named = [...new Set([...question.matchAll(/\blaps? (\d{1,3})/gi)].map((m) => Number(m[1])))];
  const { laps: mine = [] } = bound.run('lap_times', {});
  const focus = named.map((n) => mine.find((l) => l.lap === n)).filter(Boolean).map((l) => `At the end of lap ${l.lap} you were P${l.position}, on ${l.tyre} tyres ${l.tyre_age} laps old; the lap took ${l.time}${l.pit ? ', a pit lap' : ''}${l.safety_car ? ', under the safety car' : ''}.`);
  const looked = [
    focus.length ? `The lap${focus.length > 1 ? 's' : ''} asked about:\n${focus.join('\n')}` : '',
    ...found.map((x) => (x.name === 'compare_laps' && !x.result.error ? comparisonText(x.result) : `${x.name}(${JSON.stringify(x.args)}): ${JSON.stringify(x.result)}`)),
  ].filter(Boolean).map((x, i) => (i ? x : `\n\nLooked up for this question:\n${x}`)).join('\n');
  const out = await ollama.ask({
    model,
    question,
    system: `${RULES}\n\nSession facts:\n${brief.text}${looked}`,
    tools: bound,
    ...(thinks(model) ? { think: false } : {}), // quicker, and no reasoning text to strip
    options: { temperature: 0.2 },
  });
  const facts = `${brief.facts}${looked}\n${JSON.stringify((out.toolCalls || []).map((c) => c.result))}`;
  const s = brief.session;
  return { ...out, lookedUp: found.map((x) => x.name), ...checkGrounding(out.answer, facts), session: { id: s.session_id, track: s.track, type: s.type, date: s.date } };
}

module.exports = { sessionBrief, checkGrounding, askRace, lookups, RULES };
