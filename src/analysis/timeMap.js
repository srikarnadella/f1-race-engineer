// Where on the track a lap lost its time. The lap comparison (lapCompare.js) gives the running gap to the reference lap by
// distance; this cuts it into `bins` equal slices of the lap, the same number as the track outline has points
// (state/trackOutline.js), so slice i of the gap is the time lost (+) or gained (-) on the stretch the outline's i-th point starts.
const round = (v) => Math.round(v * 1000) / 1000;

// trace: { d: metres ascending in equal steps, delta: seconds, the gap so far }. null when there is not enough lap to cut up.
function timeMap(trace, bins = 240) {
  if (!trace || !Array.isArray(trace.d) || trace.d.length < 2 || trace.delta.length !== trace.d.length) return null;
  const { d, delta } = trace;
  const lengthM = d[d.length - 1];
  const step = d[1] - d[0];
  if (!(lengthM > 0) || !(step > 0)) return null;
  const gapAt = (m) => {
    const x = Math.max(0, Math.min(lengthM, m)) / step;
    const k = Math.min(d.length - 2, Math.floor(x));
    return delta[k] + (delta[k + 1] - delta[k]) * (x - k);
  };
  const deltaS = [];
  for (let i = 0; i < bins; i++) deltaS.push(round(gapAt(((i + 1) * lengthM) / bins) - gapAt((i * lengthM) / bins)));
  return { lengthM, deltaS };
}

module.exports = { timeMap };
