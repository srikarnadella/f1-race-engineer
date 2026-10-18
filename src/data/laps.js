// The lap dataset: one row per car per completed lap, for training and
// scoring the models without the raw captures (hundreds of MB each, never
// committed). Laps are recorded as they complete - the field model keeps only
// the last 12 - and taken back when a flashback undoes them. No driver
// names: the player's could be a gamertag.
const { TRACKS } = require('../udp/gameIds');

// [column, type]: n = number, b = boolean (0/1), s = string. Empty = unknown.
const SCHEMA = [
  ['raceId', 's'], ['track', 's'], ['sessionType', 'n'], ['totalLaps', 'n'],
  ['carIndex', 'n'], ['isPlayer', 'b'], ['lapNum', 'n'], ['lapMs', 'n'],
  ['pit', 'b'], ['neutralised', 'b'], ['compound', 'n'], ['tyreAge', 'n'], ['fuelKg', 'n'],
  ['position', 'n'], ['gapToLeaderMs', 'n'], ['numPitStops', 'n'], ['wearMax', 'n'], ['usableLife', 'n'],
];
const LAP_COLUMNS = SCHEMA.map(([c]) => c);
// calls.csv: the strategy calls each race made, for the calls audit.
const CALL_SCHEMA = [['raceId', 's'], ['lapNum', 'n'], ['action', 's'], ['kind', 's']];
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

function createLapRecorder(fieldModel, { raceId }) {
  const byCar = new Map(); // carIndex -> Map(lapNum -> row)

  // Call often enough that no lap leaves the field model's 12 before it's seen.
  function sync() {
    const session = fieldModel.getSession();
    if (!session) return;
    const player = fieldModel.playerIndex();
    for (const car of fieldModel.orderedByPosition()) {
      if (!car.lapData) continue;
      let laps = byCar.get(car.carIndex);
      if (!laps) byCar.set(car.carIndex, (laps = new Map()));
      // A completed lap is before the one being driven, so anything at or
      // after it was undone by a flashback - except at the flag, where the
      // counter stays on the last lap once the car has finished.
      const firstOpen = car.lapData.resultStatus === 3 ? car.lapData.currentLapNum + 1 : car.lapData.currentLapNum;
      for (const n of laps.keys()) if (n >= firstOpen) laps.delete(n);
      for (const l of car.lapHistory || []) {
        if (laps.has(l.lapNum) || l.lapNum >= firstOpen) continue;
        const set = (car.tyreSets || []).find((x) => x.fitted);
        const wear = car.damage && car.damage.tyresWear;
        laps.set(l.lapNum, {
          raceId,
          track: TRACKS[session.trackId] || `track ${session.trackId}`,
          sessionType: session.sessionType,
          totalLaps: session.totalLaps,
          carIndex: car.carIndex,
          isPlayer: car.carIndex === player,
          lapNum: l.lapNum,
          lapMs: l.lapMs,
          pit: !!l.pit,
          neutralised: !!l.neutralised,
          compound: l.compound ?? null,
          tyreAge: l.tyreAge ?? null,
          fuelKg: round1(l.fuelKg),
          // The rest as the car crossed the line (the next sync after it).
          position: car.lapData.carPosition,
          gapToLeaderMs: car.lapData.carPosition === 1 ? 0 : car.lapData.deltaToRaceLeaderInMS || null,
          numPitStops: car.lapData.numPitStops,
          wearMax: wear ? round1(Math.max(...wear)) : null,
          usableLife: set ? set.usableLife : null,
        });
      }
    }
  }

  const rows = () => [...byCar.keys()].sort((a, b) => a - b).flatMap((c) => [...byCar.get(c).values()].sort((a, b) => a.lapNum - b.lapNum));
  return { sync, rows };
}

// One row each time the race call changes (its action or kind - not its
// numbers ticking along), on the player's lap at the time. A flashback takes
// back the calls made on the laps it undid, as it does the laps.
function createCallRecorder(fieldModel, { raceId }) {
  const rows = [];
  function sync(snap) {
    const p = fieldModel.playerIndex();
    const car = p == null ? null : fieldModel.getCar(p);
    if (!car || !car.lapData) return;
    const lapNum = car.lapData.currentLapNum;
    while (rows.length && rows[rows.length - 1].lapNum > lapNum) rows.pop();
    const c = snap.strategy && snap.strategy.call;
    if (!c || !c.kind) return; // qualifying calls carry no kind
    const last = rows[rows.length - 1];
    if (last && last.action === c.action && last.kind === c.kind) return;
    rows.push({ raceId, lapNum, action: c.action, kind: c.kind });
  }
  return { sync, rows: () => rows };
}

const cell = (v) => (v == null ? '' : typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
function toCsv(rows, schema = SCHEMA) {
  const cols = schema.map(([c]) => c);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

function fromCsv(text, schema = SCHEMA) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(',');
  const type = Object.fromEntries(schema);
  return lines.map((line) => Object.fromEntries(line.split(',').map((v, i) => {
    const t = type[cols[i]];
    return [cols[i], v === '' ? null : t === 'n' ? Number(v) : t === 'b' ? v === '1' : v];
  })));
}

module.exports = { createLapRecorder, createCallRecorder, toCsv, fromCsv, LAP_COLUMNS, CALL_SCHEMA };
