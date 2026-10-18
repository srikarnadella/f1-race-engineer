# Race store

Every session you drive, as related tables in one SQLite file: `data/race.db` (local, gitignored,
like the rest of `data/`). It's the layer for questions about a race after the fact ("what happened
on lap 12?", "where did I lose time to Norris?"), and for anything that wants the races as data.

- **Live:** the bridge adds each session when it ends (the next session starts, or you stop it).
- **From captures:** `npm run db [-- capture-folder ...]` replays each capture through the real
  pipeline and writes every session in it. Re-running replaces a session (same game session UID),
  never duplicates it.

Code: [`src/data/store.js`](../src/data/store.js) (schema and the one-transaction write),
[`src/data/sessionRecorder.js`](../src/data/sessionRecorder.js) (collects a session as it's driven;
a flashback takes back what it undid). Tests: `test/store.test.js`.

## Tables

```
capture ─< session ─< car ─< lap
              │        ├──< stint
              │        └──< trace_point
              ├──< event
              ├──< engineer_call
              ├──< radio_message
              └──< weather_sample
```

| Table | One row per | Key |
|---|---|---|
| `capture` | capture folder the sessions came from (`live` without one) | `capture_id` |
| `session` | game session: track, type, laps, player car, start/end, `official` once the final classification arrived | `session_id`; `session_uid` unique |
| `car` | car in a session: driver, team, grid, finish, points, best lap, race time, penalties, stops | `(session_id, car_idx)` |
| `lap` | car per completed lap: time, sectors and validity (the game's lap history), pit/neutralised flags, compound, tyre age, fuel, position and gap at the line, wear | `(session_id, car_idx, lap_num)` |
| `stint` | set of tyres a car ran: compound, first and last lap | `(session_id, car_idx, stint_num)` |
| `trace_point` | 2 m of a traced lap: lap time, speed, throttle, brake, steer, gear. Your laps from the line, and each rival's best lap | `(session_id, car_idx, lap_num, distance_m)` |
| `event` | game event: overtakes (who passed whom), penalties, safety cars, collisions, retirements, fastest laps, speed traps, flashbacks | `event_id`; indexed by `(session_id, lap_num)` |
| `engineer_call` | change of the PUSH / HOLD / BOX / PIT call, with its kind and reason | `(session_id, seq)` |
| `radio_message` | radio card as it was shown (a card that updates is a new row under the same `topic`) | `(session_id, seq)` |
| `weather_sample` | change of weather, temperatures or rain chance | `(session_id, session_time_s)` |

Times are integer ms unless the name ends in `_s` (game time, seconds). Booleans are 0/1. Compounds
are the visual ones: 16 soft, 17 medium, 18 hard, 7 inter, 8 wet. Child tables reference their
parent with `ON DELETE CASCADE`, and the composite-key tables are `WITHOUT ROWID`, so a lap or a trace
point is stored once, in key order. The file runs in WAL mode, so a reader doesn't block the
bridge's writes.

Views, for reading without joins: `v_lap` (laps with driver, track and `lap_time` as m:ss.mmm),
`v_result` (finishing order, places gained), `v_event` (events with both drivers named).

## Examples

```sql
-- What happened on lap 12 of the latest race?
SELECT session_time_s, code, description, driver, other_driver, value
FROM v_event
WHERE session_id = (SELECT max(session_id) FROM session WHERE is_race) AND lap_num = 12 AND code <> 'SPTP';

-- My laps, with sectors and tyres
SELECT lap_num, lap_time, s1_ms, s2_ms, s3_ms, compound, tyre_age, position
FROM v_lap WHERE is_player AND session_id = ?;

-- What the engineer said and called around my stop
SELECT lap_num, action, kind, reason FROM engineer_call WHERE session_id = ? AND lap_num BETWEEN 10 AND 14;

-- Top speed, me against the fastest car, along the lap (50 m bins)
SELECT car_idx, CAST(distance_m / 50 AS INT) * 50 AS at_m, max(speed_kmh)
FROM trace_point WHERE session_id = ? GROUP BY car_idx, at_m;
```

## What it found

Building it showed the game sends every car's Session History with a session UID of 0 at the
chequered flag (same game time, same player). The field model took that for a new session and reset,
so each car's final lap and the official result were lost: in the debrief (no saved session had
its classification) and in `datasets/laps.csv` (120 laps short over six races). A UID of 0 is now
part of the current session (`test/state.test.js`).

## Size

The 8 sessions in the captures so far: about 1,900 laps, 3,700 events and 335,000 trace points in
a 16 MB file. The recorder adds about 46 µs to a 10 Hz tick. Writing a 27-lap Monaco race
(516 laps, 54,000 trace points) takes about 155 ms, once, at the end of the session.
