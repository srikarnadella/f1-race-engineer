# Datasets

Built from recorded F1 26 races by `npm run dataset`, which replays each capture in `captures/`
through the real pipeline. The raw captures (65-330 MB each) stay local; these files are small
enough to commit, so CI can score the models on real races (`test/backtest.test.js`).

No driver names, no IP addresses, no paths: the player's name could be a gamertag. Cars are
identified by their slot (`carIndex`) and `isPlayer`.

## races.csv - one row per race session

| Column | |
|---|---|
| raceId | `<capture folder>#<n>`, the n-th race in that capture |
| track, sessionType, totalLaps | from the Session packet (15 = race) |
| lapsRun | laps the player completed (fewer than totalLaps: the race was ended early) |
| cars, laps | cars with a completed lap; rows in laps.csv |
| stops | pit stops made, all cars, any flag |
| neutralisedLaps | laps run under a safety car, VSC or red flag |
| durationMin | wall-clock length of the race session |
| feedRateHz, feedLossPct | telemetry packets per second and % lost on the way (see `src/state/feedHealth.js`) |

## laps.csv - one row per car per completed lap

Laps are recorded as they complete, and taken back when a flashback undoes them; the last lap at the
flag is kept. Values other than `lapMs` are as the car crossed the line. Empty = unknown.

| Column | |
|---|---|
| raceId, track, sessionType, totalLaps | as in races.csv |
| carIndex, isPlayer | the car's slot; 1 for the player |
| lapNum, lapMs | the lap and its time |
| pit | the lap touched the pit lane (in-lap or out-lap) |
| neutralised | any part of the lap under a safety car, VSC or red flag |
| compound, tyreAge | visual compound (16 soft, 17 medium, 18 hard, 7 inter, 8 wet), laps on the set during the lap |
| fuelKg | fuel in the tank |
| position, gapToLeaderMs | running order and gap to the leader |
| numPitStops | stops so far |
| wearMax | the most-worn tyre, % |
| usableLife | the fitted set's rated life in laps (Tyre Sets packet) |

## calls.csv - the strategy calls each race made

One row each time the PUSH/HOLD/BOX/PIT call changed (its action or kind, not its live numbers), on
the player's lap at the time. A flashback takes back the calls made on the laps it undid. Graded
against the laps by `src/analysis/callsAudit.js`; `npm run backtest` prints the audit.

| Column | |
|---|---|
| raceId, lapNum | as in laps.csv |
| action | PUSH, HOLD, BOX or PIT |
| kind | why: `ok`, `undercut`, `rain`, `tyres`, `cliff`, `damage`, `cheap-stop`, `penalty`, `weather`, `window`, `fuel-short`, `fuel-tight`, `neutralised`, `red-flag`, `too-late`, `pit` |

## scores.json

The line CI holds: each model's error on these laps (lower is better), and the size of the dataset
it was scored on. `npm run backtest` prints the scores; after an intended change,
`npm run backtest -- --update` saves new ones. Rebuild after recording races:
`npm run dataset && npm run backtest -- --update`.
