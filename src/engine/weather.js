// Turns the game's weather forecast (a list of time slots, as the MFD shows
// it) into what a driver actually asks: when does the rain arrive, when does
// it stop, how many laps away is that, and - once it's wet or drying - are
// the cars on the other tyre already faster? That last one, the crossover,
// is read from the field's lap times, because the game sends no track
// wetness figure.

const { median } = require('../lib/stats');

const WET_FROM = 3; // weather >= light rain
const WET_COMPOUNDS = new Set([7, 8]); // visual: inter, wet
const SLICK_COMPOUNDS = new Set([16, 17, 18]);
// After the rain stops, the track stays damp for a while; until then (or
// while anyone is still on inters) it's "drying" rather than "dry".
const DRYING_MEMORY_S = 15 * 60;
// Laps on a set before its lap time counts: an out-lap isn't representative.
const CROSSOVER_MIN_TYRE_AGE = 2;
const FALLBACK_LAP_MS = 90000;

const isWet = (weather) => weather >= WET_FROM;

const groupOf = (compound) => (WET_COMPOUNDS.has(compound) ? 'wet' : SLICK_COMPOUNDS.has(compound) ? 'slick' : null);
// A switch older than this says little about the track now.
const SWITCH_FRESH_LAPS = 3;

// A car that just changed between slicks and wets is the cleanest read on
// the crossover: its own last clean lap on the old tyre against its first
// clean lap on the new one - same car, same driver, a couple of laps apart.
// Returned as the wet tyre's gain (ms per lap), or null.
function switchGainMs(car) {
  const h = car.lapHistory;
  const clean = (l) => l && !l.pit && !l.neutralised && groupOf(l.compound);
  for (let k = h.length - 1; k > 0; k--) {
    const after = h[k];
    if (!clean(after)) continue;
    if (car.lapData && after.lapNum < car.lapData.currentLapNum - SWITCH_FRESH_LAPS) return null;
    // The clean lap before this one, past the pit laps between them.
    let j = k - 1;
    while (j >= 0 && !clean(h[j])) j--;
    if (j < 0) return null;
    const before = h[j];
    if (groupOf(before.compound) === groupOf(after.compound)) continue;
    const gain = before.lapMs - after.lapMs; // > 0: the new tyre is quicker
    return groupOf(after.compound) === 'wet' ? gain : -gain;
  }
  return null;
}

// The crossover: from cars that just switched when there are two or more,
// otherwise the median last clean lap of the cars on wet-weather tyres vs
// the cars on slicks (different cars, so a fast car on inters flatters
// them). wetGainMs > 0 = inters/wets are quicker right now.
function crossoverPace(cars) {
  const wet = [];
  const slick = [];
  for (const car of cars) {
    const compound = car.status && car.status.visualTyreCompound;
    const group = WET_COMPOUNDS.has(compound) ? wet : SLICK_COMPOUNDS.has(compound) ? slick : null;
    if (!group || !car.lapData || car.lapData.pitStatus !== 0) continue;
    const last = car.lapHistory[car.lapHistory.length - 1];
    if (!last || last.pit || last.neutralised || car.status.tyresAgeLaps < CROSSOVER_MIN_TYRE_AGE) continue;
    group.push(last.lapMs);
  }
  const both = wet.length && slick.length;
  const switches = cars.map(switchGainMs).filter((g) => g != null);
  const groupGain = both ? Math.round(median(slick) - median(wet)) : null;
  const basis = switches.length >= 2 || (switches.length && groupGain == null) ? 'switchers' : groupGain != null ? 'groups' : null;
  return {
    wetCars: wet.length,
    slickCars: slick.length,
    wetMs: wet.length ? Math.round(median(wet)) : null,
    slickMs: slick.length ? Math.round(median(slick)) : null,
    switchers: switches.length,
    basis,
    wetGainMs: basis === 'switchers' ? Math.round(median(switches)) : groupGain,
  };
}

function createWeatherAnalysis() {
  let lastWetAtS = null;

  function reset() {
    lastWetAtS = null;
  }

  // cars: FieldModel cars in position order. lapsLeft may be null (not a
  // race, or no Session packet yet), in which case nothing is "after the flag".
  function compute({ session, sessionTime, lapMs, lapsLeft, cars, player }) {
    if (!session || session.weather == null) return null;
    // A flashback rewinds game time; a "last wet" stamp from the future
    // would otherwise give a negative age.
    if (lastWetAtS != null && sessionTime < lastWetAtS) lastWetAtS = sessionTime;
    const nowWet = isWet(session.weather);
    if (nowWet) lastWetAtS = sessionTime;
    const minPerLap = (lapMs > 0 ? lapMs : FALLBACK_LAP_MS) / 60000;
    const toLaps = (min) => min / minPerLap;
    const afterFlag = (laps) => lapsLeft != null && laps > lapsLeft;

    // Only this session's slots; the packet also carries the rest of the weekend.
    const samples = (session.forecast || [])
      .filter((s) => s.sessionType === session.sessionType)
      .sort((a, b) => a.timeOffsetMin - b.timeOffsetMin);
    const timeline = samples.map((s) => ({
      offsetMin: s.timeOffsetMin,
      laps: toLaps(s.timeOffsetMin),
      afterFlag: afterFlag(toLaps(s.timeOffsetMin)),
      weather: s.weather,
      rainPct: s.rainPercentage,
      trackTemp: s.trackTemperature,
    }));

    // The first future slot whose wet/dry state differs from now. Slots are
    // 5+ minutes apart, so this is "by then", not an exact moment.
    const flip = timeline.find((t) => t.offsetMin > 0 && isWet(t.weather) !== nowWet);
    const nextChange = flip && {
      to: nowWet ? 'dry' : 'rain',
      inMin: flip.offsetMin,
      inLaps: flip.laps,
      weather: flip.weather,
      rainPct: flip.rainPct,
      afterFlag: flip.afterFlag,
    };

    const crossover = crossoverPace(cars);
    const recentlyWet = lastWetAtS != null && sessionTime - lastWetAtS < DRYING_MEMORY_S;
    let trackState = 'dry';
    if (nowWet) trackState = 'raining';
    else if (recentlyWet || crossover.wetCars > 0) trackState = 'drying';
    else if (nextChange && nextChange.to === 'rain' && !nextChange.afterFlag) trackState = 'rain-coming';

    const myCompound = player && player.status ? player.status.visualTyreCompound : null;
    return {
      now: session.weather,
      nowWet,
      trackState,
      trackTemp: session.trackTemperature,
      airTemp: session.airTemperature,
      accuracy: session.forecastAccuracy === 0 ? 'perfect' : session.forecastAccuracy === 1 ? 'approximate' : null,
      rainStoppedMinAgo: !nowWet && recentlyWet ? Math.round((sessionTime - lastWetAtS) / 60) : null,
      playerOnWets: WET_COMPOUNDS.has(myCompound),
      playerOnSlicks: SLICK_COMPOUNDS.has(myCompound),
      nextChange: nextChange || null,
      timeline,
      crossover,
    };
  }

  return { compute, reset };
}

module.exports = { createWeatherAnalysis, crossoverPace, switchGainMs, isWet };
