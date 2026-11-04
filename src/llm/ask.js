// Ask the race: one question about one saved session. The engine computes the session's facts
// (the brief) and puts them in front of the model; the tools, bound to the session, are for depth
// (corner by corner, other drivers, incidents). A small model answers best from facts it can see.
// Afterwards every lap time, lap number and position in the answer is checked against the brief
// and the tool results: one that isn't there is flagged, never shown as if it were the record.
const { MODELS } = require('./catalog');
const { buildChart, chartFor, lapsNamed, CHART_KINDS } = require('./charts');

const RULES = `You are Undercut's race engineer, answering a driver's question after an F1 26 session.
Use only the session facts below and what the tools return. Every lap time, lap number, position and
gap you give must appear in them: never estimate, round into new numbers, or invent a cause.
Say which lap or laps your answer comes from.
For where time went on a lap (corners, braking, speed), call compare_laps; don't answer that from the lap list.
Only if the facts and the tools can't show the answer, reply exactly: "The recording doesn't show that."
Answer in one to three short sentences, plainly, with the figures (laps, times, %) from the facts. "You" is the driver. Lap times look like 1:30.948.
Tools: compare_laps for where time went between two of your laps (corners, braking, speed);
lap_times with a driver for another car's laps; gaps for the order and gaps at the end of a lap;
events for overtakes, collisions and penalties; results for the finishing order; lap_coaching for what to
do better corner by corner; lift_and_coast for where to save fuel; car_balance for brake bias and the
differential (locking, wheelspin, understeer); battery for where to deploy and where it charged.
When coaching lines are given, pass on that advice with its numbers; don't invent other advice.
Talk about brake bias, the differential or battery deployment only if the facts below include them.`;

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
const COACH_WORDS = /\b(better|improve|improving|advice|tips?|coach\w*|work on|mistakes?)\b|throughout the lap|through the lap|around the lap/i;
const BALANCE_WORDS = /\b(bias|lock(ing|ed|s)?(?: up)?|lock-?ups?|diff|differential|wheel ?spin|traction|understeer\w*|oversteer\w*|setup|set-up)\b/i;
const COAST_WORDS = /\blift(ing)? and coast|\bcoast\w*|\bsave fuel|\bfuel sav\w*/i;
function lookups(bound, question) {
  const out = [];
  const add = (name, args) => out.push({ name, args, result: bound.run(name, args) });
  const laps = lapsNamed(question);
  if (BATTERY_WORDS.test(question)) {
    add('battery', laps.length ? { lap: laps[0] } : {});
  } else if (BALANCE_WORDS.test(question)) {
    add('car_balance', {});
  } else if (COAST_WORDS.test(question)) {
    add('lift_and_coast', laps.length ? { lap: laps[0] } : {});
  } else if (COACH_WORDS.test(question) || (TIME_WORDS.test(question) && !laps.length)) {
    // What to do better, or where time went with no lap named: a typical lap against your best.
    add('lap_coaching', laps.length === 1 ? { lap: laps[0] } : {});
  } else if (TIME_WORDS.test(question) && laps.length) {
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

// Coaching and lift-and-coast results as sentences to answer from.
function coachingText(c) {
  if (c.error) return `lap_coaching: ${c.error}`;
  const lines = [`Coaching${c.typical ? ` on a typical lap of yours (lap ${c.lap})` : ''}: ${c.verdict}. Of that, ${c.in_corners_s.toFixed(2)} s went in the braking zones and ${c.between_corners_s.toFixed(2)} s between corners.`];
  lines.push(c.advice.length ? `What to do better, biggest loss first:\n${c.advice.map((a) => `- ${a.text}`).join('\n')}` : 'No corner lost enough time to advise on.');
  return lines.join('\n');
}
function coastText(c) {
  if (c.error) return `lift_and_coast: ${c.error}`;
  return `Lift and coast (from lap ${c.lap}): ${c.summary}\n${c.candidates.map((x) => `- ${x.text}`).join('\n')}`;
}

const BATTERY_WORDS = /\b(battery|ers|deploy\w*|harvest\w*|energy|boost|overtake mode)\b/i;
function batteryText(b) {
  if (b.error) return `battery: ${b.error}`;
  const list = (xs, verb) => (xs.length ? xs.map((s) => `${s.fromKm}-${s.toKm} km ${verb} ${s.pct}%`).join(', ') : 'nowhere');
  return [
    `Battery on lap ${b.lap}: started the lap at ${b.startPct}%, ended at ${b.endPct}%, lowest ${b.lowestPct}% at ${b.lowestAtKm} km.`,
    `Deployed: ${list(b.deployed, 'used')}. Charged back: ${list(b.harvested, 'gained')}.`,
    b.straights.length ? `Battery used on each flat-out run: ${b.straights.map((z) => `before corner ${z.corner} (${z.flatOutM} m) ${Math.max(0, z.usedPct)}%`).join('; ')}.` : '',
    b.advice.length ? `What to change:\n${b.advice.map((a) => `- ${a}`).join('\n')}` : 'Nothing to change: the battery was never empty, and used where the long runs are.',
  ].filter(Boolean).join('\n');
}

function balanceText(c) {
  if (c.error) return `car_balance: ${c.error}`;
  const changed = c.changed.length ? `, then changed: ${c.changed.map((x) => `lap ${x.lap} bias ${x.brake_bias}% diff ${x.diff_on_throttle}%`).join('; ')}` : '';
  const set = `You ran ${c.settings.brake_bias ?? '?'}% brake bias and ${c.settings.diff_on_throttle ?? '?'}% on-throttle diff${changed}.`;
  const seen = c.corners.map((k) => `${k.corner != null ? `corner ${k.corner}` : `${k.atKm} km`}: ${k.issues.map((i) => `${i.kind.replace('_', ' ')}${i.wheel ? ` (${i.wheel})` : ''} on lap${i.laps.length > 1 ? 's' : ''} ${i.laps.join(', ')}`).join('; ')}`);
  // The recommendation first: a small model answers from the first thing it reads.
  return [
    c.advice.length ? `Brake bias and differential, what to change:\n${c.advice.map((a) => `- ${a}`).join('\n')}`
      : `Brake bias and differential: keep your brake bias at ${c.settings.brake_bias ?? '?'}% and your on-throttle diff at ${c.settings.diff_on_throttle ?? '?'}%. No corner showed locking, wheelspin or understeer on a third of your laps or more, so there is no change to suggest.`,
    `Why: over ${c.racingLaps} laps at pace. ${set}`,
    seen.length ? `What the car did: ${seen.join('. ')}.` : 'No locking, wheelspin or understeer was seen.',
  ].join('\n');
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
  const named = lapsNamed(question);
  const { laps: mine = [] } = bound.run('lap_times', {});
  const focus = named.map((n) => mine.find((l) => l.lap === n)).filter(Boolean).map((l) => `At the end of lap ${l.lap} you were P${l.position}, on ${l.tyre} tyres ${l.tyre_age} laps old; the lap took ${l.time}${l.pit ? ', a pit lap' : ''}${l.safety_car ? ', under the safety car' : ''}.`);
  // A pit or tyre question: the stops line up front too (a small model mixed a stop with a red-flag tyre change).
  if (/\b(pit|pitted|stop|stops|tyres?)\b/i.test(question)) focus.push(...brief.text.split('\n').filter((l) => l.startsWith('Pit stops:') || l.startsWith('Separately,')));
  const looked = [
    focus.length ? `The lap${focus.length > 1 ? 's' : ''} asked about:\n${focus.join('\n')}` : '',
    ...found.map((x) => (x.name === 'compare_laps' && !x.result.error ? comparisonText(x.result)
      : x.name === 'lap_coaching' ? coachingText(x.result)
        : x.name === 'lift_and_coast' ? coastText(x.result)
          : x.name === 'car_balance' ? balanceText(x.result)
            : x.name === 'battery' ? batteryText(x.result)
            : `${x.name}(${JSON.stringify(x.args)}): ${JSON.stringify(x.result)}`)),
  ].filter(Boolean).map((x, i) => (i ? x : `\n\nLooked up for this question (answer from this):\n${x}`)).join('\n');

  // The chart the question is about, drawn by the engine; its finding goes in front of the model too.
  const charts = [];
  const rival = (found.find((x) => x.name === 'lap_times' && x.args.driver) || { args: {} }).args.driver || null;
  // Coaching shows the two laps' speed; otherwise the chart the question is about.
  const coached = found.find((x) => x.name === 'lap_coaching' && !x.result.error);
  const pick = coached ? { kind: 'lap_compare', args: { lap_a: coached.result.best_lap, lap_b: coached.result.lap } } : chartFor(question, { rival });
  if (pick) {
    const c = buildChart(tools, sessionId, pick.kind, pick.args);
    if (!c.error) charts.push(c);
  }
  const shownText = charts.length ? `\n\nShown with your answer: a chart, "${charts[0].title}". ${charts[0].finding}` : '';
  // The model may put up a chart itself: only the built-in kinds, drawn by the engine.
  const withCharts = {
    // The engine looks up coaching, lift and coast, bias and diff, and the battery itself; offered too,
    // eleven tools confuse a small model into calling one and then refusing. The basics stay.
    // When the engine has looked the answer up, no data tools at all: the model only words it.
    schemas: found.length ? [SHOW_CHART] : [...bound.schemas.filter((x) => MODEL_TOOLS.has(x.function.name)), SHOW_CHART],
    run: (name, args) => {
      if (name !== 'show_chart') return bound.run(name, args);
      const { kind, ...rest } = args || {};
      const c = buildChart(tools, sessionId, String(kind), rest);
      if (c.error) return c;
      if (!charts.some((x) => x.title === c.title)) charts.push(c);
      return { shown: c.title, finding: c.finding };
    },
  };

  const out = await ollama.ask({
    model,
    question,
    system: `${RULES}\n\nSession facts:\n${brief.text}${looked}${shownText}`,
    tools: withCharts,
    ...(thinks(model) ? { think: false } : {}), // quicker, and no reasoning text to strip
    options: { temperature: 0.2 },
  });
  const facts = `${brief.facts}${looked}${shownText}\n${JSON.stringify((out.toolCalls || []).map((c) => c.result))}`;
  const s = brief.session;
  // What the answer was worked out from, in words, shown under it.
  const evidence = [
    ...focus,
    ...found.flatMap((x) => (x.name === 'compare_laps' && !x.result.error ? [comparisonText(x.result).split('\n').slice(0, 2).join(' ')]
      : x.name === 'lap_coaching' && !x.result.error ? [`${x.result.verdict}.`, ...x.result.advice.map((a) => a.text)]
        : x.name === 'lift_and_coast' && !x.result.error ? x.result.candidates.map((c) => c.text)
          : x.name === 'battery' && !x.result.error ? [batteryText(x.result).split('\n')[0], ...x.result.advice]
          : x.name === 'car_balance' && !x.result.error ? (x.result.advice.length ? x.result.advice : [balanceText(x.result).split('\n')[1]])
          : [evidenceLine(x)])),
    ...charts.map((c) => `${c.title}: ${c.finding}`),
  ].filter(Boolean);
  // The engine had the answer but the model refused it, said nothing or leaked tool syntax: the
  // engine's own summary answers instead, marked as such.
  const own = engineAnswer(found);
  const lost = !out.answer || !out.answer.trim() || /doesn't show|does not show/i.test(out.answer) || /<\/?tool_call>|"name"\s*:\s*"|<\/think>/.test(out.answer);
  const answered = own && lost ? { ...out, answer: own, fromEngine: true } : out;
  return { ...answered, lookedUp: found.map((x) => x.name), ...checkGrounding(answered.answer, facts), charts, evidence, session: { id: s.session_id, track: s.track, type: s.type, date: s.date } };
}

// The engine's own answer from what it looked up, in a few sentences, or null.
function engineAnswer(found) {
  const ok = found.filter((x) => x.result && !x.result.error);
  const parts = ok.map((x) => {
    const r = x.result;
    if (x.name === 'car_balance') return balanceText(r).split('\n').filter((l) => !l.startsWith('Why:') && !l.startsWith('What the car did')).join(' ').replace(/\s*- /g, ' ');
    if (x.name === 'battery') return [batteryText(r).split('\n')[0], ...r.advice].join(' ');
    if (x.name === 'lift_and_coast') return `${r.summary} ${r.candidates.map((c) => c.text).join(' ')}`;
    if (x.name === 'lap_coaching') return [`${r.verdict}.`, ...r.advice.map((a) => a.text)].join(' ');
    if (x.name === 'compare_laps') return `${r.verdict}. ${r.most_time_lost}.`;
    return null;
  }).filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

const MODEL_TOOLS = new Set(['compare_laps', 'gaps', 'lap_times', 'events', 'results']);

const SHOW_CHART = {
  type: 'function',
  function: {
    name: 'show_chart',
    description: `Put a chart up next to your answer, drawn from the recording: lap_times (your lap times, or with a driver beside yours), positions (lap by lap, optionally with a driver), gap_to_driver (needs driver), lap_compare (speed over two of your laps: lap_a the reference, lap_b the lap to explain).`,
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: CHART_KINDS, description: 'Which chart' },
        driver: { type: 'string', description: 'Another driver, for lap_times, positions or gap_to_driver' },
        lap_a: { type: 'integer', description: 'lap_compare: the reference lap' },
        lap_b: { type: 'integer', description: 'lap_compare: the lap to explain' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
};

// A looked-up result in one readable line for the evidence list.
function evidenceLine(x) {
  const r = x.result;
  if (r.error) return `${x.name}: ${r.error}`;
  if (x.name === 'gaps') return `Order at the end of lap ${r.lap}: ${r.cars.slice(0, 5).map((c) => `P${c.position} ${c.you ? 'you' : c.driver}`).join(', ')}${r.cars.some((c) => c.you && c.position > 5) ? `; you P${r.cars.find((c) => c.you).position}` : ''}.`;
  if (x.name === 'lap_times') {
    const best = (r.laps || []).filter((l) => l.lap > 1 && !l.pit && !l.safety_car).reduce((a, b) => (!a || b.ms < a.ms ? b : a), null);
    return `${x.args.driver}'s laps: ${r.laps.length}${best ? `, best lap ${best.lap} (${best.time})` : ''}.`;
  }
  if (x.name === 'events') return `${x.args.driver}'s incidents: ${(r.events || []).length ? r.events.slice(0, 4).map((e) => `lap ${e.lap} ${e.what.toLowerCase()}`).join(', ') : 'none'}.`;
  return null;
}

module.exports = { sessionBrief, checkGrounding, askRace, lookups, RULES };
