# Source map

Where everything lives, and where to look when something is wrong. The engine is wired in one
place, [`pipeline.js`](pipeline.js): packets in, one dashboard snapshot out. The live bridge, the
replayer, the capture analyzer, the dataset builder and the tests all run that same pipeline.

## Layers

Each layer only reads from the layers above it in this table. Nothing in `state/` knows about
calls, and nothing in `analysis/` knows about packets.

| # | Folder | Job | Key files |
|---|---|---|---|
| 0 | `lib/` | Small shared helpers: statistics, lap filters, how numbers are said | `stats.js`, `laps.js`, `format.js` |
| 1 | `udp/` | **Ingest.** The UDP socket and one parser per packet id. Bytes in, plain objects out | `listener.js`, `parsePacket.js`, `parsers/*.js`, `gameIds.js` |
| 2 | `state/` | **The field.** Every car, kept up to date packet by packet; flashbacks rewind it. Facts only | `fieldModel.js`, `lapTrace.js`, `lapDelta.js`, `feedHealth.js`, `trackMemory.js` |
| 3 | `analysis/`, `ml/` | **Numbers.** Pure functions: pit timing, the race plan, rival stops, damage cost, tyre wear, overtake odds | `pitTiming.js`, `racePlan.js`, `rivalStops.js`, `damageLoss.js`, `ml/tyreModel.js` |
| 4 | `engine/` | **Decisions.** Runs the analysis every tick and turns it into what the driver hears and sees | `raceAnalysis.js`, `insightEngine.js`, `calls.js`, `adjustments.js`, `focus.js`, `debrief.js` |
| 5 | `server/` | **Out.** One JSON snapshot, pushed over a WebSocket at a fixed 10 Hz | `snapshot.js`, `httpServer.js` |

The dashboard (`public/`) only formats the snapshot. It makes no decisions.

Tools beside the layers:

| Folder | Job |
|---|---|
| `capture/` | Record raw packets (`.f1log.gz`), replay them on their own clock, and validate a capture against the tool's assumptions (`npm run analyze`) |
| `data/` | The committed datasets built from captures (`npm run dataset`) and the model backtests CI holds the line on (`npm run backtest`) |
| `sim/` | A synthetic race written in the game's binary format, for the demo and the scenario tests |

## One tick

1. `udp/parsePacket.js` reads the 29-byte header, picks the parser by packet id, and the parser
   sizes each car's struct from the packet length (F1 26 grew several structs).
2. `state/fieldModel.js` files the result under each car. Time comes only from the injected clock
   (`createPipeline({ now })`), so a replay is identical at any speed.
3. Every 100 ms, `engine/raceAnalysis.js` computes pace, pit loss, rejoin, rival stops, the race
   plan, damage and weather from the field, calling `analysis/` and `ml/`.
4. `engine/insightEngine.js` turns those numbers into radio cards and the headline call
   (`engine/calls.js`: PUSH / HOLD / BOX / PIT / PREP, each with a `kind`).
5. `server/snapshot.js` flattens everything into the one object the dashboard reads.

## Where to look

| Symptom | Start here |
|---|---|
| A packet field reads wrong, or a warning names a packet | `udp/parsers/<packet>.js`; real F1 26 packets are pinned in `test/fixtures/f1-26-packets.json` |
| Laps, gaps or history wrong after a flashback | `state/fieldModel.js` (rewind), `state/lapTrace.js` (mini-sectors) |
| A number on screen is off (pit loss, rejoin, wear, stop lap) | `engine/raceAnalysis.js`, then the `analysis/` function it calls |
| The call or a radio card is wrong, flaps or repeats | `engine/calls.js` (the call), `engine/insightEngine.js` (cards; find the `// --- <topic> ---` section) |
| The screen didn't switch, or switched too often | `engine/focus.js` |
| A widget shows "–" | the field it reads in `server/snapshot.js` (`test/ui.test.js` checks every field a widget reads) |
| Was a call right in hindsight? | `analysis/callsAudit.js`, printed by `npm run backtest` |

To reproduce a problem from a real race: `npm run analyze -- captures/<folder>` replays the capture
through the current code and writes every call it would make, with the time, to `report.md`.
