// Ask the race, charts: built-in chart commands. The engine draws every chart from race.db through
// the read-only tools; the model (or a quick button, or the engine itself for a question that's
// about something chartable) only picks which one. Each chart carries its finding: one line, worked
// out from the same data, saying what it shows.
const CHART_KINDS = ['lap_times', 'positions', 'gap_to_driver', 'lap_compare'];
const MAX_POINTS = 400;

const s3 = (v) => `${v.toFixed(3)} s`;
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
    return {
      kind,
      title: `Gap to ${them.name}`,
      x: { label: 'Lap' },
      y: { label: `Seconds behind ${them.name} (below 0: ahead)`, zero: true },
      series: [{ name: `You to ${them.name}`, you: true, points }],
      marks: mine.filter((l) => l.pit).map((l) => ({ x: l.lap, label: 'Pit' })),
      finding: `Against ${them.name}: ${say(points[0])}, ${say(points[points.length - 1])}; closest ${s3(Math.abs(closest[1]))} on lap ${closest[0]}.`,
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
  if (/\b(lap times|pace|degradation|consisten\w*|chart|graph|plot|trend)\b/i.test(question)) return { kind: 'lap_times', args: withRival };
  return null;
}

// The laps a question names, in order: "lap 12", "laps 5 and 7", "lap 22 vs lap 14".
function lapsNamed(question) {
  const found = [...question.matchAll(/\blaps? (\d{1,3})(?:\s*(?:and|&|vs\.?|versus|to)\s*(?:lap )?(\d{1,3}))?/gi)].flatMap((m) => [m[1], m[2]]);
  return [...new Set(found.filter(Boolean).map(Number))];
}

module.exports = { buildChart, chartFor, lapsNamed, CHART_KINDS };
