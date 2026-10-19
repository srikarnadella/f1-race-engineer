const test = require('node:test');
const assert = require('node:assert');
const PACKET_IDS = require('../src/udp/packetIds');
const enc = require('../src/sim/encoders');
const { parsePacket } = require('../src/udp/parsePacket');
const { createFieldModel } = require('../src/state/fieldModel');
const { createInsightEngine } = require('../src/engine/insightEngine');
const { createRaceAnalysis } = require('../src/engine/raceAnalysis');

const PLAYER = 2;
const header = (sessionTime) => ({ sessionUID: 1n, sessionTime, playerCarIndex: PLAYER });
const slot = (timeOffsetMin, weather, rainPercentage, sessionType = 15) => ({ sessionType, timeOffsetMin, weather, rainPercentage, trackTemperature: 30, airTemperature: 22 });

// Five cars, 90s laps, each with one completed clean lap on the books.
function race(fm, { weather = 1, forecast = [], compounds = [17, 17, 17, 17, 17], lapMs = [], totalLaps = 30, safetyCarStatus = 0 } = {}) {
  fm.dispatch(PACKET_IDS.SESSION, header(1), { sessionType: 15, totalLaps, trackLength: 5000, trackId: 17, weather, forecast, forecastAccuracy: 0, safetyCarStatus });
  fm.dispatch(PACKET_IDS.CAR_STATUS, header(1), {
    cars: compounds.map((visualTyreCompound) => ({ visualTyreCompound, tyresAgeLaps: 5, fuelRemainingLaps: 40 })),
  });
  const cars = (lapNum) => Array.from({ length: 5 }, (_, i) => ({
    carPosition: i + 1, currentLapNum: lapNum, lastLapTimeInMS: lapMs[i] || 90000,
    deltaToCarInFrontInMS: i === 0 ? 0 : 1000, pitStatus: 0, lapDistance: 100,
  }));
  fm.dispatch(PACKET_IDS.LAP_DATA, header(2), { cars: cars(10) });
  fm.dispatch(PACKET_IDS.LAP_DATA, header(3), { cars: cars(11) });
}

test('session: the weather forecast is read after the marshal zones', () => {
  const forecast = [slot(0, 1, 5), slot(5, 2, 30), slot(10, 3, 70), slot(0, 4, 90, 8)];
  const { data } = parsePacket(enc.encodeSession(header(1), { weather: 1, safetyCarStatus: 0, forecast, forecastAccuracy: 1 }));
  assert.strictEqual(data.forecast.length, 4);
  assert.deepStrictEqual(data.forecast[2], { sessionType: 15, timeOffsetMin: 10, weather: 3, trackTemperature: 30, trackTemperatureChange: 2, airTemperature: 22, airTemperatureChange: 2, rainPercentage: 70 });
  assert.strictEqual(data.forecastAccuracy, 1);
});

test('rain arrival is turned into laps, using only this session\'s slots', () => {
  const fm = createFieldModel();
  // 90s laps: rain in the 10-minute slot is ~6.7 laps away. The 5-minute
  // "storm" belongs to a different session (qualifying, type 8) and is ignored.
  race(fm, { forecast: [slot(0, 1, 5), slot(5, 5, 100, 8), slot(5, 2, 30), slot(10, 3, 70)] });
  const wx = createRaceAnalysis(fm).compute().weather;
  assert.strictEqual(wx.trackState, 'rain-coming');
  assert.strictEqual(wx.nextChange.to, 'rain');
  assert.strictEqual(wx.nextChange.inMin, 10);
  assert.ok(Math.abs(wx.nextChange.inLaps - 6.67) < 0.01, wx.nextChange.inLaps);
  assert.strictEqual(wx.timeline.length, 3);
});

test('rain forecast after the chequered flag is not "rain coming"', () => {
  const fm = createFieldModel();
  race(fm, { forecast: [slot(0, 1, 5), slot(60, 3, 80)] }); // ~20 laps left, rain in 40 laps
  const ra = createRaceAnalysis(fm);
  const wx = ra.compute().weather;
  assert.strictEqual(wx.nextChange.afterFlag, true);
  assert.strictEqual(wx.trackState, 'dry');
  assert.ok(!createInsightEngine(fm).evaluate(ra.compute()).some((i) => i.id === 'rain-coming'));
});

test('radio: rain warning in laps, then a box-for-inters call once inters are faster', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  const ra = createRaceAnalysis(fm);
  race(fm, { forecast: [slot(0, 2, 40), slot(5, 3, 80)] });
  const rain = ie.evaluate(ra.compute()).find((i) => i.id === 'rain-coming');
  assert.match(rain.message, /Rain within ~3 laps \(light rain, 80%\) - plan the inters stop/);
  assert.strictEqual(rain.severity, 'advisory');

  // Now raining; P1 and P2 already on inters and 4s a lap quicker.
  const fm2 = createFieldModel();
  const ie2 = createInsightEngine(fm2);
  const ra2 = createRaceAnalysis(fm2);
  race(fm2, { weather: 3, compounds: [7, 7, 17, 17, 17], lapMs: [96000, 96500, 100000, 100500, 101000] });
  const call = ie2.evaluate(ra2.compute()).find((i) => i.id === 'crossover');
  assert.match(call.message, /Inters 4\.3s\/lap faster - box for inters \(2 cars on them\)/);
  assert.strictEqual(ie2.getStrategy().call.action, 'BOX');
});

test('track clearing: rain stopping, then "drying" until the slicks come back', () => {
  // Raining, forecast dry from the 10-minute slot.
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  const ra = createRaceAnalysis(fm);
  race(fm, { weather: 3, compounds: [7, 7, 7, 7, 7], forecast: [slot(0, 3, 60), slot(5, 3, 50), slot(10, 2, 20)] });
  const stop = ie.evaluate(ra.compute()).find((i) => i.id === 'rain-stopping');
  assert.match(stop.message, /Rain stops within ~7 laps/);

  // Rain has stopped but the player is still on inters, one car on slicks is 2s quicker.
  fm.dispatch(PACKET_IDS.SESSION, header(4), { sessionType: 15, totalLaps: 30, trackLength: 5000, weather: 2, forecast: [slot(0, 2, 10)] });
  fm.dispatch(PACKET_IDS.CAR_STATUS, header(4), {
    cars: [17, 7, 7, 7, 7].map((visualTyreCompound) => ({ visualTyreCompound, tyresAgeLaps: 5, fuelRemainingLaps: 40 })),
  });
  const lapCars = (lapNum) => Array.from({ length: 5 }, (_, i) => ({
    carPosition: i + 1, currentLapNum: lapNum, lastLapTimeInMS: i === 0 ? 92000 : 94000,
    deltaToCarInFrontInMS: i === 0 ? 0 : 1000, pitStatus: 0, lapDistance: 100,
  }));
  fm.dispatch(PACKET_IDS.LAP_DATA, header(5), { cars: lapCars(12) });
  const analysis = ra.compute();
  assert.strictEqual(analysis.weather.trackState, 'drying');
  const call = ie.evaluate(analysis).find((i) => i.id === 'crossover');
  assert.match(call.message, /Slicks 2\.0s\/lap faster - box for slicks/);
});

test('tyres at the cliff with rain imminent: box, but think inters', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  const ra = createRaceAnalysis(fm);
  race(fm, { forecast: [slot(0, 2, 40), slot(5, 3, 80)] });
  // Worn tyres, wearing 10%/lap: past the cliff threshold within a lap.
  for (const [t, lapNum, wear] of [[4, 11, 70], [5, 12, 80]]) {
    fm.dispatch(PACKET_IDS.CAR_DAMAGE, header(t), { cars: Array.from({ length: 5 }, () => ({ tyresWear: [wear, wear, wear, wear] })) });
    fm.dispatch(PACKET_IDS.LAP_DATA, header(t), { cars: Array.from({ length: 5 }, (_, i) => ({ carPosition: i + 1, currentLapNum: lapNum, lastLapTimeInMS: 90000, deltaToCarInFrontInMS: i ? 3000 : 0, pitStatus: 0, lapDistance: 100 })) });
    ie.evaluate(ra.compute());
  }
  assert.match(ie.getStrategy().call.reason, /Tyres at the cliff - rain within ~\d laps?, think inters/);
});

const { crossoverPace, switchGainMs } = require('../src/engine/weather');

test('crossover: a car that just switched is compared with itself, before and after', () => {
  const lap = (lapNum, lapMs, compound, pit = false) => ({ lapNum, lapMs, compound, pit, neutralised: false });
  // Slicks at 100s, in/out laps, then inters at 96s: inters 4s a lap quicker.
  const switcher = (old, neu) => ({
    lapData: { currentLapNum: 14, pitStatus: 0 },
    status: { visualTyreCompound: 7, tyresAgeLaps: 2 },
    lapHistory: [lap(10, 100000, 17), lap(11, old, 17), lap(12, 120000, 17, true), lap(13, neu, 7)],
  });
  assert.strictEqual(switchGainMs(switcher(100000, 96000)), 4000);
  // A switch long ago says nothing about the track now.
  assert.strictEqual(switchGainMs({ ...switcher(100000, 96000), lapData: { currentLapNum: 20 } }), null);
  // A fast car on slicks makes the group medians say slicks; two switchers say inters.
  const fastOnSlicks = { lapData: { currentLapNum: 14, pitStatus: 0 }, status: { visualTyreCompound: 17, tyresAgeLaps: 8 }, lapHistory: [lap(13, 92000, 17)] };
  const cx = crossoverPace([switcher(100000, 96000), switcher(101000, 98000), fastOnSlicks]);
  assert.strictEqual(cx.basis, 'switchers');
  assert.strictEqual(cx.switchers, 2);
  assert.strictEqual(cx.wetGainMs, 3500);
});

// Austria, 19 Oct 2026: rain arrived on lap 21 and the whole field went to
// inters. Their last slick lap was set on a dry track (~70s), their inters
// laps in the rain (~78s) - the rain slowed them, not the tyre. Comparing the
// two said "slicks 8s a lap faster" until the flag, while cars still on slicks
// in the rain were lapping at 82-90s.
const lap = (lapNum, lapMs, compound, pit = false) => ({ lapNum, lapMs, compound, pit, neutralised: false });
const austriaSwitcher = (dry, wet) => ({
  lapData: { currentLapNum: 24, pitStatus: 0 },
  status: { visualTyreCompound: 7, tyresAgeLaps: 2 },
  lapHistory: [lap(20, dry, 17), lap(21, 82500, 17, true), lap(22, 94000, 7, true), lap(23, wet, 7)],
});

test('crossover: a switch to inters that got slower is the rain, not a case for slicks', () => {
  assert.strictEqual(switchGainMs(austriaSwitcher(70200, 77600)), null);
  // The same for a switch back to slicks that got slower: the track got wetter.
  const backToSlicks = { lapData: { currentLapNum: 14 }, lapHistory: [lap(11, 90000, 7), lap(12, 110000, 7, true), lap(13, 95000, 17)] };
  assert.strictEqual(switchGainMs(backToSlicks), null);
  // The whole field on inters, nobody left on slicks: no evidence either way.
  const cx = crossoverPace([austriaSwitcher(70200, 77600), austriaSwitcher(70500, 78400), austriaSwitcher(72000, 78700)]);
  assert.strictEqual(cx.wetGainMs, null);
});

test('crossover: no "box for slicks" while it is raining, whatever the lap times say', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  const ra = createRaceAnalysis(fm);
  // Raining; the leader is still on slicks and quicker (a fast car), the player is on inters.
  race(fm, { weather: 3, compounds: [17, 7, 7, 7, 7], lapMs: [76000, 78500, 78000, 78200, 78400] });
  assert.ok(!ie.evaluate(ra.compute()).some((i) => i.id === 'crossover'));
  assert.notStrictEqual(ie.getStrategy().call.action, 'BOX');
});

test('rain countdown: the 5-minute forecast slot counts down instead of standing still', () => {
  const fm = createFieldModel();
  const ra = createRaceAnalysis(fm);
  race(fm, { forecast: [slot(0, 2, 20), slot(5, 2, 20), slot(10, 3, 40)] });
  assert.ok(Math.abs(ra.compute().weather.nextChange.inLaps - 6.67) < 0.05);
  // Four minutes on, the game still lists rain at +10 minutes: it's ~6 minutes away now.
  fm.dispatch(PACKET_IDS.SESSION, header(241), { sessionType: 15, totalLaps: 30, trackLength: 5000, trackId: 17, weather: 2, forecast: [slot(0, 2, 20), slot(5, 2, 20), slot(10, 3, 45)], forecastAccuracy: 0 });
  const wx = ra.compute().weather;
  assert.ok(Math.abs(wx.nextChange.inLaps - 4) < 0.1, wx.nextChange.inLaps);
});

test('rain written off as "after the flag" comes back as the countdown runs', () => {
  // ~6 laps left, rain listed at +10 min (6.7 laps): after the flag, for now.
  const fm = createFieldModel();
  const ra = createRaceAnalysis(fm);
  race(fm, { totalLaps: 16, forecast: [slot(0, 2, 20), slot(5, 2, 20), slot(10, 3, 40)] });
  assert.strictEqual(ra.compute().weather.nextChange.afterFlag, true);
  // Four minutes on the game still lists +10 (Austria: this froze at "~9 laps"
  // then flipped to "after the flag"); it's 4 laps away, inside the race.
  fm.dispatch(PACKET_IDS.SESSION, header(241), { sessionType: 15, totalLaps: 16, trackLength: 5000, trackId: 17, weather: 2, forecast: [slot(0, 2, 20), slot(5, 2, 20), slot(10, 3, 45)], forecastAccuracy: 0 });
  const wx = ra.compute().weather;
  assert.strictEqual(wx.nextChange.afterFlag, false);
  assert.strictEqual(wx.trackState, 'rain-coming');
});

test('rain coming on slicks: box for inters when it is about to arrive, or earlier under a safety car', () => {
  // Safety car out, rain ~3 laps away: the stop is cheap - worth it if the dry
  // laps on inters before the rain don't eat the saving.
  const underSc = (interDeltaMs) => {
    const fm = createFieldModel();
    const ie = createInsightEngine(fm);
    const ra = createRaceAnalysis(fm);
    fm.dispatch(PACKET_IDS.TYRE_SETS, header(1), { carIdx: PLAYER, sets: [
      { visualTyreCompound: 17, fitted: true, available: true, lifeSpan: 20, usableLife: 20, lapDeltaTimeMs: 0, wear: 10 },
      { visualTyreCompound: 7, fitted: false, available: true, lifeSpan: 30, usableLife: 30, lapDeltaTimeMs: interDeltaMs, wear: 0 },
    ] });
    race(fm, { safetyCarStatus: 1, forecast: [slot(0, 2, 40), slot(5, 3, 80)] });
    ie.evaluate(ra.compute());
    return ie.getStrategy().call;
  };
  const cheap = underSc(500);
  assert.strictEqual(cheap.action, 'BOX');
  assert.match(cheap.reason, /^Safety car, rain within ~3 laps - box for inters, ~\d+s better than stopping later$/);
  // Inters 6s a lap slower on the dry track for ~3 laps: not worth it.
  assert.strictEqual(underSc(6000).action, 'HOLD');

  // Green flag, rain ~3 laps away: stay out for now.
  const fm2 = createFieldModel();
  const ie2 = createInsightEngine(fm2);
  const ra2 = createRaceAnalysis(fm2);
  race(fm2, { forecast: [slot(0, 2, 40), slot(5, 3, 80)] });
  ie2.evaluate(ra2.compute());
  assert.strictEqual(ie2.getStrategy().call.action, 'PUSH');
  assert.match(ie2.getStrategy().call.reason, /Rain within ~3 laps - stay out, inters when it arrives/);

  // Four minutes on, under a lap away: box.
  fm2.dispatch(PACKET_IDS.SESSION, header(241), { sessionType: 15, totalLaps: 30, trackLength: 5000, trackId: 17, weather: 2, forecast: [slot(0, 2, 60), slot(5, 3, 85)], forecastAccuracy: 0 });
  ie2.evaluate(ra2.compute());
  assert.strictEqual(ie2.getStrategy().call.action, 'BOX');
  assert.match(ie2.getStrategy().call.reason, /Rain within ~1 lap - box for inters/);
});

test('rain warning: the chance is rounded so the card does not change every few seconds', () => {
  const fm = createFieldModel();
  const ie = createInsightEngine(fm);
  const ra = createRaceAnalysis(fm);
  race(fm, { forecast: [slot(0, 2, 20), slot(5, 2, 20), slot(10, 3, 34)] });
  const rain = ie.evaluate(ra.compute()).find((i) => i.id === 'rain-coming');
  assert.match(rain.message, /\(light rain, 30%\)/);
});
