// Under a safety car, VSC or red flag: every realistic choice, side by side,
// so the decision is the driver's and an informed one.
//
//   Stay out           - keep the position; does the current set reach the flag?
//   Box: <compound>    - one per compound you still have a set of: where you'd
//                        rejoin (cheap stop under yellow, free under a red flag),
//                        the set's life against the laps left, and the game's
//                        own lap-time estimate against your current set.
//
// Each option is costed in seconds so they can be ranked: positions lost,
// lap time over the laps left, and another stop if the tyres won't last.

const { laps } = require('../lib/format');

const NAME = { 16: 'Soft', 17: 'Medium', 18: 'Hard', 7: 'Inter', 8: 'Wet' };
const WET = new Set([7, 8]);
// Track position has a value beyond the raw gap - it has to be won back on
// track. A blunt, track-independent figure.
const SECONDS_PER_PLACE = 1.5;
// The game's lap-time estimate is for the set as it is now; a new set's edge
// fades as it wears, so over a stint it's worth roughly this share of it.
const STINT_PACE_SHARE = 0.6;

// Extra stops needed to reach the flag when a set can't: each later stint
// gets the longest-lasting set you have.
function extraStops(lifeLaps, lapsLeft, longestLife) {
  if (lifeLaps >= lapsLeft) return 0;
  return Math.ceil((lapsLeft - lifeLaps) / Math.max(1, longestLife));
}

const round1 = (x) => Math.round(x * 10) / 10;

// Rain due under a safety car / VSC, on slicks: box for inters at the end of
// this lap, or stay out and stop under green when it rains? Boxing now saves
// the difference in pit loss, and costs the laps run on inters on a dry track
// before the rain - counted as if the safety car comes in at this line, the
// worst case for boxing now. In seconds; gainS > 0 = box now.
// shortcut: staying out also loses the lap the rain arrives on slicks; not
// counted, so this leans to staying out. interDeltaMs is the game's figure for
// now, which shrinks as the rain nears (3.5s -> 2.2s in Austria), same lean.
function intersNowGain({ rainInLaps, lapFractionLeft, stopLossMs, normalLossMs, interDeltaMs }) {
  const saveS = round1((normalLossMs - stopLossMs) / 1000);
  const dryLaps = round1(Math.max(0, rainInLaps - lapFractionLeft));
  const dryCostS = round1((dryLaps * interDeltaMs) / 1000);
  return { saveS, dryLaps, dryCostS, gainS: round1(saveS - dryCostS) };
}

// player: FieldModel car. tyreSets: the player's (packet 12). rejoin: the
// rejoin prediction for a stop now (or null). stopLossMs / normalLossMs:
// pit loss now (reduced under yellow) and under green. rainStop: rain due
// before the flag on slicks ({ rainInLaps, ...intersNowGain }) or null.
function strategyOptions({ situation, lapsLeft, player, tyreSets, rejoin, stopLossMs, normalLossMs, wetConditions = false, rainStop = null }) {
  const st = player.status;
  const lap = player.lapData;
  if (!st || !lap || !tyreSets || !tyreSets.length || lapsLeft == null) return null;
  const left = Math.max(1, Math.ceil(lapsLeft));
  const freeStop = situation === 'Red flag';
  const pos = lap.carPosition;
  const fitted = tyreSets.find((s) => s.fitted) || null;
  const anotherStopS = (normalLossMs || 22000) / 1000;
  const rainDue = !!rainStop && !WET.has(st.visualTyreCompound);
  const rainLaps = rainDue && Math.max(1, Math.round(rainStop.rainInLaps));

  const options = [];
  const fittedLife = fitted ? fitted.lifeSpan : null;
  const stayReaches = fittedLife == null || fittedLife >= left;
  const longestLife = Math.max(1, ...tyreSets.filter((s) => s.available && !s.fitted).map((s) => s.usableLife || s.lifeSpan));
  options.push({
    id: 'stay',
    title: 'Stay out',
    compound: st.visualTyreCompound,
    position: pos,
    positionsLost: 0,
    tyre: `${NAME[st.visualTyreCompound] || '?'} · ${st.tyresAgeLaps} laps old${fitted ? `, ${fitted.wear}% worn` : ''}`,
    lifeLaps: fittedLife,
    reachesFlag: stayReaches,
    paceDeltaS: 0,
    // Slicks in the rain: a stop for inters under green is coming either way.
    costS: extraStops(fittedLife == null ? left : fittedLife, left, longestLife) * anotherStopS + (rainDue ? anotherStopS : 0),
  });

  // The freshest set of each compound you still have (inters/wets only
  // when the weather calls for them).
  const best = new Map();
  for (const s of tyreSets) {
    if (!s.available || s.fitted || !NAME[s.visualTyreCompound]) continue;
    if (WET.has(s.visualTyreCompound) !== (wetConditions || rainDue)) continue;
    const b = best.get(s.visualTyreCompound);
    if (!b || s.lifeSpan > b.lifeSpan) best.set(s.visualTyreCompound, s);
  }
  for (const [compound, s] of best) {
    const position = freeStop ? pos : rejoin ? rejoin.position : null;
    const lost = position != null ? Math.max(0, position - pos) : null;
    const reaches = s.lifeSpan >= left;
    const paceDeltaS = s.lapDeltaTimeMs / 1000; // vs the fitted set, per lap
    const stopS = freeStop ? 0 : (stopLossMs || normalLossMs || 22000) / 1000;
    if (rainDue) {
      // Every car on slicks has to stop for inters too, so the places lost
      // come back: it's this stop's cost against a green one, plus the dry
      // laps on this set before the rain (intersNowGain).
      options.push({
        id: `box-${compound}`, title: `Box: ${NAME[compound]}`, compound, position, positionsLost: lost,
        tyre: `${NAME[compound]} · ${s.wear ? `used, ${s.wear}% worn` : 'new'}`,
        lifeLaps: s.lifeSpan, reachesFlag: reaches, paceDeltaS: 0,
        costS: stopS + round1((rainStop.dryLaps * s.lapDeltaTimeMs) / 1000) + extraStops(s.lifeSpan, left, longestLife) * anotherStopS,
      });
      continue;
    }
    options.push({
      id: `box-${compound}`,
      title: `Box: ${NAME[compound]}`,
      compound,
      position,
      positionsLost: lost,
      tyre: `${NAME[compound]} · ${s.wear ? `used, ${s.wear}% worn` : 'new'}`,
      lifeLaps: s.lifeSpan,
      reachesFlag: reaches,
      paceDeltaS,
      // Lost places are costed as track position; the stop itself is already in them.
      costS: (lost != null ? lost * SECONDS_PER_PLACE : stopS) + paceDeltaS * STINT_PACE_SHARE * Math.min(left, s.lifeSpan) + extraStops(s.lifeSpan, left, longestLife) * anotherStopS,
    });
  }
  if (options.length < 2) return null;

  options.forEach((o) => { o.costS = Math.round(o.costS * 10) / 10; });
  const ranked = [...options].sort((a, b) => a.costS - b.costS);
  ranked[0].recommended = true;
  const why = (o) => {
    if (o.id === 'stay' && rainDue) return `keep the position, but rain in ~${laps(rainLaps)} - a stop for inters under green`;
    if (o.id === 'stay') return o.reachesFlag ? 'keep the position, tyres reach the flag' : `keep the position, but the tyres are ~${left - o.lifeLaps} laps short`;
    const parts = [];
    if (rainDue) {
      const gain = options[0].costS - o.costS; // against staying out and stopping under green
      parts.push(`~${Math.round(Math.abs(gain))}s ${gain >= 0 ? 'better' : 'worse'} than stopping later`);
      return parts.join(', ');
    }
    if (o.position != null) parts.push(o.positionsLost ? `rejoin P${o.position}` : `keep P${o.position}`);
    parts.push(o.reachesFlag ? 'lasts to the flag' : `~${left - o.lifeLaps} laps short`);
    if (Math.abs(o.paceDeltaS) >= 0.1) parts.push(`${Math.abs(o.paceDeltaS).toFixed(1)}s/lap ${o.paceDeltaS < 0 ? 'faster' : 'slower'}`);
    return parts.join(', ');
  };
  for (const o of options) o.summary = why(o);
  const best1 = ranked[0];
  const alt = ranked[1];
  return {
    situation,
    lapsLeft: left,
    freeStop,
    options,
    recommendedId: best1.id,
    headline: `${situation}: best is ${best1.title.toLowerCase()} - ${best1.summary}${alt ? `. Or ${alt.title.toLowerCase()}: ${alt.summary}` : ''}`,
  };
}

module.exports = { strategyOptions, intersNowGain, SECONDS_PER_PLACE };
