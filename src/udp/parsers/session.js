const BufferReader = require('../bufferReader');
const { HEADER_LENGTH } = require('./header');

// Fields up to the weather forecast are read; the assists and settings after
// it aren't needed. The marshal
// zone array is declared as a fixed MarshalZone[21] in the spec regardless
// of numMarshalZones (unused slots are zero-filled), so it must be skipped
// at its full declared size to land on safetyCarStatus.
const MARSHAL_ZONE_SLOTS = 21;
const MARSHAL_ZONE_SIZE = 5; // float zoneStart + int8 zoneFlag
// Same for the forecast: a fixed WeatherForecastSample[64], of which the
// first numWeatherForecastSamples are filled (spread across every session
// of the weekend - each sample says which session it belongs to).
const FORECAST_SLOTS = 64;
const FORECAST_SAMPLE_SIZE = 8;

function readForecastSample(r) {
  return {
    sessionType: r.u8(),
    timeOffsetMin: r.u8(), // minutes from now
    weather: r.u8(), // 0 clear, 1 light cloud, 2 overcast, 3 light rain, 4 heavy rain, 5 storm
    trackTemperature: r.i8(),
    trackTemperatureChange: r.i8(), // 0 up, 1 down, 2 no change
    airTemperature: r.i8(),
    airTemperatureChange: r.i8(),
    rainPercentage: r.u8(),
  };
}
function parseSession(buf) {
  const r = new BufferReader(buf, HEADER_LENGTH);

  const weather = r.u8();
  const trackTemperature = r.i8();
  const airTemperature = r.i8();
  const totalLaps = r.u8();
  const trackLength = r.u16();
  const sessionType = r.u8();
  const trackId = r.i8();
  const formula = r.u8();
  const sessionTimeLeft = r.u16();
  const sessionDuration = r.u16();
  const pitSpeedLimit = r.u8();
  const gamePaused = r.u8();
  const isSpectating = r.u8();
  const spectatorCarIndex = r.u8();
  const sliProNativeSupport = r.u8();
  const numMarshalZones = r.u8();

  // Each zone: where it starts (fraction of the lap) and its flag
  // (-1 unknown, 0 none, 1 green, 2 blue, 3 yellow) - seen populated on a real F1 26 race.
  const marshalZones = [];
  const zonesAt = r.offset;
  for (let i = 0; i < Math.min(numMarshalZones, MARSHAL_ZONE_SLOTS); i++) marshalZones.push({ zoneStart: r.f32(), zoneFlag: r.i8() });
  r.offset = zonesAt + MARSHAL_ZONE_SLOTS * MARSHAL_ZONE_SIZE;

  const safetyCarStatus = r.remaining >= 1 ? r.u8() : null;
  const networkGame = r.remaining >= 1 ? r.u8() : null;

  // The forecast is what the MFD weather page lists; a short packet (an
  // older or changed format) just yields no forecast rather than garbage.
  let forecast = [];
  let forecastAccuracy = null; // 0 perfect, 1 approximate
  if (r.remaining >= 1 + FORECAST_SLOTS * FORECAST_SAMPLE_SIZE + 1) {
    const count = Math.min(r.u8(), FORECAST_SLOTS);
    for (let i = 0; i < FORECAST_SLOTS; i++) {
      if (i < count) forecast.push(readForecastSample(r));
      else r.skip(FORECAST_SAMPLE_SIZE);
    }
    forecastAccuracy = r.u8();
  }

  return {
    weather,
    trackTemperature,
    airTemperature,
    totalLaps,
    trackLength,
    sessionType,
    trackId,
    formula,
    sessionTimeLeft,
    sessionDuration,
    pitSpeedLimit,
    gamePaused: !!gamePaused,
    isSpectating: !!isSpectating,
    spectatorCarIndex,
    sliProNativeSupport,
    numMarshalZones,
    marshalZones,
    safetyCarStatus,
    networkGame,
    forecast,
    forecastAccuracy,
  };
}

module.exports = { parseSession };
