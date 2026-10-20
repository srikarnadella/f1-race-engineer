const { SEVERITY, CATEGORY } = require('./cards');
const { laps } = require('../../lib/format');
const { RAIN_IMMINENT_LAPS } = require('../weather');

/** @typedef {import('./cards').RuleContext} RuleContext */

// Weather: warn this many laps ahead of rain; call the tyre switch once the
// other tyre is this much quicker per lap (less is lap-time noise).
const RAIN_WARN_LAPS = 10;
const CROSSOVER_MS = 1000;
const WEATHER_NAME = ['clear', 'light cloud', 'overcast', 'light rain', 'heavy rain', 'storm'];

// --- Weather ---
// The MFD lists forecast slots in minutes; the driver needs "how many
// laps until it rains / stops", and - once conditions change - whether
// the cars on the other tyre are already faster (the crossover).
/** @param {RuleContext} ctx */
function weather({ analysis, playerOnTrack, neutralised, redFlag, out, upsert, expire, clock }) {
  const wx = analysis && analysis.weather;
  const nc = wx && wx.nextChange;
  const lapsAway = (n) => `~${laps(Math.max(1, Math.round(n)))}`;
  const rainDue = !!(nc && nc.to === 'rain' && !nc.afterFlag && nc.inLaps <= RAIN_WARN_LAPS);
  if (rainDue) {
    if (wx.playerOnSlicks) out.rainInLaps = nc.inLaps;
    // Judged on the rounded figure the message shows, so "~3 laps" is always imminent.
    const imminent = Math.round(nc.inLaps) <= RAIN_IMMINENT_LAPS;
    if (wx.playerOnSlicks && imminent) out.rainSoonLaps = nc.inLaps;
    upsert('rain-coming', {
      severity: imminent ? SEVERITY.ADVISORY : SEVERITY.INFO,
      category: CATEGORY.STRATEGY,
      // To the nearest 10%: the game nudges it every few seconds.
      message: `Rain within ${lapsAway(nc.inLaps)} (${WEATHER_NAME[nc.weather]}, ${Math.round(nc.rainPct / 10) * 10}%)${wx.playerOnSlicks ? ' - plan the inters stop' : ''}`,
      expiresAtMs: clock() + 5000,
    });
  } else {
    expire('rain-coming');
  }
  if (nc && nc.to === 'dry' && !nc.afterFlag) {
    upsert('rain-stopping', {
      severity: SEVERITY.INFO,
      category: CATEGORY.STRATEGY,
      message: `Rain stops within ${lapsAway(nc.inLaps)} - then the track starts drying`,
      expiresAtMs: clock() + 5000,
    });
  } else {
    expire('rain-stopping');
  }
  let weatherBox = null;
  const cx = wx && wx.crossover;
  // Lap times can mislead (a fast car on the wrong tyre), the sky can't: no
  // inters on a dry track with no rain due, no slicks while it's raining.
  if (playerOnTrack && cx && cx.wetGainMs != null) {
    if (wx.playerOnSlicks && (wx.nowWet || rainDue) && cx.wetGainMs >= CROSSOVER_MS) {
      weatherBox = `Inters ${(cx.wetGainMs / 1000).toFixed(1)}s/lap faster - box for inters`;
    } else if (wx.playerOnWets && !wx.nowWet && -cx.wetGainMs >= CROSSOVER_MS) {
      weatherBox = `Slicks ${(-cx.wetGainMs / 1000).toFixed(1)}s/lap faster - box for slicks`;
    }
  }
  if (weatherBox) {
    const n = cx.basis === 'switchers' ? cx.switchers : wx.playerOnSlicks ? cx.wetCars : cx.slickCars;
    upsert('crossover', {
      severity: SEVERITY.ADVISORY,
      category: CATEGORY.STRATEGY,
      message: `${weatherBox} (${n} car${n === 1 ? '' : 's'} ${cx.basis === 'switchers' ? `that switched, before vs after` : 'on them'})`,
      expiresAtMs: clock() + 5000,
    });
  } else {
    expire('crossover');
  }
  // Before anyone is on inters there are no lap times to compare: box on the
  // forecast once the rain is under a lap away, or a few laps out when a
  // safety car makes the stop cheap enough to pay for the dry laps on inters.
  const rs = analysis && analysis.rainStop;
  if (!weatherBox && playerOnTrack && rainDue && wx.playerOnSlicks) {
    const n = Math.max(1, Math.round(nc.inLaps));
    if (n <= 1) weatherBox = `Rain within ~${laps(1)} - box for inters`;
    else if (neutralised && !redFlag && rs && rs.gainS > 0) weatherBox = `${neutralised}, rain within ~${laps(n)} - box for inters, ~${Math.max(1, Math.round(rs.gainS))}s better than stopping later`;
  }
  out.weatherBox = weatherBox;
}

module.exports = { weather };
