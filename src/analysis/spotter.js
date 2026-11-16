// "Car left / car right / clear": which side a rival is alongside on, from the world positions in the Motion
// packet. Everything is metres on the ground plane (x, z), in the player's own frame: the longitudinal offset
// along the car's forward direction, the lateral offset along its right direction.
//
// shortcut: cars are points 5.6 m long: it ignores the car's width and yaw, so a car that is turned across the
// track is judged by where its middle is. Upgrade to corner-to-corner boxes if the calls feel late or early.
const CAR_LENGTH_M = 5.6;
const MAX_LATERAL_M = 5; // one lane over is about 3.5 m between car centres
const MIN_LATERAL_M = 0.5; // closer than this is on top of me, not beside me
const HOLD_MS = 400; // a side stays "on" this long after the car leaves it, so a flicker is not a call

// player: { x, z, forwardX, forwardZ, rightX, rightZ }; other: { x, z }. 'left', 'right' or null.
function sideOf(player, other) {
  const dx = other.x - player.x;
  const dz = other.z - player.z;
  const lon = dx * player.forwardX + dz * player.forwardZ;
  const lat = dx * player.rightX + dz * player.rightZ;
  if (Math.abs(lon) > CAR_LENGTH_M || Math.abs(lat) < MIN_LATERAL_M || Math.abs(lat) > MAX_LATERAL_M) return null;
  return lat > 0 ? 'right' : 'left';
}

// Remembers which side has a car across ticks. update(player, rivals, nowMs): rivals are
// { idx, x, z, inactive?, inPit? }; returns { left, right (a rival's index, or null), events }, where events are
// the changes since the last call: { side, on: true, idx } when a car appears, { side, on: false, idx: null }
// once a side has been empty for the hold time.
function createSpotter({ holdMs = HOLD_MS } = {}) {
  const state = { left: { idx: null, lastSeenMs: null }, right: { idx: null, lastSeenMs: null } };
  function update(player, rivals, nowMs) {
    const nearest = { left: null, right: null };
    for (const r of rivals) {
      if (r.inactive || r.inPit) continue;
      const side = sideOf(player, r);
      if (!side) continue;
      const dist = Math.hypot(r.x - player.x, r.z - player.z);
      if (!nearest[side] || dist < nearest[side].dist) nearest[side] = { idx: r.idx, dist };
    }
    const events = [];
    for (const side of ['left', 'right']) {
      const s = state[side];
      if (nearest[side]) {
        if (s.idx == null) events.push({ side, on: true, idx: nearest[side].idx });
        s.idx = nearest[side].idx;
        s.lastSeenMs = nowMs;
      } else if (s.idx != null && nowMs - s.lastSeenMs >= holdMs) {
        s.idx = null;
        events.push({ side, on: false, idx: null });
      }
    }
    return { left: state.left.idx, right: state.right.idx, events };
  }
  return { update };
}

module.exports = { CAR_LENGTH_M, MAX_LATERAL_M, sideOf, createSpotter };
