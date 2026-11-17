const { SEVERITY, CATEGORY } = require('./cards');

/** @typedef {import('./cards').RuleContext} RuleContext */

// Car Status `fuelRemainingLaps` is documented as "the value on the MFD",
// which reads as the surplus over the race (+0.4) - but it could be total
// laps of fuel. The two are easy to tell apart while plenty of race is
// left (a surplus sits near zero, laps-of-fuel tracks the laps remaining),
// so each session decides once and keeps that reading. Until then the
// spec's surplus reading is used. `npm run analyze` checks it from the burn rate.
const FUEL_DECIDE_MIN_LAPS_LEFT = 8;
function fuelMeaning(fuelRemainingLaps, lapsLeft) {
  if (lapsLeft == null || lapsLeft < FUEL_DECIDE_MIN_LAPS_LEFT) return null;
  return fuelRemainingLaps > lapsLeft / 2 ? 'laps-of-fuel' : 'surplus';
}

// --- Fuel: will current load last to the flag? ---
/** @param {RuleContext} ctx */
function fuel({ lapsLeft, player, mem, out, upsert, expire, clock }) {
  if (lapsLeft == null || !player.status) return;
  const frl = player.status.fuelRemainingLaps;
  if (!mem.fuelReading) mem.fuelReading = fuelMeaning(frl, lapsLeft);
  const fuelDelta = mem.fuelReading === 'laps-of-fuel' ? frl - lapsLeft : frl;
  out.fuelMarginLaps = fuelDelta;
  // A lap of fuel is a lap's burn: 0.4 laps short with 14 to go = save ~3% of every lap's fuel.
  out.fuelSavePct = fuelDelta < 0 && lapsLeft >= 1 ? Math.max(1, Math.round((-fuelDelta / lapsLeft) * 100)) : null;
  // Only when short: the game loads short races with +0.0 to +0.3 laps on purpose, and "only 0.1 laps of margin"
  // flickered all through two real races (16 Nov 2026) that finished with fuel to spare. The margin stays on the Strategy card.
  if (fuelDelta < 0) {
    upsert('fuel-risk', {
      severity: SEVERITY.CRITICAL,
      category: CATEGORY.STRATEGY,
      message: `Fuel: on pace to run ${Math.abs(fuelDelta).toFixed(1)} laps short - save ~${out.fuelSavePct}% a lap: lift and coast into the big stops`,
      expiresAtMs: clock() + 15000,
    });
  } else {
    expire('fuel-risk');
  }
}

module.exports = { fuel };
