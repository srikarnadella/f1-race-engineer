# F1 26 Race Engineer

A live race-engineer dashboard for **F1 26**, driven by the game's UDP telemetry and viewed on a
second screen: a tablet by the wheel, a phone, a laptop or a second monitor. Any browser on your network.

It doesn't just mirror numbers. It watches **the whole field** and calls what matters right now:
*box this lap*, *P8 is 0.5s behind — defend*, *Hamilton just pitted — undercut threat*, *fuel margin
down to 0.3 laps*.

**[▶ Try the interactive demo in your browser](https://srikarnadella.github.io/f1-race-engineer/)** - the real dashboard replaying a real F1 26 race at Monaco, no install.

![The Drive screen: the call, the fight either side with projected battery, the radio, four projections](docs/screenshots/drive.png)

| Battle | Strategy (pit timing) | Weather | Debrief |
|---|---|---|---|
| ![Battle](docs/screenshots/battle.png) | ![Strategy](docs/screenshots/strategy.png) | ![Weather](docs/screenshots/weather.png) | ![Debrief](docs/screenshots/debrief.png) |

**Every prediction is scored against what really happened** in recorded races, next to a naive
baseline ([accuracy](docs/accuracy.md)), and the app says so where a model doesn't beat it yet.
How it works, end to end: [docs/how-it-works.md](docs/how-it-works.md). Why the screens look the
way they do: [docs/ux.md](docs/ux.md).

## Try it in 30 seconds (no game needed)

Needs [Node.js](https://nodejs.org) 18.3 or newer.

```bash
git clone https://github.com/srikarnadella/f1-race-engineer.git
cd f1-race-engineer
npm install
npm run demo
```

Open **http://localhost:8080**. The demo replays a recorded session through the *real* pipeline —
the same parsers, field model and insight engine the live tool uses. Keys **1–6** switch screens;
turn on **Settings → Auto-switch screens** to watch it follow the race on its own.

> **About the demo data:** until a real F1 26 capture is committed, `npm run demo` generates a
> *synthetic* session (`src/sim/syntheticSession.js`): a scripted five-lap stint at the Red Bull Ring
> encoded into genuine F1 25-format UDP packets. It is not real game data. It's tuned so every
> insight fires in turn — a tyre cliff, a rival pitting, a car attacking from behind, a VSC, a
> shrinking fuel margin. The dashboard marks it as **Demo replay**.

## Use it with the game

1. **PC:** `npm install`, then `npm start`. It prints the dashboard address for your LAN:
   ```
   [server] dashboard: http://localhost:8080
   [server] on other devices (same Wi-Fi): http://192.168.1.23:8080
   [udp] listening for F1 telemetry on 0.0.0.0:20777
   ```
   and a QR code of that address: scan it with a phone or tablet camera. (It's also in the dashboard under
   **Settings**.)
2. **F1 26:** *Settings → Telemetry Settings* → UDP Telemetry **On**, UDP Port **20777**,
   UDP Send Rate **20Hz** or higher, UDP Format **2025** (or later).
   If the game runs on a console or another PC, set *UDP IP Address* to this PC's LAN IP.
3. **Any device on the same Wi-Fi:** open that address in a browser. *Add to Home Screen* gives a full-screen app.

| Option | Default | |
|---|---|---|
| `--port <n>` | `8080` | Dashboard HTTP/WebSocket port |
| `--udp-port <n>` | `20777` | Telemetry port (match the game setting) |
| `--udp-host <addr>` | `0.0.0.0` | Interface for UDP; `127.0.0.1` if the game is on the same PC and you want it local-only |
| `--demo <file>` | – | Replay a `.f1log` (or `.f1log.gz`) instead of listening live |
| `--speed <n>` | `1` | Replay speed for `--demo` |
| `--record <file>` | – | Also save every raw packet to a `.f1log` (live mode) |
| `--capture` | – | Save a full capture session for validation (see below) |
| `--https-cert <file>` `--https-key <file>` | – | Serve the dashboard over https, so a phone or tablet can use voice questions (below) |

Finished sessions are saved to `data/sessions/` (one small gzipped file each, never uploaded anywhere)
and come back in the Debrief after a restart. What each race measured at a track (pit loss, when the AI
stopped and at what tyre wear, each compound's wear rate from practice) goes to `data/tracks.json`, so the
next race there starts from those numbers instead of estimates.

**Voice on a phone or tablet** needs https: browsers only open the microphone on a secure page. With
[mkcert](https://github.com/FiloSottile/mkcert): `mkcert -install`, then `mkcert 192.168.1.23 localhost`
(your PC's LAN address), install mkcert's root certificate on the tablet (`mkcert -CAROOT` shows where it is),
and start with `npm start -- --https-cert 192.168.1.23+1.pem --https-key 192.168.1.23+1-key.pem`. The QR
code then points at the https address.

### Capture and validate a session

`npm run capture` is `npm start` plus a full record of the session for checking the tool against the real game:

```
captures/2026-10-15_201500/
  packets.f1log.gz   every raw UDP packet (gzipped, survives a crash or Ctrl+C)
  outputs.jsonl      every radio call, PUSH/BOX call, adjustment and weather change, as the dashboard showed it
  markers.jsonl      your marks, with lap, distance, position and speed
  meta.json
```

While driving, tap **MARK** on the dashboard (or press **M**) whenever a call looks wrong or is missing, or you
lock up, spin or understeer. The tag sheet that pops up is optional; one tap already saves the moment.

Afterwards, `npm run analyze` (newest capture) or `npm run analyze -- captures/<folder>` writes `report.md` and
`report.json` into the folder. They contain:

- **Checks:** each packet type's size against the F1 25 layout, parser warnings, whether participant names are
  readable, what `fuelRemainingLaps` means (worked out from the real burn rate), whether forecast offsets count
  from now or from the session start, the ERS store maximum, and whether MFD bias/diff changes show up in the feed.
- **Threshold calibration:** how your real wheel-slip numbers under braking and on corner exit sit against the
  lockup, wheelspin and understeer thresholds.
- **Laps:** times, tyres, wear, fuel, battery, bias, diff, and the balance issues found that lap.
- **Your marks:** each one with the call, radio and adjustments on screen at that moment, plus the last 3s of
  speed, pedals, steering and wheel slip.
- **Timeline:** every call the current code makes when it replays the session, for comparison with `outputs.jsonl`.

Recommended game settings for a capture: UDP send rate **60Hz** (calibration needs it), format **2025** or later.
A full race is a few hundred MB. Replay any capture into the dashboard with
`node src/index.js --demo captures/<folder>/packets.f1log.gz`.

`npm start -- --port 9000` passes options through npm. Record a session of your own with
`npm run record -- demo/my-race.f1log`, then replay it with `node src/index.js --demo demo/my-race.f1log`.

## The dashboard

**One rule: nothing the game's HUD or MFD already shows.** Tyre wear %, temperatures, fuel, ERS %,
damage %, the timing tower and the delta are all on screen in the game already, so the dashboard doesn't
repeat them (what the damage *costs* is new, so that is shown). The bridge still tracks all of that, because the models and calls are built on it. What's
left is what the game *can't* tell you, laid out for a half-second glance, with the **Voice** button
reading the calls out so you don't have to look at all. Switch with the buttons down the left edge (keys
**1–6**):

| | Screen | What it shows |
|---|---|---|
| Live | **Drive** | The one to leave up. The PUSH / HOLD / BOX call and why; the battle call (ATTACK / DEFEND / CLOSE IN); the car ahead and behind: gap, where it's heading, **pass / threat chance (ML)**, **projected battery at the line**, 2026 **Overtake mode**; the engineer's latest radio call; four projections: laps to the tyre cliff, where you'd rejoin if you boxed now, weather in laps, and what damage costs (or the top car-setting tip). **In practice and qualifying** it switches to the lap view: where this lap would put you, your standing against P1 and the knockout line, time left, and traffic on the road |
| Live | **Battle** | The fight either side, big enough to read from the seat: the battle call, gaps and closing rates, pass / threat chance, **each car's battery now and projected at the line against yours**, and top speed on the last green lap against yours |
| Live | **Strategy** | "Should I box?": rejoin position and who you'd come out next to, the call, **pit timing** (which lap to box on; the stay-out / box options side by side under a safety car; on the grid, the **race plan**), the **tyre model**, weather |
| Live | **Weather** | The forecast in laps, big; tyre life, the call and where a stop would put you beside it |
| Live | **Custom** | Your own layout from the same widgets: Battle, Radio, Call, Rejoin, Pit timing, Tyre strategy, Adjust (bias / diff / ERS changes by corner), Weather, Around you, Pace, Lap delta |
| After | **Debrief** | **Summary:** the official result and points, best and theoretical-best lap, your sectors against the fastest in the field, pace, consistency, lap chart, **position chart for the whole field**, every lap, stints. **Lap compare:** any two laps, or your lap against one of the five fastest rivals' best laps, as speed / throttle / brake traces and a running delta, with corner-by-corner reasons ("braked 20 m later, 18 km/h down on exit"). **Rivals:** where you lose time to the fastest car, by mini-sector. **Models:** what the ML has learned, its calibration, and whether it beats the simple baseline |

**Auto-switch (Settings):** the screen follows the race. Battle when you're in a fight, Strategy at a
pit call or under a safety car, Weather when rain is a few laps away, Debrief after the flag, then back
to your own screen. It holds each screen long enough not to flap, the rail says why it switched, and
picking a screen yourself pauses it for 30 s. Off by default.

**Ask the engineer:** tap **Ask** (or press **Q**, or map a wheel button to it) and say "gap behind?",
"when do I box?", "tyres?", "rain?", "fuel?", "battery?" or "what's the call?". The answer is spoken and
shown, built from the live data on the device itself (`public/ask.js`). Turning speech into text is
the browser's job, and most browsers do it on their maker's servers (Chrome sends the clip to Google),
so it only listens after you tap; the tap-a-question buttons send nothing anywhere.

**Hands-free (Settings), for when no button can be reached:** it listens all the time and answers only
what starts with "Engineer": *"Engineer, gap behind?"*. A bare "Engineer" gets "Go ahead" and waits for
the question. It ignores what it hears while the engineer is talking, and restarts itself when the
browser ends a listening session. Off by default, because while it's on the browser streams the
microphone to its speech service. Run it in a browser on the gaming PC (`http://localhost:8080`, with
a headset so it doesn't hear the game): that page counts as secure. A tablet needs the bridge on https
(`--https-cert`, above); on plain `http://` over Wi-Fi it can't open the microphone, so there the same
questions are one-tap buttons.

**Everything you can ask.** Start with "Engineer" in hands-free mode; with the Ask button, just the
question. Any phrasing works as long as it has one of the key words.

| Say | Key words it listens for | It answers with |
|---|---|---|
| "Engineer, how bad is the damage?" | damage, wing, nose, broken, floor | What's damaged, what it costs a lap and to the flag, and whether a new nose is worth a stop |
| "Engineer, any penalties?" | penalty, track limits, warnings, stop-go, drive-through | Penalties to serve, a time penalty and whether the gap behind covers it, and your track-limit warnings |
| "Engineer, gap behind?" | behind, back, mirrors | Who's behind, the gap, and whether they're catching you (in qualifying: a car on a push lap you should let by) |
| "Engineer, gap ahead?" | ahead, in front, gap | Who's ahead, the gap, and whether you're closing (in qualifying: traffic up the road) |
| "Engineer, when do I box?" | box, pit, stop, window, undercut | The best lap to stop, the tyre, rejoin and finish position (the safety-car options under a safety car; on the grid, the race plan) |
| "Engineer, how are my tyres?" | tyres, tires, wear, cliff | Tyre age and compound, laps to the cliff |
| "Engineer, battery?" | battery, ERS, energy, deploy, overtake | Your battery now and at the line, and the cars either side |
| "Engineer, is it going to rain?" | rain, weather, wet, dry, forecast | Rain in how many laps, or when it stops |
| "Engineer, fuel?" | fuel, gas, petrol | Fuel margin to the flag, and how much to save a lap when it's short |
| "Engineer, laps left?" | laps, left, to go, position, where am I, cut, through, pole | Your position and laps to go (in qualifying: position, the gap to the cut or P1, and time left) |
| "Engineer, what's the call?" | call, plan, strategy, what should I do | PUSH / HOLD / BOX and why, plus the battle call |
| "Engineer" | (nothing else) | "Go ahead", then takes your next sentence as the question |

If a question has key words for two of these, the earlier row wins ("gap behind" is about the car
behind, not the car ahead). Anything it doesn't recognise gets "Didn't catch that" and a list of what to try.

**Your own commands (Settings → Your voice commands).** Pick a phrase and tick what it should report;
the engineer reads them all out in one go. For example, *"status"* with gap ahead, gap behind, tyres and
last lap, then say *"Engineer, status"*. You can report any of the questions above, plus last lap (and how
far off your best), best lap, pace against the cars either side, where you'd rejoin if you boxed now,
pit loss, and the top car-setting tip. Your commands are checked before the built-in ones, match as
whole words anywhere in the sentence ("give me a status" works), appear as buttons under **Ask**, and
are saved on that device (set them up on the PC if that's where hands-free runs).

Things it works out for you:

- **Qualifying mode.** Gaps, defending, fuel and pit calls mean nothing when the order is by best lap, so
  in practice and qualifying the call becomes PREP (out lap: "push lap starts in 0:33, 1:49 to spare"),
  PUSH (timed lap: "On for P13, 0.525 up on your best") or BOX (in lap: "P14, 0.080 clear of the cut").
  It knows the knockout line in Q1 and Q2, how many runs fit in the time left from the garage, whether
  you'll reach the line before the flag, and who is in the way: a car on an out lap up the road while
  you're pushing, or a car on a push lap behind you while you're not.
- **What damage costs.** When bodywork is damaged, your mini-sectors (25 slices of the lap) on clean laps
  since the hit are compared with clean laps before it, less what fuel burn and tyre wear alone would
  have changed. That gives the time lost per lap, where on the lap it goes ("most of it at corners 4 and
  9"), the cost to the flag, and whether a new front wing (the only part a stop changes) pays for its
  stop. An early figure comes from the part of the lap already run since the hit. A heavily broken wing
  with no clean lap before it to compare (a lap-1 hit) is a BOX call straight away.
- **Pit timing: which lap to box on.** Every lap from now to the flag is raced out against the field:
  your tyres wearing at the rate learned from the whole field, a fresh set starting as much quicker as
  the game itself estimates, a damaged front wing costing its measured time until a stop changes it,
  rivals on their own pace and wear, **and each rival's own stop** (the pit lane, then fresh tyres from
  there), and every place lost at the rejoin charged as track position you'd have to win back. A rival
  that still owes its stop is expected at a share of its set's rated life: the AI cars at a real Monaco
  race all boxed at 12 laps on sets rated for 19-20, with 36-37% wear on the most-worn tyre. Once two
  green-flag stops have shown the wear the AI boxes at (this race, or an earlier one at the track), each
  car is timed by its own wear rate instead, so a car eating its tyres is due sooner than its age says.
  The card lists the expected stops of the cars within a pit stop of you. It shows this lap,
  the next two and the best one, each with rejoin and finish position and the time it costs against the
  best. A new best has to hold for 5 s before it replaces the old one, and when the best lap is this one
  by a clear margin it becomes a **BOX** call. On a real Monaco race, from three laps out, it picked
  lap 14; the stop was actually made on lap 13. That's a sanity check, not a score: scoring it needs
  races where the same stop was made on different laps.
- **The race plan, on the grid:** one stop or two, which tyres and when ("1 stop: Soft 13 laps, Medium
  14 - box end of lap 13, 2 stops ~14 s slower"), from your own tyre sets (the game's pace estimate for
  each), the pit loss, and each compound's wear rate measured in practice at the track. Pit timing takes
  over once the race has laps on the board.
- **Penalties and track limits:** each track-limit warning is named by corner, and when two come at the
  same corner it says so (at Monaco both came at the same spot). A time penalty is counted into the rejoin
  if it's served at your stop, or set against the gap to the car behind at the flag ("5s penalty at the
  flag - SAINZ 4s behind: not covered, push"). An unserved stop-go or drive-through is a BOX call (not under
  a safety car, when it can't be served).
- **Flags:** a yellow up to 800 m ahead is called by corner before you reach it (the HUD only shows the
  one you're in); a blue flag names the car lapping you.
- **Tyre temperatures, against your own:** the game's inner tyre temperature sat on one value all race
  in three of four recorded races, and the surface swings 50-120 °C round a lap, so there's no absolute
  "too hot" to trust. Instead the last 10 s are compared with the same stretches of track on earlier laps:
  "Rears ~10 °C hotter than early in the stint", or "Tyres ~15 °C under racing temperature - get heat in
  before the restart" behind a safety car.
- **Lap 1:** where the start left you against the grid.
- **If you box now:** your rejoin position, who you'd come out behind or ahead of, and whether that's
  in traffic. It uses the pit loss *measured from rivals' stops this session* (in-lap + out-lap vs their
  clean pace), with a per-track estimate until someone stops.
- **Gap trends:** each car's clean-lap pace (ignoring pit and safety-car laps) turns gaps into
  "closing 0.5s/lap, DRS range in ~2 laps".
- **Radio calls:** tyre cliff, fuel margin (with how much to save a lap: "0.4 laps short - save ~3% a
  lap"), closing/defending, an undercut window on the car ahead
  (close behind it, tyres as old, clean air at the rejoin, and the car ahead due to stop within 3 laps:
  with no stop left to make there is nothing to undercut), a car either side due to box next lap, the
  car behind pitting (undercut threat) or the car ahead pitting (overcut chance) under green, and a cheap
  stop under a safety car / VSC with the reduced pit loss.
- **Weather in laps, not minutes:** the game's forecast slots become "Rain in ~5 laps (75%)" or "Rain
  stops in ~3 laps", shown on the rail on every screen. Slots after the chequered flag are faded out.
  Once rain has stopped the track counts as **drying** until everyone is back on slicks. While it's
  mixed, the dashboard calls the crossover ("Slicks 2.0s/lap faster – box for slicks"). The game sends no
  track-wetness number, so this is read from the field: from cars that just switched, each against its own
  last lap on the old tyre (same car, same driver), or, until two have, the cars on inters against the cars
  on slicks.
- **Live adjustments:** your car's wheel slip (Motion Ex) is watched braking zone by braking zone.
  A lockup or wheelspin on one lap is ignored; the same thing on 2 of the last 3 laps becomes a suggestion:
  - front locking into a corner → brake bias rearward; rears locking → forward (base bias if it's every corner);
  - rear wheelspin on exit → lower on-throttle diff; understeer on the power → higher;
  - ERS: Overtake mode to attack (within 1.2s) or defend (car within 1s), harvest first if the battery is low,
    save it if it's draining faster than the race needs, recharge under SC/VSC, empty it on the last lap.

  Nothing is learned under a safety car or in the pit lane. Corners are braking zones counted from the start
  line, because the game sends no corner map, so they won't always match official turn numbers. Thresholds are
  first guesses until a real F1 26 capture calibrates them.
- **Safety-car aware:** under SC/VSC the call switches from PUSH to HOLD (or BOX for a cheap stop),
  defend/closing calls and DRS countdowns go quiet, and the rejoin prediction uses the reduced pit loss.
- **Interrupts are rare on purpose.** Only things you can't see from the cockpit (a safety car, red flag,
  tyres at the cliff, fuel running short) take over the top of the screen. A car in your mirrors doesn't.
- **2026 rules:** Overtake mode replaces DRS (decoded from the new Car Telemetry 2 packet), ERS mode 3 is
  called Boost, and "Overtake mode available on Norris – use it on the straight" is called on the radio.

## Machine learning

Two models, both trained on real F1 26 data and both written from scratch (no ML library):

- **Overtake probability.** "Will the car behind pass the car ahead in the next 10 s?" A logistic
  regression over the gap (log scale), closing rate, clean-lap pace difference, tyre age and compound,
  battery difference and Overtake-mode availability. It's trained by `npm run train:overtake`, which replays
  every capture through the real pipeline, labels each one-second battle sample from the game's own overtake
  events (flashbacks are rewound out), and scores the model on a race it never saw (leave one race out) against a
  gap-only baseline. Report: [`docs/ml-overtake-model.md`](docs/ml-overtake-model.md). On four races it ranks passes
  with a held-out AUC of 0.851, is well calibrated up to ~50% (so the dashboard caps it there), and **doesn't beat
  the gap-only baseline yet** (0.854), which the Models tab says in so many words. Every new capture is more
  training data. It drives the pass / threat chips and "pass likely" calls.
- **Projected battery.** Where each car's ERS store will be when it reaches the line: the rest of this lap is
  assumed to go like the same stretch of the last one (drivers spend on the same straights every lap). Scored on
  real races: 7.4 points mean error against 9.9 for "it stays where it is"; extrapolating by distance was worse
  than both, which is why it isn't done.
- **Tyre degradation, learned live from the whole field.** Each car's clean laps against its own average,
  fuel-corrected with the measured burn rate, robust to traffic laps, so the estimate firms up in a few laps
  instead of waiting for your own stint. It feeds the cliff projection and pit timing.

- **Attack forecast (experimental): when and where the car behind will come at you**, and your best
  chance on the car ahead. *When* comes from the closing rate ("now" inside a second, otherwise "in ~2
  laps"). *Where* is the corner (one of your braking zones) where passes actually happen: **where you've
  been passed this session** first, then the track's passing spots (this session's passes plus a per-track
  map learned from recorded races), with the chaser's mini-sector gain as a tie-breaker. Flashback-undone
  passes and passes on a stopped car are excluded. Spoken once ("Leclerc is right behind you – defend,
  watch corner 3") and shown on the Drive screen. **Scored honestly** on every capture by `npm run analyze`
  (each real pass on you vs the forecast just before it): on three races, 5 of 20 passes came at the forecast
  corner, against 5 for the track's busiest passing corner and 2.7 for a random one. It beats chance but only ties
  the simpler rule so far, so the dashboard words it as a "likely spot". Passes on straights (no braking zone
  nearby) can't be caught yet.

## Measured accuracy

`npm run accuracy` replays every recorded race and scores the predictions against what then happened,
each next to the obvious guess. From [docs/accuracy.md](docs/accuracy.md):

| Prediction | Model | Naive baseline |
|---|---|---|
| Rejoin position if you box now (green-flag stops, all cars) | 1.33 places off | 4.33 ("you keep your place") |
| Battery at the line, from half a lap out | 7.4 points off | 9.9 ("it stays where it is") |
| Overtake within 10 s (held-out AUC) | 0.851 | 0.854 (gap only) |
| Attack corner | 5 of 20 | 5 of 20 (busiest corner) |

The rejoin sample is small (3 green-flag stops in the races recorded so far). The harness also caught two
real bugs in the rejoin model, written up in [how it works](docs/how-it-works.md#3-judgement-rules-two-small-models-and-honesty-about-both).

## Post-race analysis

- **Lap compare** resamples two laps' traces onto a 5 m grid, pairs braking zones (mutual nearest, so two corners
  140 m apart can't swap), and explains each corner by brake point, apex and exit speed. Losses away from any
  braking zone (contact, traffic, a fast corner) are named too. On a real Suzuka race it found the 1.35 s lost to a
  lap-4 contact after the hairpin, and that the hairpin brake point varied ±11 m from lap to lap.
- **Rivals:** every car is timed through 25 equal slices of the lap from its lap data. Lap 1 and physically impossible
  splits (flashback glitches) are dropped.
- **Your lap against a rival's:** offline, the game sends every car's speed, throttle and brake, not just yours. Each
  rival's best clean lap is traced, and Lap compare can set your lap against the five fastest ("corner 8: braked 25 m
  earlier, 4 km/h slower at the apex" against Antonelli at Suzuka). Online, other cars' telemetry may be withheld;
  that's untested.

## How it works

```mermaid
flowchart LR
    GAME["F1 26 (UDP :20777)"] --> LISTEN["UDP listener"]
    FILE[".f1log replay"] --> PARSE
    LISTEN --> PARSE["parsePacket()<br/>one parser per packet ID"]
    LISTEN -.raw capture.-> REC["Recorder (.f1log)"]
    PARSE --> FIELD["FieldModel<br/>every car on track"]
    FIELD --> INSIGHT["InsightEngine<br/>rules → radio calls + strategy"]
    FIELD --> SNAP["Snapshot"]
    INSIGHT --> SNAP
    SNAP -->|"WebSocket, fixed 10Hz"| DASH["Dashboard (any browser)"]
```

- **A bridge process, not a native app.** iOS restricts raw UDP/multicast listening. A small Node
  process next to the game takes the UDP stream and serves derived state over WebSocket, so any
  device only needs a browser, and a hosted demo is possible.
- **The whole field, not just your car.** Lap Data and Telemetry packets already carry all 22 cars,
  so gaps, closing rates and undercut detection cost nothing extra to parse.
- **One `parsePacket()` for live and replay.** The demo can't drift from the real tool because it
  is the real tool, fed from a file.
- **Fixed 10Hz output.** The game sends up to 60Hz; the dashboard gets 10Hz snapshots whatever the
  input rate, to cap CPU on the PC and battery on the device.
- **Resilient to format drift.** Per-car struct sizes are checked against packet length, so if EA
  adds a field, that packet type logs a warning instead of crashing the bridge.
- **The browser makes no decisions.** `public/app.js` only formats. Gaps, the strategy call and every
  radio message are decided server-side, so there is one source of truth.

## What this project demonstrates

- **Binary protocol parsing:** little-endian packed structs, variable per-season layouts, defensive
  length checks (`src/udp/`).
- **Real-time streaming architecture:** ingest at up to 60Hz, fixed-rate fan-out, staleness
  detection, reconnecting clients.
- **A reactive rules engine:** time-normalised trend detection (closing rate per lap, tyre-wear
  slope, fuel against the race distance left), latched events, de-duplicated insight lifecycles
  (`src/state/`).
- **A data capture and replay pipeline:** record raw packets, replay them with wall-clock-accurate
  timing, and a synthetic session generator that writes the game's binary format (`src/capture/`, `src/sim/`).
- **Measuring instead of claiming:** every prediction is replayed against real races and scored next to
  a naive baseline (`scripts/accuracy.js`, held-out evaluation for the ML); the harness found two bugs in the
  rejoin model, and the app says plainly where a model doesn't beat the simple rule yet.
- **UX under a glanceability constraint:** tiered type scale, colour used only for meaning, numbers
  that scale with screen size, and auto-switching screens that never flap ([docs/ux.md](docs/ux.md)).

## Development

```bash
npm test                 # parsers (incl. real F1 26 packets), state rules, analysis, models (node:test, no deps)
npm run demo:regenerate  # rebuild the synthetic demo session after changing src/sim/
npm run train:overtake   # retrain + re-evaluate the overtake model from captures/
npm run accuracy         # score the predictions on captures/, writes docs/accuracy.md
npm run site             # build the demo website data; npm run site -- --serve to preview it
npm run site -- --race captures/<folder>   # put a real race on the demo site (laps 11-16 live)
node src/index.js --demo captures/<folder>/packets.f1log.gz --speed 8   # replay a real race, 8x
```

Node 18.3+ and two small runtime dependencies (`ws` for the WebSocket, `qrcode-terminal` for the pairing
QR code). No build step.

## Project status

The live tool, voice, debrief and models work end to end and have been run against real F1 26
races (packet format 2026). Verified from captures: the 24-car layouts, the 2026 changes (Car Telemetry 2,
the inserted ERS harvest-limit field, Participants), fuel as the MFD surplus, the 4 MJ battery, MFD bias/diff
changes reaching the feed, forecast slots counted in minutes from now (a race where the rain came: 100% of
299 checks, against 48% for "from the session start"), every car's speed / throttle / brake and tyre wear
offline, flags per car and per marshal zone. Still open:

- More races for the models: the overtake model ties the gap-only baseline, the attack forecast ties the
  busiest-corner rule, and only 3 green-flag stops have scored the rejoin model.
- Scoring pit timing: it needs races where the same stop was made on different laps.
- Damage cost on a full lap: in the races recorded so far every hit was undone by a flashback within a
  few corners, so the measurement is tested on constructed laps only. The extra time a nose change adds
  to a stop (6 s) is a first guess.
- The rival-stop share (60% of rated tyre life) and the 36% stop wear come from one race's three green-flag
  AI stops; more races will tell whether they hold across tracks and compounds (the memory per track
  learns them as you race).
- Online races are untested: human drivers don't stop like the AI, and other cars' telemetry may be withheld.
- Tyre-temperature calls: the 8 °C / 12 °C thresholds are picked from four races' spreads, not from tyre data.
- The race plan looks at one and two stops inside each set's rated life; a full-distance race can need three.
- Wet races: pit timing and undercut calls are dry-only, there's no model of how inters wear, and only
  7 minutes of rain have been recorded.
- An in-game overlay (needs a desktop wrapper; parked in favour of voice).

## License

MIT
