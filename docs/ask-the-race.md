# Ask the race

[← Back to the README](../README.md)

Questions about a saved session, answered by a small model running on your own PC through
[Ollama](https://ollama.com/download). It is built so the model can't make up your race: the engine
works out every number, and the model only puts it into words.

## How an answer is made

1. **The session's facts.** Before every question the engine writes a brief of the session from the race
   store (`race.db`): the result, every lap with its time, its gap to your best lap, position and tyre,
   the stops with their tyres, the safety cars, the overtakes, the engineer's calls.
2. **What the question is about, looked up by the engine.** A 1.7B model doesn't reliably pick a tool,
   so the engine does: where time went on a lap (a lap comparison, in sentences), the order on a lap, a
   driver you name, what to do better, lift and coast, brake bias and differential, the battery.
3. **Advice from rules, with its evidence.** Coaching is the engine's: brake later by so many metres,
   carry so many km/h more to the apex, full throttle sooner; bias rearward when the fronts lock into a
   corner on a third of your laps or more; lower the on-throttle diff for wheelspin, raise it for
   understeer; deploy where the longest flat-out runs are. Each line carries the number it rests on.
4. **The answer is checked.** Every lap time, lap number, position and seconds figure in the answer must
   appear in the facts; anything that doesn't is flagged under the answer. If the model refuses, says
   nothing or writes tool syntax instead of an answer, the engine's own finding answers, marked as such.
5. **A chart and the evidence.** The engine draws a chart when the question is about something chartable
   (lap times, positions, the gap to a driver, two laps' speed), and lists what the answer was worked
   out from.

The model only runs when you ask, never while the game is sending telemetry, and leaves the graphics
card's memory as soon as it has answered (a live session starting unloads anything left).

## How well it answers

`npm run llm-eval` asks a model questions about your recorded races whose right answers come from
`race.db` itself, never typed in by hand: the best lap, start and finish, the winner, the position on a
lap, the stop and its tyres, who finished behind you, where time went on a lap, what to do better, lift
and coast, brake bias and differential, the battery, and one the recording can't answer.

| Model | Races | Right | Grounded (nothing invented) | Time a question (GTX 1650, 4 GB) |
|---|---|---|---|---|
| Qwen3 1.7B | Silverstone, Barcelona, Red Bull Ring, Monaco | **45 / 46** | **46 / 46** | 9-11 s |

3 November 2026. The one miss was a battery answer that described the usage without a figure. The other
models on the list (Qwen3 4B, Llama 3.2 3B, Phi-4-mini) haven't been scored yet.

## What it can't do

- The grounding check covers numbers, not words: a small model can still turn "you don't coast there"
  into "you coast there".
- The setup advice is rules of thumb, not an optimiser, and the thresholds are first guesses.
- "Better" means better than your own best lap of that session.
- Sessions saved before 3 November 2026 have no corner-by-corner car data or battery trace unless their
  recordings are re-processed (see [setup](setup.md#the-windows-app)).
