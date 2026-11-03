# Performance

Undercut runs on the same PC as F1 26, so what it costs that PC is measured, not assumed.
`node scripts/perf-app.js` launches the app in a throwaway profile (your races are never
touched), times it to a usable Home, then samples every app process (main, window, GPU,
utility) through four phases. The race phases feed a real recorded race (Barcelona, 17 Oct
2026, from 10 minutes in) over UDP at its recorded pace, the same packets the game sends.

Measured 3 Nov 2026 on a Ryzen 5 3600 (12 threads), 32 GB, GTX 1650, Windows 11, running
from source (Electron 45). CPU is the share of one core; divide by 12 for the share of this PC.

| Phase | CPU, one core | CPU, whole PC | RAM working set | RAM private |
|---|---|---|---|---|
| Idle, Home showing | 1.7-2.2% | 0.14-0.18% | 347-362 MB | 203-252 MB |
| Idle, minimized | 0.6-0.9% | 0.05-0.08% | 347-354 MB | 202-246 MB |
| Race, dashboard showing | 6.8-10.1% | 0.56-0.84% | 378-392 MB | 233-243 MB |
| Race, minimized | 3.2-4.8% | 0.27-0.40% | 383-403 MB | 234-253 MB |

Ranges are over four runs (three of 30 s phases, one of 60 s). Other numbers:

- **Startup to a usable Home:** 0.74-0.81 s. One run took 5.25 s, started one second after
  the previous run was killed, so it is likely the old processes still shutting down.
- **Installed size:** 363 MB on disk (`%LOCALAPPDATA%\Programs\undercut`), almost all
  Electron's Chromium.
- **What a race costs:** about 6 percentage points of one core with the dashboard on screen,
  about 3 minimized; under 1% of the whole PC either way.

## What the numbers say

- The race with the dashboard showing is the biggest cost, and most of it is drawing: the
  same race minimized costs about half. The dashboard redraws on every snapshot (10 a
  second) even when the window is hidden; roadmap W1 stops that.
- Run to run, the race phases vary by about 20%, more than the 10% W0 aimed for. The packet
  feed is the same each time; the spread is Windows scheduling over 30-60 s samples.
  Compare changes over several runs, not one.
- The new Home (W2) idled at the same CPU as the old one with one photograph (+45 MB private
  RAM). The slideshow (W5) raises Home's idle to 4.2% of one core while it is on screen: each
  0.7 s crossfade every 8 s is two full-window layers blending. It costs nothing minimized (it
  pauses), and nothing once you leave Home. A hard cut instead of a fade would remove it.
- W1 (3 Nov): a hidden window now runs only the voice, and redraws the latest race when it comes
  back; the window opens once painted. Re-measured: race minimized 3.9% of a core, inside the
  earlier 3.2-4.8% range, so what is left minimized is the engine reading ~370 packets a second, not
  drawing. Caching the running order (`orderedByPosition`, ~2.7% of a 0.6 ms tick) was left out: too
  little to measure here for the risk of a shared, stale list.
- Not measured yet: the game's frame rate with the app beside it, which needs F1 26
  running. This file gets that row when it has been measured.
