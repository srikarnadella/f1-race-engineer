// "Box this lap, next lap, or later?" - every stop lap from now to the flag
// raced out, lap by lap, against the cars around you: where you'd rejoin,
// where you'd finish, and how much time each choice costs against the best.
//
// Lap time on a set grows by the field-learned degradation per lap of age
// (ml/tyreModel); a fresh set starts the game's own estimate quicker than
// the set you're on (Tyre Sets packet), or - without one - your current
// degradation x your tyre age quicker. Rivals keep their clean-lap pace,
// their tyres wear at their compound's rate, and a car that hasn't stopped
// yet still owes one. Places lost at the rejoin are charged the same
// track-position price as the safety-car options: a faster car still has to
// get back past. Under 1,000 small sums a lap: run on every snapshot.

const { SECONDS_PER_PLACE } = require('./strategyOptions');

// Laps run past what the game says the set has left. shortcut: a flat
// penalty; a proper cliff curve needs wear data from more races.
const CLIFF_MS_PER_LAP = 1500;
const TRAFFIC_MS = 1500;
// Shown as rows: this lap, the next two, and the best lap if it's later.
const SHOWN_DELAYS = 3;
const NAME = { 16: 'Soft', 17: 'Medium', 18: 'Hard' };
// Two laps within this of each other are a tie on these inputs: the last
// pick stands, so the screen doesn't flip between them every few seconds.
const STICKY_MS = 1000;

// me: { t (ms behind the leader), position, tyreAge, compound, degMs, lifeLeft, stopped }
// sets: the fresh dry sets you could fit: [{ compound, gainMs, degMs, life }]
// rivals: [{ name, t, paceDeltaMs (their lap minus yours), degMs, owesStop }]
// laps: whole laps left including the current one. pitLossMs: a stop now.
// prefer: the last pick (laps from now, or 'stay'), kept if it's still
// close - or kept regardless with hold (a new best that hasn't settled yet).
function pitTiming({ me, sets, rivals, laps, pitLossMs, prefer = null, hold = false }) {
  const n = laps - 1; // laps after this one - the ones a choice can change
  if (n < 1 || !sets.length) return null;
  const oldLap = (j) => me.degMs * j + (me.lifeLeft != null && j > me.lifeLeft ? CLIFF_MS_PER_LAP : 0);
  // Rival time over the next j laps, relative to your current pace.
  const rivalAt = (r, j) => r.t + r.paceDeltaMs * j + (r.degMs * j * (j + 1)) / 2;

  // Box at the end of lap +k (k = 0: this lap). Cost = time over the rest
  // of the race against staying on this pace with no wear at all.
  function option(k, set) {
    let cost = pitLossMs;
    for (let j = 1; j <= k; j++) cost += oldLap(j);
    const stint = n - k;
    for (let j = 0; j < stint; j++) cost += set.degMs * j - set.gainMs;
    // A set that can't reach the flag means another stop.
    if (set.life < stint) cost += pitLossMs;
    return cost;
  }
  // Where you'd come out of the pits: everyone else stays out until then.
  function rejoin(k) {
    let myT = me.t + pitLossMs;
    for (let j = 1; j <= k; j++) myT += oldLap(j);
    const at = rivals.map((r) => rivalAt(r, k)).sort((a, b) => a - b);
    const ahead = at.filter((t) => t < myT);
    return { position: ahead.length + 1, inTraffic: ahead.length > 0 && myT - ahead[ahead.length - 1] < TRAFFIC_MS };
  }
  const finish = (cost) => {
    const myT = me.t + cost;
    return 1 + rivals.filter((r) => rivalAt(r, n) + (r.owesStop ? pitLossMs : 0) < myT).length;
  };

  const all = [];
  for (let k = 0; k < n; k++) {
    const rj = rejoin(k);
    const placesMs = Math.max(0, rj.position - me.position) * SECONDS_PER_PLACE * 1000;
    let best = null;
    for (const set of sets) {
      const cost = option(k, set) + placesMs;
      if (!best || cost < best.cost) best = { cost, set };
    }
    all.push({ id: `box-${k}`, inLaps: k, compound: best.set.compound, cost: best.cost, ...rj });
  }
  // Staying out is only legal once you've used a second compound.
  if (me.stopped) {
    let cost = 0;
    for (let j = 1; j <= n; j++) cost += oldLap(j);
    all.push({ id: 'stay', inLaps: null, compound: me.compound, cost, position: me.position, inTraffic: false });
  }
  const cheapest = all.reduce((a, b) => (b.cost < a.cost ? b : a));
  const kept = all.find((o) => (prefer === 'stay' ? o.id === 'stay' : o.inLaps === prefer));
  const best = kept && (hold || kept.cost - cheapest.cost < STICKY_MS) ? kept : cheapest;
  const shown = all.filter((o) => (o.inLaps != null && o.inLaps < SHOWN_DELAYS) || o === best || o.id === 'stay');
  const options = shown.map((o) => ({
    id: o.id,
    inLaps: o.inLaps,
    compound: o.compound,
    compoundName: NAME[o.compound] || '?',
    rejoinPosition: o.position,
    inTraffic: o.inTraffic,
    finishPosition: finish(o.cost),
    lossS: Math.max(0, Math.round((o.cost - best.cost) / 100) / 10),
    best: o === best,
  }));
  const label = (o) => (o.inLaps == null ? 'stay out' : o.inLaps === 0 ? 'box this lap' : o.inLaps === 1 ? 'box next lap' : `box in ${o.inLaps} laps`);
  const pick = options.find((o) => o.best);
  const runnerUp = options.filter((o) => !o.best).sort((a, b) => a.lossS - b.lossS)[0];
  return {
    bestId: pick.id,
    cheapestInLaps: cheapest.id === 'stay' ? 'stay' : cheapest.inLaps,
    bestInLaps: pick.inLaps,
    // How much the best beats the next best - a near-tie isn't a call.
    marginS: runnerUp ? runnerUp.lossS : null,
    options,
    headline: `Best: ${label(pick)}${pick.inLaps != null ? ` onto ${pick.compoundName.toLowerCase()}s` : ''} - finish ~P${pick.finishPosition}${runnerUp ? `, ${runnerUp.lossS.toFixed(1)}s better than ${label(runnerUp)}` : ''}`,
    label: label(pick),
  };
}

module.exports = { pitTiming, CLIFF_MS_PER_LAP };
