// "Is the car ahead about to pit?" - when each car is likely to stop next.
//
// The AI's stop lap is a strategy, not a wear limit: on a real F1 26 Monaco
// race the cars on mediums all boxed at 12 laps old, on sets the game rated
// for 19-20 laps (Tyre Sets packet, usableLife), with wear under 30%. So a
// car that still owes its stop is expected at a share of its set's rated
// life - learned from this race's own green-flag stops once there are some,
// a prior until then. A car that has stopped stops again only if its set
// can't reach the flag.
//
// Once this race (or an earlier one at this track) has shown the wear the
// AI boxes at - the most-worn tyre was 36-37% on all three of those Monaco
// stops - each car is timed by its own wear rate instead: a car eating its
// tyres is due sooner than its age says.

const { median } = require('../lib/stats');

// shortcut: one prior share for every compound and track (from one race);
// this race's own stops replace it as soon as two have been seen.
const STOP_SHARE_PRIOR = 0.6;
// Rated life per compound, for a car whose Tyre Sets packet hasn't arrived.
const DEFAULT_USABLE_LIFE = { 16: 15, 17: 20, 18: 25 };
const MIN_LEARNED_STOPS = 2;
const MIN_WEAR_AGE = 2;

// Laps from now until the car boxes (0 = at the end of this lap), or null
// if no stop is expected before the flag. lapsLeft: whole laps left
// including this one. owesStop: hasn't stopped in a dry race (two
// compounds are compulsory). wear: the car's most-worn tyre, %; startWear:
// what it read when the set went on (a used set isn't at 0); stopWear: the
// wear cars have been boxing at (null until learned).
function expectedStopIn({ compound, age, usableLife, owesStop, lapsLeft, stopShare = null, wear = null, startWear = 0, stopWear = null }) {
  if (age == null || lapsLeft == null) return null;
  const life = usableLife || DEFAULT_USABLE_LIFE[compound];
  if (!life) return null;
  const n = Math.ceil(lapsLeft) - 1; // laps after this one
  if (owesStop) {
    if (n < 1) return null;
    // Wear per lap is only steady after the first couple of laps on a set.
    const worn = wear - (startWear || 0); // this stint's wear
    const byWear = stopWear && worn > 0 && age >= MIN_WEAR_AGE;
    const due = byWear ? Math.round(age + ((stopWear - wear) * age) / worn) : Math.round((stopShare || STOP_SHARE_PRIOR) * life);
    // Running long past it: not "this lap" every lap - expect it at the end
    // of the set's rated life, or the last chance (the end of the second-last lap).
    const k = age <= due ? due - age : Math.max(0, life - age) || n - 1;
    return Math.min(n - 1, k);
  }
  if (age + n <= life) return null; // the set reaches the flag
  const k = Math.max(0, life - age);
  return k < n ? k : null;
}

// The share of rated life (or the wear) cars have actually stopped at, once
// there are enough stops to trust it.
const learned = (samples) => (samples.length < MIN_LEARNED_STOPS ? null : median(samples));

// The most-worn tyre: the one that ends the stint.
const maxWear = (car) => (car.damage && car.damage.tyresWear ? Math.max(...car.damage.tyresWear) : null);

module.exports = { expectedStopIn, learned, maxWear };
