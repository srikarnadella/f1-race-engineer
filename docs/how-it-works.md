# How the race engineer thinks

One radio call, traced from the game's UDP packets to the words on the screen, and the design
choices along the way. File paths are clickable on GitHub.

> **"DEFEND vs SAINZ – threat medium – watch into corner 2"**

## 1. Bytes in: one parser per packet

F1 26 sends up to 60 UDP datagrams a second per packet type to port 20777. Each starts with the
same 29-byte header (`src/udp/parsers/header.js`); byte 6 is the packet id.
[`parsePacket()`](../src/udp/parsePacket.js) reads the header and hands the rest to one parser per
id: Lap Data (positions, gaps, lap distance for **all** cars), Car Status (tyres, fuel, the ERS store),
Motion Ex (your wheel slip), Car Telemetry 2 (the 2026 active aero and Overtake mode), Session
History, Lap Positions, Final Classification and more.

Every parser takes its per-car stride from the packet length rather than a hard-coded size. F1 26
grew several structs (Car Status gained a float *in the middle*), so a layout change degrades to one
console warning for that packet instead of garbage or a crash. Real F1 26 packets live in
[`test/fixtures/f1-26-packets.json`](../test/fixtures/f1-26-packets.json) and pin those layouts in tests.

The same `parsePacket()` is fed by the live UDP socket and by the `.f1log` replayer, which is why
the demo can't drift from the real tool: it *is* the real tool.

## 2. State: the whole field, not just your car

[`FieldModel`](../src/state/fieldModel.js) keeps every car: its latest packets, a lap history
(flagged pit / safety-car laps), gap samples on **game time** (so the closing rate means the same at
20 Hz or 60 Hz, and pauses don't skew it), the battery at each crossing of the line, and the battery in
20 slices of the last lap. Flashbacks (game time going backwards, or the lap counter dropping) undo
history instead of recording fake laps; one real Monaco race had 20 of them.

Offline the game sends every car's speed, throttle, brake and tyre wear, not just yours, so each rival's
best lap is traced for lap compare and each car's own wear rate times its next stop. What a race
measured at a track (pit loss, the tyre age and wear the AI boxed at, each compound's wear rate in
practice) is kept in [`trackMemory.js`](../src/state/trackMemory.js), so the next race there starts
from it.

## 3. Judgement: rules, two small models, and honesty about both

Ten times a second, [`raceAnalysis.compute()`](../src/engine/raceAnalysis.js) works out the fight
either side:

| Question | How | Where |
|---|---|---|
| Is Sainz closing? | Gap trend per lap from clean-lap pace | `raceAnalysis.js` |
| Will he pass in 10 s? | Gradient-boosted trees (LightGBM), trained in Python on recorded races, run from exported JSON | [`ml/`](../ml/), [`src/ml/gbdt.js`](../src/ml/gbdt.js) |
| Where will he try? | Your braking zones, scored by where passes actually happen here | [`attackForecast.js`](../src/analysis/attackForecast.js) |
| Who has the battery? | Last lap's battery profile, projected to the line | [`batteryProjection.js`](../src/analysis/batteryProjection.js) |

[`battleCall()`](../src/analysis/battleCall.js) turns those into ATTACK / DEFEND / CLOSE IN / CLEAR,
and the [`InsightEngine`](../src/engine/insightEngine.js) turns *changes* into radio calls: each has an
id, a severity and an expiry, is settled for a few seconds before it's said (so a gap hovering at 1.0 s
doesn't flap the call), and is only spoken again if it escalates. The headline PUSH / HOLD / BOX call
comes from [`calls.js`](../src/engine/calls.js), pure functions of the same numbers, and carries a `kind`
(why it was made). Advice-level calls have to hold 5 s before they replace each other; BOX, PIT and a
safety car come at once. After the race, [`callsAudit.js`](../src/analysis/callsAudit.js) grades each
call against the laps that followed.

Every prediction is scored against a naive baseline on real races by `npm run accuracy`
([results](accuracy.md)). That harness earned its place:

- **The rejoin model was 8 places off in a pit cycle.** The game reports a gap to the leader of 0
  while a car is in the pit lane, so every car mid-stop counted as leading the race. Fixed by taking
  the time of the car ahead in the running order; red flags (every gap 0) now return no prediction
  rather than a wrong one.
- **The first battery projection was worse than doing nothing.** Extrapolating this lap's use by
  distance scored 12.3 points of error against 9.9 for "it stays where it is", because drivers spend
  on straights, not evenly. Replaying the same stretch of the last lap brought it to 7.4.
- **Tyre temperatures had to be compared like for like.** A plain 10-second average against the
  stint's early laps made 17 overheating calls in one Monaco race, flipping between fronts and rears:
  the surface is hotter after every slow corner and cooler on every straight. Comparing the same
  stretches of track on earlier laps brought it to 3.
- **The first overtake model only tied the gap.** A logistic regression on 4 races scored 0.851 against
  0.854 for the gap alone. Gradient-boosted trees (LightGBM) on 10 races beat it: 0.860 vs 0.838, better on
  9 of 10 races held out ([report](ml-overtake-lightgbm.md)), and that's the model the app runs now. The
  attack forecast still ties the track's busiest passing corner, so it's worded as a "likely spot"; the
  Models tab prints each model's verdict and calibration.

## 4. Out: one snapshot, ten times a second

[`buildSnapshot()`](../src/server/snapshot.js) flattens all of it into one JSON object, the entire
contract with the browser, and [`httpServer.js`](../src/server/httpServer.js) pushes it over a
WebSocket at a fixed 10 Hz whatever the game's rate, which caps CPU on the PC and battery on the device showing it.
The snapshot also carries `focus`, from [`focus.js`](../src/engine/focus.js): which screen matters
right now (Battle, because of the DEFEND call), with hold times so it doesn't flap.

## 5. The dashboard formats, it never decides

[`public/`](../public/) is plain HTML, CSS and JS with no build step. Widgets only turn the snapshot
into text and colour. The Battle card shows "DEFEND vs SAINZ", the gap, "Threat MED · 14%",
"Battery 28% → ~18% at line · you ~56%", and "Their likely spot: corner 2". If auto-switch is on, the
app moves to the Battle screen and says why on the rail. The voice reads the call once, through the
browser's own speech synthesis, with "P8" said as "P 8" and "0.5s" as "0.5 seconds".

## Cost

Per packet: a parse and a state update, well under a millisecond. Per tick (10 Hz): one analysis
pass over 22 to 24 cars and one JSON message. Per lap: a degradation fit. Per session: one gzipped
file in `data/sessions/`. No database, no build, one runtime dependency for WebSockets and one for QR codes.
