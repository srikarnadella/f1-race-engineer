const test = require('node:test');
const assert = require('node:assert');
const { raceRow } = require('../scripts/build-dataset');

// races.csv (scripts/build-dataset.js): one row per recorded race.
const rows = [{ carIndex: 0, track: 'Spa', lapNum: 1, numPitStops: 0, neutralised: false, isPlayer: true }, { carIndex: 0, track: 'Spa', lapNum: 2, numPitStops: 1, neutralised: false, isPlayer: true }];
const race = (extra) => ({ raceId: 'c#1', capture: 'c', session: { sessionType: 15, totalLaps: 2 }, rows, lapsRun: 2, feed: [], firstT: 0, lastT: 32 * 60000, ...extra });

test('races.csv: durationMin is the racing time, ending at the chequered flag, not the results screen after it (roadmap G4)', () => {
  assert.strictEqual(raceRow(race({ flagT: 30 * 60000 })).durationMin, 30);
});

test('races.csv: a race recorded without its flag (stopped early) runs to the last packet', () => {
  assert.strictEqual(raceRow(race({})).durationMin, 32);
});
