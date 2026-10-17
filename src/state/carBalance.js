// Watches the player's car corner by corner - wheel slip from Motion Ex,
// pedals and steering from Car Telemetry, position from Lap Data - and
// remembers, per corner and per lap, whether a wheel locked on the way in,
// the rears spun on the way out, or the front washed wide under power.
// One lap's mistake is noise; the same thing two laps out of three is the
// car, and that's what the adjustment suggestions are built from.
//
// The game sends no corner map, so a "corner" is a braking zone, numbered
// from the start line. Close to, but not always, the official turn numbers.
//
// Thresholds are first guesses on the F1 25 spec (slip ratio is unitless,
// slip angle in radians) and need calibrating against a real F1 26 capture.

const WHEEL = ['RL', 'RR', 'FL', 'FR']; // the game's array order
const REAR = [0, 1];
const FRONT = [2, 3];

// Calibrated on a real F1 26 race (Silverstone, player car, ~30Hz): normal
// braking sits around -0.03 slip with the hardest 5% near -0.2, and a real
// lock runs away towards -1 (wheel stopped). Corner exits run ~0.04 rear
// slip (95th percentile 0.15) while real wheelspin jumps to 1-5. Front-vs-
// rear slip angle on exit: median 0.03 rad, 99th percentile 0.077. The
// first thresholds (-0.15 / 0.15 / 0.05) sat inside normal driving and
// flagged a quarter of all corner exits as understeer.
const BRAKE_ON = 0.3;
const BRAKE_OFF = 0.05;
const MIN_LOCK_SPEED_KMH = 60;
const LOCK_SLIP = -0.4; // wheel turning 40% slower than the car moves
const SPIN_SLIP = 0.4; // rear wheels turning 40% faster than the car moves
const EXIT_WINDOW_M = 300; // distance after the brake release that counts as the exit
const EXIT_MIN_THROTTLE = 0.5;
const EXIT_MIN_SPEED_KMH = 50; // slip ratio explodes near standstill (launches, pit exit)
const EXIT_MAX_SPEED_KMH = 230;
const UNDERSTEER_STEER = 0.2; // -1..1 steering input
const UNDERSTEER_FRONT_ANGLE = 0.14; // rad - above the race's 99th percentile
const UNDERSTEER_MARGIN = 0.08; // front slip angle this much more than the rear's
const SAME_ZONE_M = 120; // a brake point within this of a known one is the same corner
const LAPS_KEPT = 3;
const REPEAT_LAPS = 2; // flagged on this many of the last LAPS_KEPT laps = an issue

function createCarBalanceTracker() {
  // { startM, laps: Map(lapNum -> { frontLock, rearLock, spin, understeer }) }
  const zones = [];
  let braking = false;
  let current = null; // the zone being braked into / exited
  let brakeReleasedAtM = null;
  let trackLength = null;
  let currentLap = null;

  function wrapDist(a, b) {
    const d = Math.abs(a - b);
    return trackLength ? Math.min(d, trackLength - d) : d;
  }

  function zoneAt(distM) {
    let zone = zones.find((z) => wrapDist(z.startM, distM) < SAME_ZONE_M);
    if (!zone) {
      zone = { startM: distM, laps: new Map() };
      zones.push(zone);
      zones.sort((a, b) => a.startM - b.startM);
    }
    return zone;
  }

  function record(zone, lapNum, key, value) {
    if (!zone.laps.has(lapNum)) zone.laps.set(lapNum, {});
    const rec = zone.laps.get(lapNum);
    if (!rec[key]) rec[key] = value;
  }

  // Only the last few laps (counted from the lap being driven now) matter;
  // older ones would keep an issue the driver has since fixed on the list.
  function prune() {
    if (currentLap == null) return;
    for (const zone of zones) for (const l of zone.laps.keys()) if (l <= currentLap - LAPS_KEPT || l > currentLap) zone.laps.delete(l);
  }

  // Called once per Motion Ex packet with the latest telemetry and lap data.
  function update({ motionEx, telemetry, lapData, trackLengthM, neutralised }) {
    if (!motionEx || !telemetry || !lapData || lapData.pitStatus !== 0) return;
    // Under a safety car / VSC the car is driven nothing like race pace -
    // brake points move, and they'd be learned as new "corners".
    if (neutralised) {
      braking = false;
      current = null;
      return;
    }
    if (trackLengthM) trackLength = trackLengthM;
    const dist = lapData.lapDistance;
    if (!(dist >= 0)) return; // before the line on lap 1, lapDistance is negative
    const lap = lapData.currentLapNum;
    if (lap !== currentLap) {
      currentLap = lap;
      prune();
    }
    const slip = motionEx.wheelSlipRatio;
    const angle = motionEx.wheelSlipAngle;
    if (!Array.isArray(slip) || !Array.isArray(angle) || slip.length < 4 || angle.length < 4) return;

    // --- Entry: braking ---
    if (!braking && telemetry.brake >= BRAKE_ON) {
      braking = true;
      current = zoneAt(dist);
      brakeReleasedAtM = null;
    } else if (braking && telemetry.brake <= BRAKE_OFF) {
      braking = false;
      brakeReleasedAtM = dist;
    }
    if (braking && current && telemetry.speed >= MIN_LOCK_SPEED_KMH) {
      const lockedFront = FRONT.filter((w) => slip[w] <= LOCK_SLIP);
      const lockedRear = REAR.filter((w) => slip[w] <= LOCK_SLIP);
      if (lockedFront.length) record(current, lap, 'frontLock', lockedFront.length === 2 ? 'Fronts' : WHEEL[lockedFront[0]]);
      if (lockedRear.length) record(current, lap, 'rearLock', lockedRear.length === 2 ? 'Rears' : WHEEL[lockedRear[0]]);
    }

    // --- Exit: back on the power ---
    const onExit = !braking && current && brakeReleasedAtM != null && wrapDist(dist, brakeReleasedAtM) < EXIT_WINDOW_M
      && telemetry.throttle >= EXIT_MIN_THROTTLE && telemetry.speed >= EXIT_MIN_SPEED_KMH && telemetry.speed <= EXIT_MAX_SPEED_KMH;
    if (onExit) {
      if (REAR.some((w) => slip[w] >= SPIN_SLIP)) record(current, lap, 'spin', true);
      const front = (Math.abs(angle[2]) + Math.abs(angle[3])) / 2;
      const rear = (Math.abs(angle[0]) + Math.abs(angle[1])) / 2;
      if (Math.abs(telemetry.steer) >= UNDERSTEER_STEER && front >= UNDERSTEER_FRONT_ANGLE && front - rear >= UNDERSTEER_MARGIN) {
        record(current, lap, 'understeer', true);
      }
    }
  }

  // The driver changed the setting these issues are about: the laps before
  // the change no longer describe the car. Without this, a suggestion chased
  // its own tail ("diff 80 -> 75", then "75 -> 70", ...) in a real race.
  function forget(types) {
    for (const zone of zones) for (const rec of zone.laps.values()) for (const t of types) delete rec[t];
  }

  // Repeated issues, most persistent first: [{ corner, distM, type, wheel, laps }].
  function issues() {
    const out = [];
    zones.forEach((zone, i) => {
      for (const type of ['frontLock', 'rearLock', 'spin', 'understeer']) {
        const hits = [...zone.laps.values()].filter((rec) => rec[type]);
        if (hits.length >= REPEAT_LAPS) {
          out.push({ corner: i + 1, distM: Math.round(zone.startM), type, wheel: typeof hits[hits.length - 1][type] === 'string' ? hits[hits.length - 1][type] : null, laps: hits.length });
        }
      }
    });
    return out.sort((a, b) => b.laps - a.laps || a.corner - b.corner);
  }

  // [{ corner, startM }] in lap order - numbered the same as the issues.
  function corners() {
    return zones.map((z, i) => ({ corner: i + 1, startM: Math.round(z.startM) }));
  }

  return { update, issues, forget, corners, cornerCount: () => zones.length };
}

// Exposed so capture analysis can report how real data sits against them.
const THRESHOLDS = {
  BRAKE_ON, MIN_LOCK_SPEED_KMH, LOCK_SLIP, SPIN_SLIP, EXIT_MIN_THROTTLE, EXIT_MIN_SPEED_KMH, EXIT_MAX_SPEED_KMH,
  UNDERSTEER_STEER, UNDERSTEER_FRONT_ANGLE, UNDERSTEER_MARGIN,
};

module.exports = { createCarBalanceTracker, THRESHOLDS };
