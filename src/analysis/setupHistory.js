// What you ran at a track and how fast it was (the store's setup_run rows and your laps), so the Setup screen can show
// the setup behind your fastest clean lap there. Laps are compared only with laps of the same kind: qualifying with
// qualifying, everything else together, because a race lap on a heavy car says nothing about a qualifying setup.
const { ROWS } = require('./setupCompare');

// sessions: [{ sessionType, name, startedAt, runs: [{ fromLap, setup }], laps: [{ lapNum, lapMs, valid, pit, neutralised, compound }] }]
function bestSetup(sessions, kind) {
  let best = null;
  for (const s of sessions) {
    if ((s.sessionType >= 5 && s.sessionType <= 14 ? 'q' : 'r') !== kind) continue;
    const runs = [...s.runs].sort((a, b) => a.fromLap - b.fromLap);
    for (const l of s.laps) {
      if (l.valid === false || l.pit || l.neutralised || !(l.lapMs > 0)) continue;
      // An unknown validity (old data: the game's lap history was not seen) is not held against the lap.
      // The run in force on this lap: the last one that started on or before it.
      const run = runs.filter((r) => r.fromLap <= l.lapNum).pop();
      if (!run || (best && l.lapMs >= best.lapMs)) continue;
      best = { lapMs: l.lapMs, setup: run.setup, session: s.name, startedAt: s.startedAt, compound: l.compound ?? null };
    }
  }
  return best;
}

// The best setup's values (by key) against the car's now: ok true when the car has the same, false with the change
// needed to match it, null when either side has no value.
function diffAgainst(best, current) {
  return ROWS.map((row) => {
    const want = best[row.key];
    const have = current[row.key];
    if (want == null || have == null) return { key: row.key, label: row.label, value: want ?? null, current: have ?? null, ok: null, change: null };
    const tol = row.tolerance || 0;
    const ok = Math.abs(want - have) <= tol;
    return { key: row.key, label: row.label, value: want, current: have, ok, change: ok ? 0 : Math.round((want - have) * 100) / 100 };
  });
}

module.exports = { bestSetup, diffAgainst };
