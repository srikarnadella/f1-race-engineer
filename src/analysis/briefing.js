// The pre-race briefing: what your own earlier sessions at this track say (the race store) and what the track memory
// learned from them (pit loss, tyre wear). Nothing here is a prediction; it is what happened here before.
const { median } = require('../lib/stats');

const LONG_RACE_LAPS = 10; // a sprint-length race says nothing about how many stops a race takes
const SOFT_MEDIUM_HARD = [16, 17, 18];

// sessions: the store's trackHistory rows; memory: { pitLossMs: [], deg16: [], deg17: [], deg18: [] } (ms and ms per lap).
function briefing({ sessions, memory }) {
  const races = sessions.filter((x) => x.isRace);
  const laps = sessions.map((x) => x.bestLapMs).filter((v) => v > 0);
  const finishes = races.map((x) => x.finish).filter((v) => v > 0);
  const long = races.filter((x) => x.totalLaps >= LONG_RACE_LAPS && x.stops != null);
  const last = races.length ? races.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a)) : null;
  const pit = (memory && memory.pitLossMs) || [];
  return {
    sessions: sessions.length,
    races: races.length,
    bestLapMs: laps.length ? Math.min(...laps) : null,
    bestFinish: finishes.length ? Math.min(...finishes) : null,
    last: last ? { name: last.name, startedAt: last.startedAt, grid: last.grid, finish: last.finish } : null,
    stops: long.length ? median(long.map((x) => x.stops)) : null,
    pitLossS: pit.length ? Math.round(median(pit) / 1000) : null,
    wear: SOFT_MEDIUM_HARD.filter((c) => memory && memory[`deg${c}`] && memory[`deg${c}`].length).map((c) => ({ compound: c, msPerLap: median(memory[`deg${c}`]) })),
  };
}

module.exports = { briefing };
