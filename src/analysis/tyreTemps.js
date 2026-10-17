// The player's tyre temperatures against their own, not against a fixed
// window. On real F1 26 races the inner (carcass) reading sat on one value
// all race in three of four (85/90/95 °C - a game setting), and the surface
// swings 50-120 °C within a lap, so an absolute "too hot" would be a guess.
// What holds is relative, and like for like: the last ~10 s against the
// same stretches of track on earlier laps - this stint's first warm laps
// (overheating), or recent green-flag laps (cold behind a safety car). A
// plain 10 s average reads hot after every slow corner and cold on every
// straight (tried on four races: 17 false calls in one).

const { median } = require('../state/race');

const BINS = 25; // stretches of the lap
const WINDOW_TICKS = 100; // ~10 s at the 10 Hz engine tick
const MIN_SPEED_KMH = 80; // the pit lane and spins say nothing about racing temperature
// shortcut: thresholds picked from 4 races' spreads, not from tyre data;
// tune once captures show what a struggling stint looks like.
const HOT_RISE_C = 8;
const HOT_CLEAR_C = 5;
const COLD_DROP_C = 12;
const BASE_LAPS = 3;
const WARM_AGE = 2; // laps on a set before its temperature is its racing temperature

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
// Telemetry order: RL, RR, FL, FR.
const axles = (t) => ({ front: (t[2] + t[3]) / 2, rear: (t[0] + t[1]) / 2 });

// Per-stretch median over some laps' profiles: [{ front, rear } | null] x BINS.
function baseProfile(laps) {
  if (laps.length < BASE_LAPS) return null;
  return Array.from({ length: BINS }, (_, b) => {
    const xs = laps.map((l) => l.bins[b]).filter(Boolean);
    return xs.length ? { front: median(xs.map((x) => x.front)), rear: median(xs.map((x) => x.rear)) } : null;
  });
}

// How far the recent samples sit from the profile, stretch for stretch.
function offset(recent, profile) {
  const d = recent.filter((s) => profile[s.bin]).map((s) => ({ front: s.front - profile[s.bin].front, rear: s.rear - profile[s.bin].rear }));
  return d.length >= WINDOW_TICKS / 2 ? { front: avg(d.map((x) => x.front)), rear: avg(d.map((x) => x.rear)) } : null;
}

function createTyreTempTracker() {
  let recent = []; // [{ bin, front, rear }]
  let lap = null; // the lap in progress: { lapNum, green, sums: [{ front, rear, n }] }
  let laps = []; // finished: { lapNum, green, compound, age, bins: [{ front, rear } | null] }
  let hotAxle = null; // hysteresis: a call stays until the rise is clearly gone

  function reset() {
    recent = [];
    lap = null;
    laps = [];
    hotAxle = null;
  }

  const finish = (l, compound, age) => ({
    lapNum: l.lapNum,
    green: l.green,
    compound,
    age,
    bins: l.sums.map((x) => (x.n ? { front: x.front / x.n, rear: x.rear / x.n } : null)),
  });

  // player: a FieldModel car. green: racing (no safety car, not in the pits).
  // trackLength: metres, for the stretch a sample belongs to.
  function update(player, green, trackLength) {
    const t = player.telemetry;
    const l = player.lapData;
    if (!t || !l || !player.status || !t.tyresSurfaceTemperature || !(trackLength > 0)) return null;
    // A flashback: the laps after the one we're on never happened.
    if (lap && l.currentLapNum < lap.lapNum) {
      laps = laps.filter((x) => x.lapNum < l.currentLapNum);
      lap = null;
      recent = [];
    }
    const compound = player.status.visualTyreCompound;
    const age = player.status.tyresAgeLaps;
    if (lap && l.currentLapNum !== lap.lapNum) {
      laps.push(finish(lap, compound, age - 1));
      if (laps.length > 30) laps.shift();
      lap = null;
    }
    if (!lap) lap = { lapNum: l.currentLapNum, green: true, sums: Array.from({ length: BINS }, () => ({ front: 0, rear: 0, n: 0 })) };
    lap.green = lap.green && green;
    if (t.speed >= MIN_SPEED_KMH && l.lapDistance >= 0) {
      const bin = Math.min(BINS - 1, Math.floor((l.lapDistance / trackLength) * BINS));
      const a = axles(t.tyresSurfaceTemperature);
      const sum = lap.sums[bin];
      sum.front += a.front;
      sum.rear += a.rear;
      sum.n++;
      recent.push({ bin, ...a });
      if (recent.length > WINDOW_TICKS) recent.shift();
    }
    if (recent.length < WINDOW_TICKS) return null;

    // Racing temperature on this compound: green laps on a warm set.
    const racing = laps.filter((x) => x.green && x.compound === compound && x.age >= WARM_AGE);
    // This stint's first warm laps (the set went on at lap currentLapNum - age).
    const stint = racing.filter((x) => x.lapNum > l.currentLapNum - age).slice(0, BASE_LAPS);
    const racingBase = baseProfile(racing.slice(-6));
    const cold = racingBase && offset(recent, racingBase);
    const drop = cold ? -Math.min(cold.front, cold.rear) : null;

    const stintBase = age > WARM_AGE + BASE_LAPS ? baseProfile(stint) : null;
    const rise = stintBase && green ? offset(recent, stintBase) : null;
    if (!rise) hotAxle = null;
    else if (hotAxle && rise[hotAxle] < HOT_CLEAR_C) hotAxle = null;
    else if (!hotAxle) hotAxle = rise.rear >= HOT_RISE_C && rise.rear >= rise.front ? 'rear' : rise.front >= HOT_RISE_C ? 'front' : null;
    return {
      coldByC: drop != null && drop >= COLD_DROP_C ? Math.round(drop) : null,
      hot: hotAxle ? { axle: hotAxle, byC: Math.round(rise[hotAxle]) } : null,
    };
  }

  return { update, reset };
}

module.exports = { createTyreTempTracker };
