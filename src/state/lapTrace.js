// Records the player's inputs against distance for every lap, at full packet
// rate - the raw material for the debrief's lap comparison ("braked 12 m
// earlier into turn 1, 6 km/h slower at the apex"). A completed lap's trace
// is handed over once; the debrief keeps it.

const SAMPLE_EVERY_M = 2;
const FLASHBACK_REWIND_M = 30;

function createLapTraceRecorder() {
  let lapNum = null;
  let points = []; // [d, tMs, speed, throttle, brake, steer, gear]
  let startedAtLine = false;
  let invalid = false;
  const completed = []; // traces waiting to be collected

  function update(lap, tel) {
    if (!lap || !tel) return;
    if (lapNum !== null && lap.currentLapNum !== lapNum) {
      // Only a lap completed going forwards; a flashback back across the
      // line throws the partial lap away (and any traces not yet collected
      // for laps that are now in the future).
      if (lap.currentLapNum > lapNum && points.length > 50) completed.push({ lapNum, startedAtLine, invalid, lapMs: lap.lastLapTimeInMS, points });
      if (lap.currentLapNum < lapNum) for (let i = completed.length - 1; i >= 0; i--) if (completed[i].lapNum >= lap.currentLapNum) completed.splice(i, 1);
      points = [];
      invalid = false;
    }
    lapNum = lap.currentLapNum;
    const d = lap.lapDistance;
    if (!(d >= 0) || lap.pitStatus !== 0) return;
    if (lap.currentLapInvalid) invalid = true;
    const last = points[points.length - 1];
    // Flashback: drop the abandoned part of the lap and record the re-run.
    if (last && d < last[0] - FLASHBACK_REWIND_M) points = points.filter((p) => p[0] <= d);
    if (!points.length) startedAtLine = d < 60;
    const tail = points[points.length - 1];
    if (!tail || d - tail[0] >= SAMPLE_EVERY_M) {
      points.push([Math.round(d * 10) / 10, lap.currentLapTimeInMS, tel.speed, +tel.throttle.toFixed(3), +tel.brake.toFixed(3), +tel.steer.toFixed(3), tel.gear]);
    }
  }

  // The final lap at the flag, where the lap counter never moves on.
  function finish(lap) {
    if (points.length > 50) completed.push({ lapNum, startedAtLine, invalid, lapMs: lap.lastLapTimeInMS, points });
    points = [];
  }

  function take() {
    return completed.splice(0, completed.length);
  }

  return { update, finish, take };
}

// Each car's time at evenly spaced points round the lap ("mini-sectors"),
// from Lap Data alone - so every car on track can be compared, not just the
// player (the game only sends inputs for your own car).
const MINI_SECTORS = 25;

function createMiniSectorTracker() {
  // per car: { lapNum, crossings: [ms at boundary k], lastD, lastT }
  const state = new Map();

  function update(carIndex, car, lap, trackLength) {
    // Lap 1 is skipped: from a standing start the grid sits behind the
    // line, and its first slices came out as nonsense (0.3s for a 2.7s
    // slice) in a real race.
    if (!trackLength || !lap || !(lap.lapDistance >= 0) || lap.currentLapNum <= 1) return;
    let s = state.get(carIndex);
    if (!s || s.lapNum !== lap.currentLapNum) {
      if (s && lap.currentLapNum === s.lapNum + 1 && s.crossings.filter((x) => x != null).length === MINI_SECTORS - 1 && lap.lastLapTimeInMS > 0) {
        // Close the lap: the last boundary is the line itself.
        const times = [...s.crossings, lap.lastLapTimeInMS];
        car.miniSectors = car.miniSectors || [];
        car.miniSectors.push({ lapNum: s.lapNum, splits: times.map((t, k) => t - (k ? times[k - 1] : 0)) });
        if (car.miniSectors.length > 20) car.miniSectors.shift();
      }
      s = { lapNum: lap.currentLapNum, crossings: new Array(MINI_SECTORS - 1).fill(null), lastD: lap.lapDistance, lastT: lap.currentLapTimeInMS };
      state.set(carIndex, s);
      return;
    }
    const d = lap.lapDistance;
    const t = lap.currentLapTimeInMS;
    if (d < s.lastD - FLASHBACK_REWIND_M) {
      // Flashback: forget boundaries beyond where the car now is.
      for (let k = 0; k < s.crossings.length; k++) if (((k + 1) * trackLength) / MINI_SECTORS > d) s.crossings[k] = null;
    } else if (d > s.lastD) {
      for (let k = 0; k < s.crossings.length; k++) {
        const b = ((k + 1) * trackLength) / MINI_SECTORS;
        if (s.crossings[k] == null && s.lastD < b && d >= b) {
          s.crossings[k] = Math.round(s.lastT + ((b - s.lastD) / (d - s.lastD)) * (t - s.lastT));
        }
      }
    }
    s.lastD = d;
    s.lastT = t;
  }

  // The final lap at the flag, where the lap counter never moves on.
  function close(carIndex, car, lapMs) {
    const s = state.get(carIndex);
    if (!s || s.crossings.some((x) => x == null) || !(lapMs > 0)) return;
    const times = [...s.crossings, lapMs];
    car.miniSectors = car.miniSectors || [];
    car.miniSectors.push({ lapNum: s.lapNum, splits: times.map((t, k) => t - (k ? times[k - 1] : 0)) });
    state.delete(carIndex);
  }

  return { update, close, reset: () => state.clear() };
}

module.exports = { createLapTraceRecorder, createMiniSectorTracker, MINI_SECTORS };
