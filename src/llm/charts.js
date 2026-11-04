// Ask the race, charts: built-in chart commands. The engine draws every chart from race.db through
// the read-only tools; the model (or a quick button, or the engine itself for a question that's
// about something chartable) only picks which one. Each chart carries its finding: one line, worked
// out from the same data, saying what it shows.
const { trendBand } = require('../../public/spread');

const { stintReport, clean: cleanLap } = require('./insights');

const CHART_KINDS = ['lap_times', 'positions', 'gap_to_driver', 'lap_compare', 'stint_pace'];
const MAX_POINTS = 400;
// A trend needs a run of laps this long with nobody stopping and no safety car: a stop is a step in the gap, not pace.
const MIN_TREND_LAPS = 5;

const s3 = (v) => `${v.toFixed(3)} s`;
const s2 = (v) => v.toFixed(2);

// The longest run of consecutive laps in which neither car stopped nor ran under a safety car, fitted with a
// trend and its range (public/spread.js, 80%): how much a lap you gained or lost on them, and how sure that is.
// points: [lap, gap]; + = you behind them. Returns the chart band and the sentence for the finding, or null.
function gapTrend(points, isRacing, name) {
  const racing = points.filter(([lap]) => isRacing(lap));
  const runs = [];
  for (const p of racing) {
    const run = runs[runs.length - 1];
    if (run && p[0] === run[run.length - 1][0] + 1) run.push(p);
    else runs.push([p]);
  }
  const longest = runs.reduce((a, r) => (!a || r.length >= a.length ? r : a), null);
  if (!longest || longest.length < MIN_TREND_LAPS) return null;
  const t = trendBand(longest);
  if (!t) return null;
  const from = longest[0][0];
  const to = longest[longest.length - 1][0];
  const over = `over laps ${from}-${to}`;
  const clear = t.slopeLo > 0 || t.slopeHi < 0;
  const sentence = !clear
    ? `Over laps ${from}-${to} there is no clear trend in the gap to ${name} (between ${t.slopeLo >= 0 ? '+' : '-'}${s2(Math.abs(t.slopeLo))} and ${t.slopeHi >= 0 ? '+' : '-'}${s2(Math.abs(t.slopeHi))} s a lap)`
    : t.slope > 0
      ? `You lost ${s2(t.slope)} s a lap to ${name} ${over} (80% sure it was between ${s2(t.slopeLo)} and ${s2(t.slopeHi)} s)`
      : `You gained ${s2(-t.slope)} s a lap on ${name} ${over} (80% sure it was between ${s2(-t.slopeHi)} and ${s2(-t.slopeLo)} s)`;
  return {
    band: { label: 'Trend and the range it could be', from, to, slope: t.slope, slopeLo: t.slopeLo, slopeHi: t.slopeHi, line: t.band.map(([x, mid]) => [x, mid]), band: t.band.map(([x, , lo, hi]) => [x, lo, hi]) },
    sentence,
  };
}
const cleanOf = (laps) => laps.filter((l) => l.lap > 1 && !l.pit && !l.safety_car && l.valid !== false && l.ms > 0);
const bestOf = (laps) => {
  const c = cleanOf(laps);
  return c.length ? c.reduce((a, b) => (b.ms < a.ms ? b : a)) : null;
};

function buildChart(tools, sid, kind, args = {}) {
  const run = (name, a = {}) => tools.run(name, { session_id: sid, ...a });
  const { laps: mine = [] } = run('lap_times');
  const other = () => {
    if (!args.driver) return null;
    const r = run('lap_times', { driver: args.driver });
    return r.error ? r : { name: args.driver.toUpperCase(), laps: r.laps };
  };

  if (kind === 'lap_times') {
    const them = other();
    if (them && them.error) return them;
    const best = bestOf(mine);
    const worst = cleanOf(mine).reduce((a, b) => (!a || b.ms > a.ms ? b : a), null);
    const theirBest = them && bestOf(them.laps);
    return {
      kind,
      title: them ? `Lap times: you and ${them.name}` : 'Your lap times',
      x: { label: 'Lap' },
      y: { label: 'Lap time (s)' },
      series: [
        { name: 'You', you: true, points: mine.map((l) => [l.lap, l.ms / 1000]) },
        ...(them ? [{ name: them.name, points: them.laps.map((l) => [l.lap, l.ms / 1000]) }] : []),
      ],
      marks: mine.filter((l) => l.pit || l.safety_car).map((l) => ({ x: l.lap, label: l.pit ? 'Pit' : 'SC' })),
      finding: [
        best ? `Best lap ${best.lap} (${best.time})` : null,
        best && worst && worst !== best ? `slowest clean lap ${worst.lap}, ${s3((worst.ms - best.ms) / 1000)} slower` : null,
        theirBest ? `${them.name}'s best lap ${theirBest.lap} (${theirBest.time})` : null,
      ].filter(Boolean).join('; ') + '.',
    };
  }

  if (kind === 'positions') {
    const them = other();
    if (them && them.error) return them;
    const first = mine[0];
    const last = mine[mine.length - 1];
    const top = mine.reduce((a, b) => (!a || b.position < a.position ? b : a), null);
    return {
      kind,
      title: them ? `Positions: you and ${them.name}` : 'Your position, lap by lap',
      x: { label: 'Lap' },
      y: { label: 'Position', invert: true },
      series: [
        { name: 'You', you: true, points: mine.map((l) => [l.lap, l.position]) },
        ...(them ? [{ name: them.name, points: them.laps.map((l) => [l.lap, l.position]) }] : []),
      ],
      marks: mine.filter((l) => l.pit).map((l) => ({ x: l.lap, label: 'Pit' })),
      finding: first ? `P${first.position} to P${last.position} from lap ${first.lap} to lap ${last.lap}; highest P${top.position} (lap ${top.lap}).` : 'No laps.',
    };
  }

  if (kind === 'gap_to_driver') {
    const them = other();
    if (!them) return { error: 'gap_to_driver needs a driver' };
    if (them.error) return them;
    const byLap = new Map(them.laps.map((l) => [l.lap, l]));
    const points = mine
      .filter((l) => byLap.has(l.lap) && l.gap_to_leader_s != null && byLap.get(l.lap).gap_to_leader_s != null)
      .map((l) => [l.lap, +(l.gap_to_leader_s - byLap.get(l.lap).gap_to_leader_s).toFixed(3)]); // + = you behind them
    if (!points.length) return { error: `No laps you and ${them.name} both have gaps for` };
    const say = ([lap, g]) => `${g > 0 ? `${s3(g)} behind` : g < 0 ? `${s3(-g)} ahead` : 'level'} after lap ${lap}`;
    const closest = points.reduce((a, b) => (Math.abs(b[1]) < Math.abs(a[1]) ? b : a));
    const mineByLap = new Map(mine.map((l) => [l.lap, l]));
    const trend = gapTrend(points, (lap) => {
      const a = mineByLap.get(lap);
      const b = byLap.get(lap);
      return a && b && !a.pit && !b.pit && !a.safety_car && !b.safety_car;
    }, them.name);
    return {
      kind,
      title: `Gap to ${them.name}`,
      x: { label: 'Lap' },
      y: { label: `Seconds behind ${them.name} (below 0: ahead)`, zero: true },
      series: [{ name: `You to ${them.name}`, you: true, points }],
      marks: mine.filter((l) => l.pit).map((l) => ({ x: l.lap, label: 'Pit' })),
      ...(trend ? { bands: [trend.band] } : {}),
      finding: `Against ${them.name}: ${say(points[0])}, ${say(points[points.length - 1])}; closest ${s3(Math.abs(closest[1]))} on lap ${closest[0]}.${trend ? ` ${trend.sentence}.` : ''}`,
    };
  }

  if (kind === 'lap_compare') {
    const best = bestOf(mine);
    const a = args.lap_a ?? (best && best.lap);
    const b = args.lap_b;
    const tr = a != null && b != null ? tools.compareTrace(sid, a, b) : null;
    if (!tr) return { error: 'No telemetry for one of those laps' };
    const step = Math.max(1, Math.ceil(tr.d.length / MAX_POINTS));
    const thin = (ys) => tr.d.filter((_, k) => k % step === 0).map((d, k) => [Math.round(d), ys[k * step]]);
    const lost = tr.corners.filter((k) => k.timeS > 0).sort((x, y) => y.timeS - x.timeS);
    return {
      kind,
      title: `Speed: lap ${b} against lap ${a}`,
      x: { label: 'Distance (m)' },
      y: { label: 'Speed (km/h)' },
      series: [{ name: `Lap ${a}`, points: thin(tr.speedA) }, { name: `Lap ${b}`, you: true, points: thin(tr.speedB) }],
      marks: lost.slice(0, 3).map((k) => ({ x: k.atM, label: `Corner ${k.corner}: lost ${k.timeS.toFixed(2)} s` })),
      finding: `Lap ${b} was ${s3(Math.abs(tr.totalS))} ${tr.totalS >= 0 ? 'slower' : 'faster'} than lap ${a}${lost.length ? `; the most lost at corner ${lost[0].corner} (${(lost[0].atM / 1000).toFixed(1)} km), ${lost[0].timeS.toFixed(2)} s` : ''}.`,
    };
  }

  if (kind === 'stint_pace') {
    const { stints = [] } = run('stints');
    const report = stintReport(mine, stints);
    const lines = [];
    const series = [];
    const bands = [];
    report.stints.forEach((st, i) => {
      if (!st.clean_laps) return;
      const rows = mine.filter((l) => l.lap >= st.from_lap && l.lap <= st.to_lap && cleanLap(l));
      const points = rows.map((l) => [l.lap, l.ms / 1000]);
      const tyre = `${st.tyre[0].toUpperCase()}${st.tyre.slice(1)}`;
      series.push({ name: `${tyre}, laps ${st.clean_from}-${st.clean_to}`, tone: ['is-you', 'is-ref', 'is-other'][i % 3], points });
      lines.push(st.short);
      const t = st.clean_laps >= MIN_TREND_LAPS ? trendBand(points) : null;
      if (t) bands.push({ label: 'Trend and the range it could be', from: st.clean_from, to: st.clean_to, slope: t.slope, slopeLo: t.slopeLo, slopeHi: t.slopeHi, line: t.band.map(([x, mid]) => [x, mid]), band: t.band.map(([x, , lo, hi]) => [x, lo, hi]) });
    });
    if (!series.length) return { error: 'No clean laps in any stint to draw' };
    return {
      kind,
      title: 'Lap time by tyre stint',
      x: { label: 'Lap' },
      y: { label: 'Lap time (s)' },
      series,
      ...(bands.length ? { bands } : {}),
      marks: mine.filter((l) => l.pit).map((l) => ({ x: l.lap, label: 'Pit' })),
      finding: `Pace by stint, clean laps only: ${lines.join('; ')}. Tyre wear and fuel burn act together, so a stint can get quicker as the car gets lighter.`,
    };
  }

  return { error: `No chart called ${kind}; there are ${CHART_KINDS.join(', ')}` };
}

// The chart a question is about, if any (a fact like "who won" gets none). rival: a driver the
// question names. Lap numbers are read from the question; one lap is compared with your best.
const TIME_WORDS = /\b(lose|lost|losing|gain|gained|faster|slower|quicker|compare|compared|difference|where)\b/i;
function chartFor(question, { rival = null } = {}) {
  const laps = lapsNamed(question);
  if (TIME_WORDS.test(question) && laps.length) return { kind: 'lap_compare', args: laps.length >= 2 ? { lap_a: laps[1], lap_b: laps[0] } : { lap_b: laps[0] } };
  if (rival && /\b(gap|battle|fight|ahead|behind|close|closer|catch|caught|pull(ed)? away)\b/i.test(question)) return { kind: 'gap_to_driver', args: { driver: rival } };
  const withRival = rival ? { driver: rival } : {};
  if (/\b(position|positions|places?|overtak\w*|order)\b/i.test(question) && !/\bwho\b/i.test(question)) return { kind: 'positions', args: withRival };
  if (/\b(degrad\w*|wear|cliff|stints?|hold up|held up|fall(ing)? off)\b|how (did|were) (my |the )?(tyres?|tires?)/i.test(question)) return { kind: 'stint_pace', args: {} };
  if (/\b(lap times|pace|consisten\w*|chart|graph|plot|trend)\b/i.test(question)) return { kind: 'lap_times', args: withRival };
  return null;
}

// The laps a question names, in order: "lap 12", "laps 5 and 7", "lap 22 vs lap 14".
function lapsNamed(question) {
  const found = [...question.matchAll(/\blaps? (\d{1,3})(?:\s*(?:and|&|vs\.?|versus|to)\s*(?:lap )?(\d{1,3}))?/gi)].flatMap((m) => [m[1], m[2]]);
  return [...new Set(found.filter(Boolean).map(Number))];
}

module.exports = { buildChart, chartFor, lapsNamed, CHART_KINDS };
