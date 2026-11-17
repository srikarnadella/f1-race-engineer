// Where on the lap the time goes, for the live track map: each of the 25 mini-sectors (equal slices of the lap, from Lap
// Data, so it works on every car) as ms lost (+) or gained (-).
//   laps:  your last clean lap against the median of your clean laps before it (up to 5): where this lap went wrong.
//   ahead: your recent clean laps against the car ahead's (median of up to 3 each): where they are quicker than you.
// Clean = not a pit lap, not under a safety car / VSC, not lap 1 (the standing start).
const { median } = require('../lib/stats');

const MY_LAPS = 5;
const THEIR_LAPS = 3;

function cleanLaps(car) {
  if (!car) return [];
  const skip = new Set((car.lapHistory || []).filter((l) => l.pit || l.neutralised).map((l) => l.lapNum));
  return (car.miniSectors || []).filter((l) => l.lapNum > 1 && !skip.has(l.lapNum) && Array.isArray(l.splits) && l.splits.every((v) => v > 0));
}

const medianSplits = (laps) => laps[0].splits.map((_, k) => median(laps.map((l) => l.splits[k])));

// The slice that lost most, and the corner it belongs to: one that starts inside the slice, else the last one before it.
function worstOf(sectors, corners, trackLength) {
  let k = 0;
  for (let i = 1; i < sectors.length; i++) if (sectors[i] > sectors[k]) k = i;
  if (!(sectors[k] > 0)) return null;
  const from = (k * trackLength) / sectors.length;
  const to = ((k + 1) * trackLength) / sectors.length;
  const inside = (corners || []).find((c) => c.startM >= from && c.startM < to);
  const before = (corners || []).filter((c) => c.startM < from).pop();
  const c = inside || before || null;
  return { sector: k, ms: sectors[k], corner: c ? c.corner : null };
}

const diff = (mine, ref) => mine.map((v, k) => Math.round(v - ref[k]));

function mapLoss({ player, ahead, corners = [], trackLength }) {
  const mine = cleanLaps(player);
  let laps = null;
  if (mine.length >= 2) {
    const last = mine[mine.length - 1];
    const sectors = diff(last.splits, medianSplits(mine.slice(-1 - MY_LAPS, -1)));
    laps = { lapNum: last.lapNum, sectors, worst: worstOf(sectors, corners, trackLength) };
  }
  const theirs = cleanLaps(ahead);
  let vsAhead = null;
  if (mine.length && theirs.length && theirs[0].splits.length === mine[0].splits.length) {
    const sectors = diff(medianSplits(mine.slice(-THEIR_LAPS)), medianSplits(theirs.slice(-THEIR_LAPS)));
    vsAhead = { name: (ahead.participant && ahead.participant.name) || null, sectors, worst: worstOf(sectors, corners, trackLength) };
  }
  return { laps, ahead: vsAhead };
}

module.exports = { mapLoss };
