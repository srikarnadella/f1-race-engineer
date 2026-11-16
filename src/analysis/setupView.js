// The setup section of the snapshot: the sheet's setup for the circuit the session is at, beside the car's own
// (setupCompare), your own best setup at the track from earlier sessions (setupHistory), plus whether the car can be changed now and whether the player is in the garage or the pit lane.
const { TRACKS } = require('../udp/gameIds');
const { compareSetup, setupValues, setupExtras } = require('./setupCompare');
const { diffAgainst } = require('./setupHistory');
const { identity } = require('./setupLibrary');

const QUALI = (t) => t >= 5 && t <= 14;
const RACE = (t) => t >= 15 && t <= 17; // the setup can't be changed in a race or a sprint

// session: the Session packet; car: the player's field-model car; setups: { game, circuits } from the sheet, or null.
// best: bestSetup()'s answer for this track and kind, or null. notes: the store's setup_note rows (names and stars).
function setupView({ session, car, setups, best = null, notes = [] }) {
  if (!session || !car || !car.setup) return null;
  const track = TRACKS[session.trackId] || null;
  const circuit = setups && track ? setups.circuits.find((c) => c.track === track) : null;
  const cmp = circuit ? compareSetup(car.setup, circuit, QUALI(session.sessionType) ? 'q' : 'r') : null;
  const lap = car.lapData;
  return {
    available: !!cmp,
    track,
    circuit: cmp ? cmp.circuit : null,
    kind: QUALI(session.sessionType) ? 'q' : 'r',
    editable: !RACE(session.sessionType),
    inGarage: !!lap && (lap.pitStatus !== 0 || lap.driverStatus === 0),
    rows: cmp ? cmp.rows : [],
    off: cmp ? cmp.off : 0,
    notes: cmp ? cmp.notes : null,
    source: setups ? setups.game : null,
    history: history(best, car),
    current: current(car, session.trackId, notes),
  };
}

// The car's setup as the library knows it (its key and values), with the name and star you gave it, so the garage screen
// can name and star it.
function current(car, trackId, notes) {
  const values = { ...setupValues(car.setup), ...setupExtras(car.setup) };
  const key = identity(values);
  const n = notes.find((x) => x.trackId === trackId && x.key === key);
  return { key, trackId, values, name: n ? n.name : '', favorite: n ? n.favorite : false };
}

function history(best, car) {
  if (!best) return null;
  const rows = diffAgainst(best.setup, setupValues(car.setup));
  return { lapMs: best.lapMs, session: best.session, compound: best.compound, rows, off: rows.filter((r) => r.ok === false).length };
}

module.exports = { setupView };
