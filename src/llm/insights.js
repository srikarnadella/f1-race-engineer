// Ask the race, more insights: what the engine works out from the recording and hands the model as
// sentences to answer from, each with the numbers it rests on. Pure functions over the tool-shaped rows
// (src/llm/tools.js), so a small model never does the sums: stint pace, what a stop cost against the
// field's, the laps that cost time and what was recorded on them, race pace across the field, the
// engineer's calls graded, your other races at the track. Where a number is an estimate it carries the
// range it could be (public/spread.js, 80%).
const { median } = require('../lib/stats');
const { trendBand } = require('../../public/spread');

const MIN_STINT_LAPS = 5; // clean laps in a stint to say how its pace changed
const MIN_CLEAN_LAPS = 5; // clean laps to know what a typical lap is
const LOSS_MIN_S = 0.7; // a lap this much slower than typical, with no stop or safety car, is a lap that cost time
const WORST = 3;
const PACE_MIN_LAPS = 5;

const lapStr = (ms) => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
const s1 = (ms) => Math.round(ms / 100) / 10; // seconds, one decimal, from ms
const s2 = (v) => v.toFixed(2);
const signed = (v) => `${v >= 0 ? '+' : '-'}${s2(Math.abs(v))}`;
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
// A lap of racing: not the standing start, not a stop or a safety car, not one the game threw out.
const clean = (l) => l.lap > 1 && !l.pit && !l.safety_car && l.valid !== false && l.ms > 0;

// --- Tyres: a stint at a time ---
function changeText(t) {
  const clear = t.slopeLo > 0 || t.slopeHi < 0;
  if (!clear) return `No clear change in pace over the stint (between ${signed(t.slopeLo)} and ${signed(t.slopeHi)} s a lap).`;
  const slower = t.slope > 0;
  const lo = slower ? t.slopeLo : -t.slopeHi;
  const hi = slower ? t.slopeHi : -t.slopeLo;
  return `Pace got ${slower ? 'slower' : 'quicker'} by ${s2(Math.abs(t.slope))} s a lap over the stint (80% sure it was between ${s2(lo)} and ${s2(hi)} s a lap; tyre wear and fuel burn together).`;
}

// The same, short, for a chart's finding.
function changeShort(t) {
  const clear = t.slopeLo > 0 || t.slopeHi < 0;
  if (!clear) return 'no clear change';
  const slower = t.slope > 0;
  return `${slower ? 'slower' : 'quicker'} by ${s2(Math.abs(t.slope))} s a lap (80% sure between ${s2(slower ? t.slopeLo : -t.slopeHi)} and ${s2(slower ? t.slopeHi : -t.slopeLo)} s)`;
}

// laps: your lap rows; stints: your stint rows (tyre, from_lap, to_lap).
function stintReport(laps, stints) {
  const report = {
    stints: stints.map((st) => {
      const rows = laps.filter((l) => l.lap >= st.from_lap && l.lap <= st.to_lap);
      const cl = rows.filter(clean);
      const out = { stint: st.stint, tyre: st.tyre, from_lap: st.from_lap, to_lap: st.to_lap, laps: rows.length, clean_laps: cl.length };
      const head = `Stint ${st.stint}: ${st.tyre} tyres, laps ${st.from_lap}-${st.to_lap}`;
      if (!cl.length) return { ...out, text: `${head}: no clean laps.` };
      const avg = cl.reduce((a, l) => a + l.ms, 0) / cl.length;
      const best = cl.reduce((a, b) => (b.ms < a.ms ? b : a));
      out.average = lapStr(avg);
      out.best_lap = { lap: best.lap, time: lapStr(best.ms) };
      const t = cl.length >= MIN_STINT_LAPS ? trendBand(cl.map((l) => [l.lap, l.ms / 1000])) : null;
      if (t) out.pace_change = { per_lap_s: t.slope, lo: t.slopeLo, hi: t.slopeHi, clear: t.slopeLo > 0 || t.slopeHi < 0 };
      out.clean_from = cl[0].lap;
      out.clean_to = cl[cl.length - 1].lap;
      out.short = `${st.tyre[0].toUpperCase()}${st.tyre.slice(1)} (laps ${out.clean_from}-${out.clean_to}): ${t ? changeShort(t) : 'too few clean laps to say'}`;
      out.text = `${head} (${cl.length} clean lap${cl.length === 1 ? '' : 's'}): average ${out.average}, best lap ${best.lap} (${out.best_lap.time}). ${t ? changeText(t) : 'Too few clean laps to say how the pace changed.'}`;
      return out;
    }),
  };
  report.text = report.stints.length
    ? [`You ran ${report.stints.length} stint${report.stints.length === 1 ? '' : 's'}.`, ...report.stints.map((x) => x.text)].join('\n')
    : 'The recording has no tyre stints for this session.';
  return report;
}

// --- Pit stops: priced against the field's ---
// stops: callsAudit.stopsOf rows (every car's stops, costMs against the cars that didn't stop on those laps).
function stopReview({ stops, laps, stints }) {
  const mine = stops.filter((s) => s.isPlayer).sort((a, b) => a.lapNum - b.lapNum);
  const others = stops.filter((s) => !s.isPlayer && s.green);
  const med = others.length ? median(others.map((s) => s.costMs)) : null;
  const byLap = new Map(laps.map((l) => [l.lap, l]));
  const out = mine.map((s, i) => {
    const lapIn = s.lapNum;
    const outRow = byLap.get(lapIn + 1);
    const lapOut = outRow && outRow.pit ? lapIn + 1 : lapIn;
    const after = stints.find((st) => st.from_lap >= lapIn && st.from_lap <= lapOut + 1);
    const before = after && stints[stints.indexOf(after) - 1];
    const pos = (n) => (byLap.get(n) ? byLap.get(n).position : null);
    const r = {
      lap_in: lapIn, lap_out: lapOut, cost_s: s1(s.costMs), green: s.green, field_median_s: med == null ? null : s1(med), field_stops: others.length,
      vs_field_s: med == null || !s.green ? null : s1(s.costMs - med), tyre_from: before ? before.tyre : null, tyre_to: after ? after.tyre : null,
      position_before: pos(lapIn - 1), position_after: pos(lapOut),
    };
    const swap = r.tyre_from && r.tyre_to ? `, ${r.tyre_from} to ${r.tyre_to}` : '';
    const parts = [`Stop ${i + 1}: in on lap ${lapIn}${lapOut > lapIn ? `, out on lap ${lapOut}` : ''}${swap}.`];
    if (!s.green) {
      parts.push(`It cost ${r.cost_s.toFixed(1)} s, under a safety car or VSC, which makes a stop cheaper than under the green flag${med == null ? '' : ` (the other cars' green-flag stops cost ${r.field_median_s.toFixed(1)} s)`}.`);
    } else if (med == null) {
      parts.push(`It cost ${r.cost_s.toFixed(1)} s against the cars that didn't stop on those laps.`);
    } else {
      const d = r.vs_field_s;
      parts.push(`It cost ${r.cost_s.toFixed(1)} s against the cars that didn't stop on those laps: ${d === 0 ? 'level with' : `${Math.abs(d).toFixed(1)} s ${d > 0 ? 'slower' : 'quicker'} than`} the ${others.length} green-flag stop${others.length === 1 ? '' : 's'} of the other cars (typically ${r.field_median_s.toFixed(1)} s).`);
    }
    if (r.position_before != null && r.position_after != null) {
      const moved = r.position_after - r.position_before;
      parts.push(`You were P${r.position_before} at the end of lap ${lapIn - 1} and P${r.position_after} at the end of lap ${lapOut}${moved ? `, ${Math.abs(moved)} place${Math.abs(moved) === 1 ? '' : 's'} ${moved > 0 ? 'lost' : 'gained'}` : ''}.`);
    }
    return { ...r, text: parts.join(' ') };
  });
  return { stops: out, field: { median_s: med == null ? null : s1(med), stops: others.length }, text: out.length ? out.map((x) => x.text).join('\n') : 'You made no pit stop.' };
}

// --- Laps that cost time, and why ---
const ISSUE = { front_lock: 'front-wheel locking', rear_lock: 'rear-wheel locking', wheelspin: 'wheelspin', understeer: 'understeer' };

// laps: your lap rows; events: events about you and the race (tools.events); issues: corner_issue rows.
function lapLosses({ laps, events, issues }) {
  const cl = laps.filter(clean);
  if (cl.length < MIN_CLEAN_LAPS) return { error: `Needs at least ${MIN_CLEAN_LAPS} clean laps to know what a typical lap is` };
  const typical = median(cl.map((l) => l.ms));
  const best = Math.min(...cl.map((l) => l.ms));
  const within = cl.filter((l) => Math.abs(l.ms - typical) <= 500).length;
  const consistency = { clean_laps: cl.length, typical: lapStr(typical), best_vs_typical_s: +((typical - best) / 1000).toFixed(2), within_half_s_pct: Math.round((within / cl.length) * 100) };
  const why = (lap, invalid) => {
    const out = [];
    for (const e of events.filter((x) => x.lap === lap && x.involves_you)) {
      const other = e.by_you ? e.other_driver : e.driver;
      if (e.code === 'COLL') out.push(`a collision${other ? ` with ${other}` : ''}`);
      else if (e.code === 'PENA') out.push(`a penalty (${String(e.what || 'penalty').toLowerCase()}${e.value ? `, ${e.value} s` : ''})`);
      else if (e.code === 'OVTK') out.push(e.by_you ? `you passed ${other}` : `${other} passed you`);
      else if (e.code === 'FLBK') out.push('a flashback');
    }
    if (invalid) out.push('the game marked the lap invalid (track limits)');
    for (const i of issues.filter((x) => x.lap_num === lap)) out.push(`${ISSUE[i.kind] || String(i.kind).replace('_', ' ')}${i.wheel ? ` (${i.wheel})` : ''} at ${(i.distance_m / 1000).toFixed(1)} km`);
    return out;
  };
  const worst = laps
    .filter((l) => l.lap > 1 && !l.pit && !l.safety_car && l.ms > 0)
    .map((l) => ({ l, lost: (l.ms - typical) / 1000 }))
    .filter((x) => x.lost >= LOSS_MIN_S)
    .sort((a, b) => b.lost - a.lost)
    .slice(0, WORST)
    .map(({ l, lost }) => {
      const reasons = why(l.lap, l.valid === false);
      const head = `Lap ${l.lap} was ${s2(lost)} s slower than your typical lap`;
      return { lap: l.lap, lost_s: lost, reasons, text: reasons.length ? `${head}. On that lap: ${reasons.join('; ')}.` : `${head}, and no collision, penalty, pass or locking was recorded on it (the recording doesn't show why).` };
    });
  const lead = `Consistency: your typical clean lap was ${consistency.typical} over ${cl.length} clean laps; ${consistency.within_half_s_pct}% of them were within 0.5 s of it, and your best lap was ${s2(consistency.best_vs_typical_s)} s quicker than typical.`;
  return { consistency, worst, text: [lead, ...(worst.length ? ['Laps that cost the most time:', ...worst.map((w) => `- ${w.text}`)] : [`No lap cost you more than ${LOSS_MIN_S} s over your typical lap (stops and safety-car laps aside).`])].join('\n') };
}

// --- Race pace across the field ---
// cars: [{ driver, you, laps }], every car's lap rows.
function fieldPace(cars) {
  const ranking = cars
    .map((c) => ({ driver: c.driver, you: !!c.you, cl: c.laps.filter(clean) }))
    .filter((c) => c.cl.length >= PACE_MIN_LAPS)
    .map((c) => ({ driver: c.driver, you: c.you, typical_ms: median(c.cl.map((l) => l.ms)), typical: lapStr(median(c.cl.map((l) => l.ms))), clean_laps: c.cl.length }))
    .sort((a, b) => a.typical_ms - b.typical_ms);
  let fastest = null;
  for (const c of cars) for (const l of c.laps) if (l.lap > 1 && !l.pit && l.valid !== false && l.ms > 0 && (!fastest || l.ms < fastest.ms)) fastest = { driver: c.driver, lap: l.lap, ms: l.ms, time: lapStr(l.ms) };
  const mine = ranking.findIndex((c) => c.you);
  const you = mine < 0 ? null : { rank: mine + 1, of: ranking.length, typical: ranking[mine].typical, off_quickest_s: +((ranking[mine].typical_ms - ranking[0].typical_ms) / 1000).toFixed(2) };
  const top = ranking.slice(0, 5).map((c, i) => `${ordinal(i + 1)} ${c.driver} ${c.typical}`);
  if (you && you.rank > 5) top.push(`${ordinal(you.rank)} YOU ${you.typical}`);
  const text = ranking.length
    ? [`The quickest race pace (typical clean lap) was ${ranking[0].driver}, ${ranking[0].typical}.`, `Race pace ranking: ${top.join(', ')}.`, you ? `You were ${ordinal(you.rank)} of ${you.of} on race pace, ${s2(you.off_quickest_s)} s off the quickest car's typical lap.` : '', fastest ? `The fastest single lap of the race (one lap, not race pace): ${fastest.driver}, ${fastest.time} on lap ${fastest.lap}.` : ''].filter(Boolean).join(' ')
    : 'No car ran enough clean laps to rank race pace.';
  return { ranking: ranking.map(({ typical_ms, ...r }) => r), you, fastest_lap: fastest && { driver: fastest.driver, lap: fastest.lap, time: fastest.time }, text };
}

// --- The calls, and your other races here ---
function callsReview(audit) {
  const sm = audit.summary;
  if (!sm || !sm.calls) return { graded: [], text: 'The recording has no engineer calls for this session.' };
  const graded = audit.calls.filter((c) => c.verdict !== 'rule').map((c) => ({ lap: c.lapNum, action: c.action, reason: c.reason || null, verdict: c.verdict, why: c.why }));
  const could = sm.right + sm.wrong;
  const head = `The engineer made ${sm.calls} calls. ${sm.right} of the ${could} calls it could grade were right and ${sm.wrong} wrong${sm.unclear ? `; ${sm.unclear} couldn't be judged from the laps that followed` : ''}.`;
  const lines = graded.slice(0, 12).map((c) => `- lap ${c.lap} ${c.action}${c.reason ? ` (${c.reason})` : ''}: ${c.verdict} - ${c.why}`);
  return { summary: sm, graded, text: [head, ...lines].join('\n') };
}

function trackHistory({ track, races, sessionId }) {
  const rs = [...races].sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.sessionId - b.sessionId);
  if (rs.length < 2) return { track, races: rs, this_race: null, text: `This is your only race at ${track} in the recording, so there is no history to compare with.` };
  const me = rs.find((r) => r.sessionId === sessionId) || rs[rs.length - 1];
  const bestRank = 1 + rs.filter((r) => r.bestMs < me.bestMs).length;
  const paceRank = 1 + rs.filter((r) => r.typicalMs < me.typicalMs).length;
  const first = rs[0];
  const last = rs[rs.length - 1];
  const list = rs.map((r) => `${r.date}${r.finish ? ` P${r.finish}` : ''} best ${lapStr(r.bestMs)}, typical ${lapStr(r.typicalMs)}`).join('; ');
  const text = [
    `You have ${rs.length} races at ${track}: ${list}.`,
    bestRank === 1 ? `This race was your best lap there (${lapStr(me.bestMs)}).` : `This race's best lap (${lapStr(me.bestMs)}) was your ${ordinal(bestRank)} best there.`,
    paceRank === 1 ? 'It was also your best race pace there.' : `Its race pace (typical lap ${lapStr(me.typicalMs)}) was your ${ordinal(paceRank)} best there.`,
    `From your first race there to your latest, your typical lap went from ${lapStr(first.typicalMs)} to ${lapStr(last.typicalMs)}.`,
  ].join(' ');
  return { track, races: rs, this_race: { best_rank: bestRank, pace_rank: paceRank, of: rs.length }, text };
}

// --- The race in points ---
// Each point is written from a result the engine already has; a part that isn't there is left out.
function raceSummary({ session, laps, stops, losses, pace, calls, coaching }) {
  const points = [];
  const gained = session.grid && session.finish ? session.grid - session.finish : 0;
  if (session.finish) {
    points.push(`${session.grid ? `You started P${session.grid} and finished P${session.finish}` : `You finished P${session.finish} in ${session.type}`}${gained ? `, ${Math.abs(gained)} place${Math.abs(gained) === 1 ? '' : 's'} ${gained > 0 ? 'gained' : 'lost'}` : ''}.`);
  }
  const cl = laps.filter(clean);
  if (cl.length) {
    const best = cl.reduce((a, b) => (b.ms < a.ms ? b : a));
    points.push(`Best lap: lap ${best.lap}, ${lapStr(best.ms)}.`);
  }
  if (stops && session.is_race !== false) {
    points.push(stops.stops.length
      ? stops.stops.map((x) => `Stop on lap ${x.lap_in}: cost ${x.cost_s.toFixed(1)} s${x.green && x.vs_field_s != null ? `, ${x.vs_field_s === 0 ? 'level with' : `${Math.abs(x.vs_field_s).toFixed(1)} s ${x.vs_field_s > 0 ? 'slower' : 'quicker'} than`} the ${stops.field.stops} green-flag stop${stops.field.stops === 1 ? '' : 's'} of the other cars` : x.green ? '' : ', under a safety car or VSC'}.`).join(' ')
      : 'You made no pit stop.');
  }
  if (pace && pace.you) points.push(`You were ${ordinal(pace.you.rank)} of ${pace.you.of} on race pace, ${s2(pace.you.off_quickest_s)} s off the quickest.`);
  if (losses && losses.worst) points.push(losses.worst.length ? `Costliest lap: ${losses.worst[0].text}` : `No lap cost you more than ${LOSS_MIN_S} s over your typical lap (stops and safety-car laps aside).`);
  if (calls && calls.summary && calls.summary.calls) {
    const could = calls.summary.right + calls.summary.wrong;
    points.push(`${calls.summary.right} of the ${could} calls the engineer made that could be graded were right.`);
  }
  if (coaching && coaching.advice && coaching.advice.length) points.push(`Work on: ${coaching.advice[0].text}`);
  return { points, text: ['The race in points:', ...points.map((p) => `- ${p}`)].join('\n') };
}

module.exports = { raceSummary, stintReport, clean, stopReview, lapLosses, fieldPace, callsReview, trackHistory };
