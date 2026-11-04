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
   driver you name, what to do better, lift and coast, brake bias and differential, the battery, and the
   insights below.
3. **Advice from rules, with its evidence.** Coaching is the engine's: brake later by so many metres,
   carry so many km/h more to the apex, full throttle sooner; bias rearward when the fronts lock into a
   corner on a third of your laps or more; lower the on-throttle diff for wheelspin, raise it for
   understeer; deploy where the longest flat-out runs are. Each line carries the number it rests on.
4. **The answer is checked.** Every lap time, lap number, position and seconds figure in the answer must
   appear in the facts; anything that doesn't is flagged under the answer. If the model refuses, says
   nothing or writes tool syntax instead of an answer, the engine's own finding answers, marked as such.
5. **A chart and the evidence.** The engine draws a chart when the question is about something chartable
   (lap times, positions, the gap to a driver, two laps' speed, tyre pace by stint), and lists what the answer was
   worked out from.

## What it can answer, beyond the lap list

Each of these is worked out whole by the engine from the recording (`src/llm/insights.js`) and handed to the
model as sentences, so the model words an answer it can't get wrong. Where a figure is an estimate it carries the
range it could be (80%; `public/spread.js`), and the model is told to say "probably between", never to give the
middle as certain.

| Ask | The engine works out |
|---|---|
| "Summarize my race" | The race in points: result and places gained, best lap, each stop against the field's, race pace rank, the costliest lap, how the engineer's calls did, one thing to work on. A point with nothing behind it is left out. |
| "Was my pit stop good?" | Each stop: laps in and out, tyres, what it cost against the cars that didn't stop on those laps, against the other cars' green-flag stops (or that a safety-car stop is cheaper), and your place before and after. |
| "How did my tyres hold up?" | Each stint: clean laps, average and best lap, and whether the pace got slower or quicker over it, with the range. Tyre wear and fuel burn act together, which the answer says. Drawn as a chart with each stint's trend and its range. |
| "Which laps cost me the most time?" / "What were my biggest mistakes?" | How consistent you were, and the laps 0.7 s or more off your typical lap, each with what was recorded on it: a collision, a penalty, who passed you or you passed, an invalid lap, locking or wheelspin and where. A lap with nothing recorded says so and doesn't guess a cause. |
| "Who had the best race pace?" | Every car's typical clean lap ranked, where you ranked and how far off the quickest, and who set the fastest lap. |
| "Were the engineer's calls right?" | The calls audit's verdict: how many were right and wrong, and each graded call with why. |
| "Am I improving here?" | Your races at this track in date order, how this race ranks by best lap and by race pace, and how your typical lap moved. |

**Without the model.** The Charts menu also holds Insights buttons (Race summary, Pit stops, Tyres, Lost time,
Race pace, Calls, History): the engine's own findings put on screen as they are, with the chart that goes with them
for Tyres and Lost time, and no model involved. They are the safest way to read the numbers, since nothing can
misjudge them in the wording. Chart buttons likewise: tyre pace by stint, and time lost to your typical lap, lap by
lap.

**The uncertainty, said every time.** Under every answer a small line says what to trust: from the model, "worded by
a small model, which can misjudge what the figures mean; the figures come from your recording; ranges are 80%, not
certainties; advice rests on this one session"; from the engine alone, "no model involved". The box's notice says a
small model can be wrong, and the model is told to give a verdict or advice only as coming from this one recording.

The model only runs when you ask, never while the game is sending telemetry, and leaves the graphics
card's memory as soon as it has answered (a live session starting unloads anything left).

## How well it answers

`npm run llm-eval` asks a model questions about your recorded races whose right answers come from
`race.db` itself, never typed in by hand: the best lap, start and finish, the winner, the position on a
lap, the stop and its tyres, who finished behind you, where time went on a lap, what to do better, lift
and coast, brake bias and differential, the battery, and one the recording can't answer.

| Model | Races | Right | Grounded (nothing invented) | Time a question (GTX 1650, 4 GB) |
|---|---|---|---|---|
| Qwen3 4B | Silverstone, Barcelona, Red Bull Ring, Monaco | **49 / 50** | **49 / 50** | 60-65 s |
| Qwen3 1.7B | the same four | **48 / 50** | **50 / 50** | 8-10 s |

3 November 2026, 25 questions a race pair, including one whose answer is "no" ("Do I already lift and
coast before corner 2?"). Qwen3 4B's one miss was a battery question that ran past the 3-minute limit.
Qwen3 1.7B said yes to that "no" question (a flipped negation the grounding check can't see) and gave a
battery answer without a figure. So: 4B is the more reliable, 1.7B answers six times faster. The 4B's
time is mostly the model being loaded and run on a card it nearly fills; the app counts the seconds while
it works. Llama 3.2 3B and Phi-4-mini haven't been scored.

**The expanded set (4 Nov 2026, Qwen3 1.7B, Spa, Barcelona, Silverstone and Monaco, 70 questions):
61 right, 70 of 70 grounded (nothing invented), 9.4 s an answer.** It adds a question for each insight above,
its right answer read from the same results. The 9 misses: three flipped "no"s on lift and coast and two on brake
bias (known), one battery answer without the percentages, and on the new questions the small model's judgement,
not its numbers: twice it called a slowing stint "held up well", once it wrote "0.00 seconds off the quickest" in a
summary. A first run found two engine wordings to fix (the pace leader was confused with the fastest single lap; the
fastest lap is now labelled as one lap, not race pace) and an eval check that was too strict. Qwen3 4B isn't scored
on the expanded set yet.

Scoring 4B also found a bug in the engine, not the model: "Where did I start and where did I finish?"
got the lap-coaching lookup because of the word "where"; fixed, with a test.

## What it can't do

- The grounding check covers numbers, not words: a small model can still turn "you don't coast there"
  into "you coast there".
- The setup advice is rules of thumb, not an optimiser, and the thresholds are first guesses.
- "Better" means better than your own best lap of that session.
- Sessions saved before 3 November 2026 have no corner-by-corner car data or battery trace unless their
  recordings are re-processed (see [setup](setup.md#the-windows-app)).
