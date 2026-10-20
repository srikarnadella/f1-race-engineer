const { SEVERITY, CATEGORY } = require('./cards');
const { laps } = require('../../lib/format');

const TYRE_CLIFF_THRESHOLD_PCT = 85;
const OUT_LAP = 3; // lapData.driverStatus

/** @typedef {import('./cards').RuleContext} RuleContext */

// --- Tyres: laps-to-cliff projection (a race thing: a qualifying run is three laps) ---
/** @param {RuleContext} ctx */
function tyreCliff({ racing, wear, lapsLeft, upsert, expire, clock, out }) {
  if (racing && wear && wear.ratePerLap > 0) {
    let lapsToCliff = (TYRE_CLIFF_THRESHOLD_PCT - wear.avgWear) / wear.ratePerLap;
    // A cliff after the flag is no cliff: the set gets there - push.
    if (lapsLeft != null && lapsToCliff >= lapsLeft) {
      lapsToCliff = null;
      out.tyresReachFlag = true;
    }
    out.lapsToCliff = lapsToCliff;
    if (lapsToCliff != null && lapsToCliff <= 3) {
      upsert('tyre-cliff', {
        severity: lapsToCliff <= 1 ? SEVERITY.CRITICAL : SEVERITY.ADVISORY,
        category: CATEGORY.STRATEGY,
        message: lapsToCliff < 0.5
          ? 'Tyres: at the cliff - lap time is going'
          : `Tyres: ~${laps(Math.round(lapsToCliff))} to the cliff at this wear rate`,
        expiresAtMs: clock() + 15000,
      });
    } else {
      expire('tyre-cliff');
    }
  } else {
    // Fresh tyres (no wear trend yet) - the old set's warning is void.
    expire('tyre-cliff');
  }
}

// --- Tyre temperatures, against your own racing laps ---
/** @param {RuleContext} ctx */
function tyreTemps({ racing, analysis, neutralised, player, playerOnTrack, upsert, expire, clock }) {
  const tt = racing && analysis && analysis.tyreTemps;
  const fiveC = (c) => Math.max(5, Math.round(c / 5) * 5);
  // Behind the safety car or on an out lap: the moment to get heat in.
  if (tt && tt.coldByC && (neutralised || player.lapData.driverStatus === OUT_LAP)) {
    upsert('tyres-cold', {
      severity: SEVERITY.ADVISORY,
      category: CATEGORY.CAR,
      message: `Tyres ~${fiveC(tt.coldByC)}°C under racing temperature - ${neutralised ? 'get heat in before the restart' : 'careful on the out lap'}`,
      expiresAtMs: clock() + 5000,
    });
  } else {
    expire('tyres-cold');
  }
  if (tt && tt.hot && !neutralised && playerOnTrack) {
    upsert('tyres-hot', {
      severity: SEVERITY.INFO,
      category: CATEGORY.CAR,
      message: tt.hot.axle === 'rear'
        ? `Rears ~${fiveC(tt.hot.byC)}°C hotter than early in the stint - easy on the throttle out of slow corners`
        : `Fronts ~${fiveC(tt.hot.byC)}°C hotter than early in the stint - less lock, brake in a straight line`,
      expiresAtMs: clock() + 5000,
    });
  } else {
    expire('tyres-hot');
  }
}

module.exports = { tyreCliff, tyreTemps };
