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
  if (fuelDelta < 0.3) {
    upsert('fuel-risk', {
      severity: fuelDelta < 0 ? SEVERITY.CRITICAL : SEVERITY.ADVISORY,
      category: CATEGORY.STRATEGY,
      message: fuelDelta < 0
        ? `Fuel: on pace to run ${Math.abs(fuelDelta).toFixed(1)} laps short - save ~${out.fuelSavePct}% a lap: lift and coast into the big stops`
        : `Fuel: only ${fuelDelta.toFixed(1)} laps of margin to the end`,
      expiresAtMs: clock() + 15000,
    });
  } else {
    expire('fuel-risk');
  }
}

module.exports = { fuel };
