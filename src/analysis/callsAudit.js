// The calls audit (roadmap A2): each strategy call graded, after the race,
// against what then happened - on lap rows (datasets/laps.csv's shape), every
// car of one race. Each call is judged by the one thing it claims; following
// the rules (in the pits, under a safety car, serving a penalty) isn't graded.
const { median } = require('../lib/stats');

const OFF_MS = 1500; // two laps in a row this far off the pace before is the tyres, not traffic
const TYRES_WINDOW = 3; // "manage tyres" means the cliff is this many laps away
const CLEAN_LAPS = 3; // "the pace before": the last few clean laps on the set
const WEATHER_WINDOW = 3; // a weather call is judged on the laps right after it
const WET = new Set([7, 8]); // visual compounds: inter, wet

const RULE_KINDS = new Set(['pit', 'neutralised', 'red-flag', 'penalty', 'too-late']);
const PUSH_KINDS = new Set(['ok', 'undercut', 'rain']);

const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
const green = (l) => !l.pit && !l.neutralised && l.lapMs > 0;

// What a stop cost each car: its in- and out-lap against the cars that didn't
// stop on those laps (they ran under the same flag, so a safety car cancels out).
function stopsOf(laps) {
  const ref = new Map(); // lapNum -> median lap of cars not in the pits
  for (const l of laps) if (!l.pit && l.lapMs > 0) ref.set(l.lapNum, [...(ref.get(l.lapNum) || []), l.lapMs]);
  for (const [k, v] of ref) ref.set(k, median(v));
  const byCar = new Map();
  for (const l of laps) byCar.set(l.carIndex, [...(byCar.get(l.carIndex) || []), l]);
  const stops = [];
  for (const carLaps of byCar.values()) {
    carLaps.sort((a, b) => a.lapNum - b.lapNum);
    for (let i = 0; i < carLaps.length; i++) {
      const inLap = carLaps[i];
      if (!inLap.pit || inLap.lapNum === 1 || (i > 0 && carLaps[i - 1].pit && carLaps[i - 1].lapNum === inLap.lapNum - 1)) continue;
      const out = carLaps[i + 1] && carLaps[i + 1].pit && carLaps[i + 1].lapNum === inLap.lapNum + 1 ? carLaps[i + 1] : null;
      const both = out ? [inLap, out] : [inLap];
      if (both.some((l) => ref.get(l.lapNum) == null)) continue;
      stops.push({ carIndex: inLap.carIndex, isPlayer: inLap.isPlayer, lapNum: inLap.lapNum, green: both.every((l) => !l.neutralised), costMs: both.reduce((a, l) => a + l.lapMs - ref.get(l.lapNum), 0) });
    }
  }
  return stops;
}

// The player's laps split into stints (a new one after each stop or tyre change).
function stints(mine) {
  const out = [];
  let cur = null;
  for (const l of mine) {
    if (!cur || l.pit || l.compound !== cur.compound) out.push((cur = { compound: l.compound, laps: [] }));
    if (!l.pit) cur.laps.push(l);
  }
  return out;
}

function auditCalls(calls, laps) {
  const mine = laps.filter((l) => l.isPlayer).sort((a, b) => a.lapNum - b.lapNum);
  const stintOf = new Map();
  for (const st of stints(mine)) for (const l of st.laps) stintOf.set(l.lapNum, st);
  // Time lost against the last few green laps on the same set: a cliff, not
  // the steady wear every lap adds.
  const lost = (l) => {
    const prev = median(stintOf.get(l.lapNum).laps.filter((x) => green(x) && x.lapNum < l.lapNum).slice(-CLEAN_LAPS).map((x) => x.lapMs));
    return prev == null ? null : l.lapMs - prev;
  };
  const off = (l) => green(l) && lost(l) >= OFF_MS;
  const stops = stopsOf(laps);
  const greenStop = median(stops.filter((x) => x.green).map((x) => x.costMs));
  const totalLaps = mine.length ? mine[0].totalLaps : null;

  const grade = (c, endLap) => {
    if (RULE_KINDS.has(c.kind)) return { verdict: 'rule', why: 'Following the rules' };
    if (PUSH_KINDS.has(c.kind)) {
      const span = mine.filter((l) => l.lapNum >= c.lapNum && l.lapNum <= endLap && green(l));
      if (!span.length) return { verdict: 'unclear', why: 'No green lap before the next call' };
      const bad = span.find((l) => off(l) && span.some((n) => n.lapNum === l.lapNum + 1 && off(n) && stintOf.get(n.lapNum) === stintOf.get(l.lapNum)));
      // Damage called earlier on the same set explains slow laps; tyres can't be judged through it.
      const damaged = bad && calls.some((d) => d.kind === 'damage' && d.lapNum <= bad.lapNum && stintOf.get(d.lapNum) === stintOf.get(bad.lapNum));
      if (damaged) return { verdict: 'unclear', why: `From lap ${bad.lapNum} slow, but damage was called on this set` };
      return bad
        ? { verdict: 'wrong', why: `From lap ${bad.lapNum}, two laps ${s(lost(bad))}+ off the pace before` }
        : { verdict: 'right', why: `${span.length} green lap${span.length > 1 ? 's' : ''}, none fell away` };
    }
    if (c.kind === 'tyres' || c.kind === 'cliff') {
      const st = stintOf.get(c.lapNum);
      const window = st ? st.laps.filter((l) => l.lapNum >= c.lapNum && l.lapNum <= c.lapNum + TYRES_WINDOW && green(l)) : [];
      const bad = window.find(off);
      if (bad) return { verdict: 'right', why: `Lap ${bad.lapNum} was ${s(lost(bad))} off the pace before` };
      return window.length >= TYRES_WINDOW
        ? { verdict: 'wrong', why: `${window.length} more laps on the set without falling away` }
        : { verdict: 'unclear', why: 'Too few laps on the set after it' };
    }
    if (c.kind === 'damage') {
      const st = stintOf.get(c.lapNum);
      const before = st ? st.laps.filter((l) => l.lapNum < c.lapNum && green(l)).slice(-CLEAN_LAPS) : [];
      const nextStop = mine.find((l) => l.pit && l.lapNum >= c.lapNum);
      const after = mine.filter((l) => l.lapNum >= c.lapNum && green(l) && (!nextStop || l.lapNum < nextStop.lapNum));
      if (!before.length || !after.length || greenStop == null || totalLaps == null) return { verdict: 'unclear', why: 'No clean lap before it, or no damaged lap after, to compare' };
      const perLap = median(after.map((l) => l.lapMs)) - median(before.map((l) => l.lapMs));
      const toFlag = perLap * (totalLaps - c.lapNum);
      return { verdict: toFlag > greenStop ? 'right' : 'wrong', why: `Damage cost ${s(perLap)} a lap, ${s(toFlag)} to the flag; a stop costs ${s(greenStop)}` };
    }
    if (c.kind === 'cheap-stop') {
      const stop = stops.find((x) => x.isPlayer && x.lapNum >= c.lapNum && x.lapNum <= c.lapNum + 1);
      if (!stop || greenStop == null) return { verdict: 'unclear', why: stop ? 'No green-flag stop in the race to compare' : 'Not taken' };
      return { verdict: stop.costMs < greenStop ? 'right' : 'wrong', why: `The stop cost ${s(stop.costMs)}; one under green ${s(greenStop)}` };
    }
    if (c.kind === 'weather') {
      // The tyre it called for against the other one, on the same laps.
      const toWet = /inters/.test(c.reason);
      const gaps = [];
      for (let n = c.lapNum + 1; n <= c.lapNum + WEATHER_WINDOW; n++) {
        const lapsOn = (wet) => laps.filter((l) => l.lapNum === n && green(l) && l.compound != null && WET.has(l.compound) === wet).map((l) => l.lapMs);
        const called = median(lapsOn(toWet));
        const other = median(lapsOn(!toWet));
        if (called != null && other != null) gaps.push(other - called);
      }
      const gain = median(gaps);
      if (gain == null) return { verdict: 'unclear', why: 'Nobody on both tyres in the laps after to compare' };
      const tyre = toWet ? 'Inters' : 'Slicks';
      return { verdict: gain > 0 ? 'right' : 'wrong', why: `${tyre} ${s(Math.abs(gain))} a lap ${gain > 0 ? 'quicker' : 'slower'} over the next ${WEATHER_WINDOW} laps` };
    }
    // shortcut: pit-window and fuel calls aren't graded yet; add a rule when a race has them.
    return { verdict: 'unclear', why: 'No test for this call yet' };
  };

  const graded = calls.map((c, i) => {
    const next = calls[i + 1];
    return { ...c, ...grade(c, next ? next.lapNum - 1 : Infinity) };
  });
  const count = (v) => graded.filter((c) => c.verdict === v).length;
  return { calls: graded, summary: { calls: graded.length, graded: graded.length - count('rule'), right: count('right'), wrong: count('wrong'), unclear: count('unclear') } };
}

module.exports = { auditCalls, stopsOf };
