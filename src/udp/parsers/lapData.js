const BufferReader = require('../bufferReader');
const { HEADER_LENGTH } = require('./header');

// 2 trailing bytes after the car array: timeTrialPBCarIdx, timeTrialRivalCarIdx.
const TRAILING_BYTES = 2;
// Rough struct size (F1 23-25 spec) used only to guess numCars when no hint
// is supplied. Real stride is derived from packet length / numCars.
const APPROX_CAR_STRUCT_SIZE = 50;

// A gap is minutes + ms, the ms part under 60000. A tiny negative gap (a car
// passed on the line) arrives wrapped, e.g. 65515: cars level, not 65.5 s apart.
const gapMs = (min, ms) => (ms >= 60000 ? 0 : min * 60000 + ms);

function readCar(r, carStructSize) {
  const start = r.offset;
  const lastLapTimeInMS = r.u32();
  const currentLapTimeInMS = r.u32();
  const sector1TimeMSPart = r.u16();
  const sector1TimeMinutesPart = r.u8();
  const sector2TimeMSPart = r.u16();
  const sector2TimeMinutesPart = r.u8();
  const deltaToCarInFrontMSPart = r.u16();
  const deltaToCarInFrontMinutesPart = r.u8();
  const deltaToRaceLeaderMSPart = r.u16();
  const deltaToRaceLeaderMinutesPart = r.u8();
  const lapDistance = r.f32();
  const totalDistance = r.f32();
  const safetyCarDelta = r.f32();
  const carPosition = r.u8();
  const currentLapNum = r.u8();
  const pitStatus = r.u8();
  const numPitStops = r.u8();
  const sector = r.u8();
  const currentLapInvalid = r.u8();
  const penalties = r.u8();
  const totalWarnings = r.u8();
  const cornerCuttingWarnings = r.u8();
  const numUnservedDriveThroughPens = r.u8();
  const numUnservedStopGoPens = r.u8();
  const gridPosition = r.u8();
  const driverStatus = r.u8();
  const resultStatus = r.u8();
  const pitLaneTimerActive = r.u8();
  const pitLaneTimeInLaneInMS = r.u16();
  const pitStopTimerInMS = r.u16();
  const pitStopShouldServePen = r.u8();

  const consumed = r.offset - start;
  if (carStructSize > consumed) r.skip(carStructSize - consumed);

  return {
    lastLapTimeInMS,
    currentLapTimeInMS,
    sector1TimeInMS: sector1TimeMinutesPart * 60000 + sector1TimeMSPart,
    sector2TimeInMS: sector2TimeMinutesPart * 60000 + sector2TimeMSPart,
    deltaToCarInFrontInMS: gapMs(deltaToCarInFrontMinutesPart, deltaToCarInFrontMSPart),
    deltaToRaceLeaderInMS: gapMs(deltaToRaceLeaderMinutesPart, deltaToRaceLeaderMSPart),
    lapDistance,
    totalDistance,
    safetyCarDelta,
    carPosition,
    currentLapNum,
    pitStatus,
    numPitStops,
    sector,
    currentLapInvalid,
    penalties,
    totalWarnings,
    cornerCuttingWarnings,
    numUnservedDriveThroughPens,
    numUnservedStopGoPens,
    gridPosition,
    driverStatus,
    resultStatus,
    pitLaneTimerActive,
    pitLaneTimeInLaneInMS,
    pitStopTimerInMS,
    pitStopShouldServePen,
  };
}

function parseLapData(buf, numCarsHint) {
  const carsBytes = buf.length - HEADER_LENGTH - TRAILING_BYTES;
  const numCars = numCarsHint || Math.round(carsBytes / APPROX_CAR_STRUCT_SIZE);
  // Floored so a size mismatch degrades to a warning + misread fields
  // rather than fractional offsets that throw on every read.
  const carStructSize = Math.floor(carsBytes / numCars);
  if (carsBytes % numCars !== 0) {
    console.warn(`[lapData] packet size mismatch: ${buf.length} bytes for ${numCars} cars`);
  }

  const r = new BufferReader(buf, HEADER_LENGTH);
  const cars = r.array(numCars, () => readCar(r, carStructSize));
  const timeTrialPBCarIdx = r.remaining >= 1 ? r.u8() : null;
  const timeTrialRivalCarIdx = r.remaining >= 1 ? r.u8() : null;

  return { cars, timeTrialPBCarIdx, timeTrialRivalCarIdx };
}

module.exports = { parseLapData };
