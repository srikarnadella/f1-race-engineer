// The setup on the car against the community sheet's setup for the track (src/data/setupSheet.js): fourteen values in
// the order the car menu has them, each right, wrong (with which way to go) or unknown when the sheet has no value.
// It marks differences; it does not say the sheet is right for you. kind: 'q' (qualifying) or 'r' (everything else).

// Pressure steps are 0.1, so anything within half a step is the same value.
const PRESSURE_TOLERANCE = 0.05;

// Each row: how to read the car's value and the sheet's target. A target is { lo, hi } (equal ends for one value) or null.
const ROWS = [
  { key: 'frontWing', label: 'Front wing', car: (s) => s.frontWing, want: (c, k) => c.aero && one(c.aero[k].front) },
  { key: 'rearWing', label: 'Rear wing', car: (s) => s.rearWing, want: (c, k) => c.aero && one(c.aero[k].rear) },
  { key: 'diffOn', label: 'Diff on throttle', car: (s) => s.onThrottle, want: (c, k) => c.diff && one(c.diff[k].on) },
  { key: 'diffOff', label: 'Diff off throttle', car: (s) => s.offThrottle, want: (c, k) => c.diff && one(c.diff[k].off) },
  { key: 'frontSuspension', label: 'Front suspension', car: (s) => s.frontSuspension, want: (c) => c.suspension && one(c.suspension.frontSuspension) },
  { key: 'rearSuspension', label: 'Rear suspension', car: (s) => s.rearSuspension, want: (c) => c.suspension && one(c.suspension.rearSuspension) },
  { key: 'frontAntiRollBar', label: 'Front anti-roll bar', car: (s) => s.frontAntiRollBar, want: (c) => c.suspension && one(c.suspension.frontAntiRollBar) },
  { key: 'rearAntiRollBar', label: 'Rear anti-roll bar', car: (s) => s.rearAntiRollBar, want: (c) => c.suspension && one(c.suspension.rearAntiRollBar) },
  { key: 'frontHeight', label: 'Front ride height', car: (s) => s.frontSuspensionHeight, want: (c) => c.suspension && one(c.suspension.frontHeight) },
  { key: 'rearHeight', label: 'Rear ride height', car: (s) => s.rearSuspensionHeight, want: (c) => c.suspension && one(c.suspension.rearHeight) },
  { key: 'brakePressure', label: 'Brake pressure', car: (s) => s.brakePressure, want: (c, k) => c.brakes && one(c.brakes.pressure[k]) },
  { key: 'brakeBias', label: 'Brake bias', car: (s) => s.brakeBias, want: (c) => c.brakes && { lo: c.brakes.bias.lo, hi: c.brakes.bias.hi } },
  { key: 'tyreFront', label: 'Front tyre pressure', car: (s) => (s.tyrePressures ? avg(s.tyrePressures.fl, s.tyrePressures.fr) : null), want: (c, k) => c.tyres && one(c.tyres[k].front), tolerance: PRESSURE_TOLERANCE },
  { key: 'tyreRear', label: 'Rear tyre pressure', car: (s) => (s.tyrePressures ? avg(s.tyrePressures.rl, s.tyrePressures.rr) : null), want: (c, k) => c.tyres && one(c.tyres[k].rear), tolerance: PRESSURE_TOLERANCE },
];

function one(v) {
  return v == null ? null : { lo: v, hi: v };
}
const avg = (a, b) => Math.round(((a + b) / 2) * 100) / 100;
const text = (t) => (t.lo === t.hi ? String(t.lo) : `${t.lo}-${t.hi}`);

// The car's own fields against the sheet.
function compareSetup(setup, circuit, kind) {
  if (!setup || !circuit) return null;
  return compareValues(setupValues(setup), circuit, kind);
}

// The same, from the fourteen values by key (as the store and the library keep them).
function compareValues(values, circuit, kind) {
  if (!values || !circuit) return null;
  const k = kind === 'q' ? 'q' : 'r';
  const rows = ROWS.map((row) => {
    const current = values[row.key] ?? null;
    const target = row.want(circuit, k) || null;
    if (current == null || !target) return { key: row.key, label: row.label, current: current ?? null, target: target ? text(target) : null, ok: null, change: null };
    const tol = row.tolerance || 0;
    const below = target.lo - current;
    const above = current - target.hi;
    const ok = below <= tol && above <= tol;
    // Which way to go, to the nearest end of the sheet's range.
    const change = ok ? 0 : below > 0 ? Math.round(below * 100) / 100 : -Math.round(above * 100) / 100;
    return { key: row.key, label: row.label, current, target: text(target), ok, change };
  });
  return { circuit: circuit.circuit, kind: k, rows, off: rows.filter((r) => r.ok === false).length, notes: circuit.notes || null };
}

// The car's fourteen values by key, as the store keeps them and the history compares them.
const setupValues = (setup) => Object.fromEntries(ROWS.map((r) => [r.key, setup ? r.car(setup) ?? null : null]));

// The sheet's own values for a circuit, for showing as a reference: [{ key, label, target }] (target as text, null if the sheet has none).
function referenceRows(circuit, kind) {
  if (!circuit) return [];
  const k = kind === 'q' ? 'q' : 'r';
  return ROWS.map((row) => {
    const t = row.want(circuit, k) || null;
    return { key: row.key, label: row.label, target: t ? text(t) : null };
  });
}

// What else the game sends that the library tells setups apart by: camber, toe, engine braking and ballast.
const EXTRA_DECIMALS = { frontCamber: 2, rearCamber: 2, frontToe: 2, rearToe: 2, engineBraking: 0, ballast: 0 };
const setupExtras = (setup) => Object.fromEntries(Object.entries(EXTRA_DECIMALS).map(([k, d]) => [k, setup && typeof setup[k] === 'number' && Number.isFinite(setup[k]) ? Math.round(setup[k] * 10 ** d) / 10 ** d : null]));

module.exports = { compareSetup, compareValues, referenceRows, setupValues, setupExtras, ROWS };
