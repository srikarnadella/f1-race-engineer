# Dashboard UX: decisions and why

The dashboard is read in half-second glances, at arm's length, by someone driving at 300 km/h.
Every choice below follows from that.

## Rules

1. **Nothing the game's HUD or MFD already shows.** Tyre wear %, temperatures, fuel, ERS %, damage,
   the timing tower and the delta are on screen in the game. The dashboard shows what the game can't
   tell you: the call, where the fight is heading, projections, and the ML.
2. **Colour only means something.** Green = good for you, yellow = watch, red = act, blue = info,
   purple = personal best. A number is white unless its colour tells you what to do.
3. **The biggest thing on the screen is the decision.** PUSH / HOLD / BOX, ATTACK / DEFEND, "Rain in
   ~5 laps". Reasons sit next to it in smaller type.
4. **Interrupt rarely.** Only what you can't see from the cockpit (safety car, red flag, tyres at the
   cliff, fuel) takes over the screen. A car in your mirrors doesn't.
5. **Never leave a big card empty.** If its data doesn't exist yet, the card says why, or shows the
   next most useful thing (the Strategy options card shows the cars around you until a safety car).

## Screens

| Screen | For | Layout reasoning |
|---|---|---|
| **Drive** | Leaving up all race | One composite card: the call, the battle either side, the latest radio call, four projections. Under a safety car its middle turns into the strategy options. In practice and qualifying the battle becomes **This lap** (where it would put you, the delta to your best, traffic) and **Standing** (position, gap to P1, through or out at the cut), and the tiles become time left, best lap, the cut and the car. On a phone it gets three rows of height and the call stacks above its reason. |
| **Battle** | A fight either side | The battle card takes two thirds of the screen: gaps big enough to read from the seat, the battle call as a banner, the pass / threat chance, and **projected battery at the line** for both cars against yours. |
| **Strategy** | "Should I box?" | "If you box now" and the call on top; **pit timing** (which lap to box on, or the SC/VSC options) in the big slot; tyre model and weather at the side. |
| **Weather** | Rain on the way | The forecast gets the big slot (bars = rain chance, in laps), with the tyre projection and the box call beside it. |
| **Custom** | Your own layout | Any widget in any slot, 13 layouts, saved on the device. |
| **Debrief** | After the flag | Official result, lap chart, position chart, sectors vs the fastest, lap compare, rivals, models. |

Portrait and landscape both work: wide screens use the layout as designed, narrower ones reflow the
same cards into two or one columns.

## Auto-switch

Off by default (Settings), because a screen that moves on its own is a surprise until you've asked
for it. When on:

- **The bridge decides, the browser obeys.** `src/engine/focus.js` picks the screen from the same
  calls the radio uses, in priority order: session over → Debrief; safety car, VSC, red flag or a
  pit call → Strategy; rain within ~5 laps, a drying track or a tyre crossover → Weather; ATTACK,
  DEFEND or CLOSE IN → Battle; otherwise your screen. Every device agrees, a replay always switches
  the same way, and it's unit-tested.
- **It doesn't flap.** A screen stays at least 8 s, and the trigger has to be gone for 5 s before it
  goes back. A more urgent screen (a box call during a battle) cuts in at once.
- **It goes back to *your* screen,** not always Drive: the screen you last picked is "home".
- **You always win.** Picking a screen yourself pauses auto-switch for 30 s; the rail shows the
  countdown, and tapping it resumes.
- **It says why.** The rail chip reads "AUTO · Battle · DEFEND vs SAINZ", so a switch never feels random.

## Ask the engineer

A question answered out loud beats any layout when your eyes are on the track. **Ask** (or **Q**) opens
a small panel at the bottom, not a modal: the screen stays live behind it. Speak, or tap one of nine
questions; the answer is one sentence, spoken even with the radio voice off (you asked for it), and
the panel closes itself after 15 s. Answers are built from the snapshot already on the device, so
they're instant. It listens only after a tap, never all the time: browsers send speech to their
maker's servers to transcribe it, and an open mic next to game audio and the engineer's own voice
would mishear constantly.

## Pit timing

The answer first ("Box in 3 laps", big, green), then the rows that justify it: this lap, the next two,
and the best. Each row is the decision's consequences in the driver's terms (rejoin position, traffic,
finish position, seconds lost), not the model's inputs. A new best has to hold 5 s before it replaces
the old one, and near-ties keep the last pick, so the headline doesn't flicker as gaps move. Under the
table, the stops it expects from the cars within a pit stop of you, so "stay out" or "box in 3" can be
checked against "RUSSELL due next lap".

## Qualifying

The race layout in qualifying was worse than nothing: a gap to the car "ahead" that's on a different
lap, defend calls for cars on out laps, "PUSH - tyres and fuel OK" in the garage. The call now follows
the run (PREP, PUSH, BOX) and says the one thing that matters on each lap: when the push lap starts and
how much time is spare, where this lap would put you, where you stand at the cut. Traffic is named once
on the radio; the gap that ticks down sits on the This lap panel, not in the radio text, so the card
isn't rewritten ten times a second.

## Damage

The game shows damage in %, which says nothing about whether to stop. The Car tile shows the measured
cost ("+0.8s/lap") and the verdict ("box for a new nose", "not worth a stop"). The radio says it twice
at most: once when the damage appears ("measuring what it costs") and once with the figure.

## Penalties and flags

Radio text that counts down rewrites the card ten times a second and makes it unreadable, so a yellow
ahead is named by the corner it covers, not "in 0.6 km", and a time penalty against the car behind is
in whole seconds. A track-limit warning is said once each, with the corner, and "same corner again" when
it repeats; the game's own "Warning" event for it is dropped because it says less. The yellow you're
already in isn't called: the HUD shows it.

## Tyre temperatures

The HUD shows the temperatures, so the dashboard only says something when they mean something:
hotter than early in this stint on the same stretches of track, or well under your racing temperature
behind a safety car. Each is said once, rounded to 5 °C so it doesn't rewrite itself.

## Options considered and rejected

- **One adaptive screen that rearranges its cards.** Cards moving under your eyes mid-corner are
  worse than a whole-screen switch you can learn. Fixed layouts, switched whole, won.
- **Auto-switch decided in the browser.** Two devices could disagree, and it couldn't be tested
  against recorded races. Moved server-side.
- **Showing the attack forecast as a prediction.** It ties the "busiest passing corner" rule on the
  races recorded so far ([accuracy](accuracy.md)), so it's worded "likely spot".
- **Battery as "now" only.** "He's on 70%" matters less than "he'll be on 40% at the line"; the
  projection beats "stays where it is" on real races, and the arrow only appears once there's a clean
  last lap to base it on.
