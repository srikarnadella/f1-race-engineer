// "How much is the damage costing me?" - measured, not guessed: the
// player's own mini-sectors (25 equal slices of the lap, state/lapTrace.js)
// on clean laps since the damage, against clean laps before it. The slices
// say where the time goes (a front wing loses it in the corners, a rear
// wing on the straights); the sum, less what fuel burn and tyre wear alone
// would have changed, is the cost per lap - then projected to the flag and
// set against what a new front wing at a stop would cost.
//
// Before a full lap since the hit, the slices already run after it give an
// early figure, scaled up to a whole lap.

const { median } = require('../state/race');

const MINI_SECTORS = 25;
// Fewer slices than this since the hit is too little of a lap to scale up.
const MIN_PARTIAL_SECTORS = 5;
// A slice must lose at least this to be named as where the time goes.
const WHERE_MIN_MS = 40;
// Extra stationary time to fit a new nose, on top of the pit loss.
// shortcut: one figure from the F1 games' pit stop; measure it from a capture with a wing change.
const WING_CHANGE_MS = 6000;
// A new nose has to beat staying out by this to be the call.
const FIX_MARGIN_MS = 3000;

const sectorMedians = (laps) => Array.from({ length: MINI_SECTORS }, (_, k) => median(laps.map((l) => l[k]).filter((v) => v > 0)));

// baseline / damaged: clean laps' splits (arrays of 25 ms values), oldest first.
// partial: { splits (25, null where not run yet), fromSector } - this lap, from
//   the first slice that started after the hit.
// driftMs: how much quicker (-) or slower (+) a lap now would be anyway
//   (fuel burnt, tyre wear) than on the baseline laps.
// corners: [{ corner, startM }]; fixable: the front wing (the only part a stop changes).
// fixableShare: the part of the loss a new nose gets back (the wing's share of the damage).
// stopAnyway: you still owe a stop - the nose then only costs the change itself.
function damageLoss({ baseline, damaged, partial = null, driftMs = 0, corners = [], trackLength, lapsLeft = null, pitLossMs = null, fixable = false, fixableShare = 1, stopAnyway = false }) {
  if (!baseline.length) return null;
  const base = sectorMedians(baseline);
  if (base.some((v) => v == null)) return null;
  let diffs;
  let basis;
  if (damaged.length) {
    const now = sectorMedians(damaged);
    diffs = now.map((v, k) => (v == null ? 0 : v - base[k]));
    basis = 'laps';
  } else if (partial) {
    const covered = partial.splits.map((v, k) => (k >= partial.fromSector && v > 0 ? k : -1)).filter((k) => k >= 0);
    if (covered.length < MIN_PARTIAL_SECTORS) return { lossPerLapMs: null, basis: 'measuring', lapsMeasured: 0, where: [] };
    const scale = base.reduce((a, b) => a + b, 0) / covered.reduce((a, k) => a + base[k], 0);
    diffs = base.map((_, k) => (covered.includes(k) ? (partial.splits[k] - base[k]) * scale : 0));
    basis = 'partial';
  } else {
    return { lossPerLapMs: null, basis: 'measuring', lapsMeasured: 0, where: [] };
  }
  // Spread the fuel/tyre drift over the lap so it doesn't pick the corners.
  const lossPerLapMs = Math.round(diffs.reduce((a, b) => a + b, 0) - driftMs);

  const cornerAt = (k) => {
    const end = ((k + 1) * trackLength) / MINI_SECTORS;
    const before = corners.filter((c) => c.startM < end);
    return before.length ? before[before.length - 1].corner : null;
  };
  const where = [...new Set(diffs
    .map((d, k) => ({ d, k }))
    .filter((x) => x.d >= WHERE_MIN_MS)
    .sort((a, b) => b.d - a.d)
    .slice(0, 3)
    .map((x) => cornerAt(x.k))
    .filter((c) => c != null))].slice(0, 2);

  const out = { lossPerLapMs, basis, lapsMeasured: damaged.length, where };
  if (lapsLeft != null && lossPerLapMs > 0) {
    out.toFlagMs = Math.round(lossPerLapMs * lapsLeft);
    if (fixable && pitLossMs) {
      // A nose fitted at the end of this lap saves every lap after it.
      const savedMs = lossPerLapMs * fixableShare * Math.max(0, Math.ceil(lapsLeft) - 1);
      const costMs = (stopAnyway ? 0 : pitLossMs) + WING_CHANGE_MS;
      out.fix = { costMs, savedMs: Math.round(savedMs), stopAnyway, pays: savedMs - costMs >= FIX_MARGIN_MS };
    }
  }
  return out;
}

module.exports = { damageLoss, WING_CHANGE_MS, MINI_SECTORS };
