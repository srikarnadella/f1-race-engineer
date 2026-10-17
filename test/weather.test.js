const test = require('node:test');
const assert = require('node:assert');
const PACKET_IDS = require('../src/udp/packetIds');
const enc = require('../src/sim/encoders');
const { parsePacket } = require('../src/udp/parsePacket');
const { createFieldModel } = require('../src/state/fieldModel');
const { createInsightEngine } = require('../src/state/insightEngine');
const { createRaceAnalysis } = require('../src/state/raceAnalysis');

const PLAYER = 2;
const header = (sessionTime) => ({ sessionUID: 1n, sessionTime, playerCarIndex: PLAYER });
const slot = (timeOffsetMin, weather, rainPercentage, sessionType = 15) => ({ sessionType, timeOffsetMin, weather, rainPercentage, trackTemperature: 30, airTemperature: 22 });

// Five cars, 90s laps, each with one completed clean lap on the books.
function race(fm, { weather = 1, forecast = [], compounds = [17, 17, 17, 17, 17], lapMs = [] } = {}) {
  fm.dispatch(PACKET_IDS.SESSION, header(1), { sessionType: 15, totalLaps: 30, trackLength: 5000, trackId: 17, weather, forecast, forecastAccuracy: 0 });
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

const { crossoverPace, switchGainMs } = require('../src/state/weather');

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
