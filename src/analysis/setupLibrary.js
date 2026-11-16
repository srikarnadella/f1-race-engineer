// The setup library: every setup you ran at each track (from the race store's setup_run rows and your laps), what it did,
// and the names, stars and notes you gave it (the store's setup_note rows). Pure: the store hands over rows, this builds the
// view. It shows evidence, never a verdict: lap time depends on fuel, tyres and weather, so each number carries its conditions.
const crypto = require('crypto');
const { TRACKS } = require('../udp/gameIds');
const { median } = require('../lib/stats');
const { ROWS, compareValues, referenceRows } = require('./setupCompare');

// What makes two setups the same: the garage values and the camber, toe, engine braking and ballast the game also sends.
// Brake bias is left out: it is moved from the wheel lap by lap, and counting it would split one setup into dozens.
const EXTRA_KEYS = ['frontCamber', 'rearCamber', 'frontToe', 'rearToe', 'engineBraking', 'ballast'];
const IDENTITY_KEYS = [...ROWS.map((r) => r.key).filter((k) => k !== 'brakeBias'), ...EXTRA_KEYS];
const DECIMALS = { tyreFront: 1, tyreRear: 1, frontCamber: 2, rearCamber: 2, frontToe: 2, rearToe: 2 };

const MIN_RACE_LAPS = 5; // fewer clean race laps than this is not a pace
const isQuali = (t) => t >= 5 && t <= 14;
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// A short stable key for a setup's values. A value the recording did not have (older rows) is part of the key as "none".
function identity(values) {
  const canon = IDENTITY_KEYS.map((k) => {
    const v = values[k];
    return typeof v === 'number' && Number.isFinite(v) ? round(v, DECIMALS[k] ?? 0) : null;
  });
  return crypto.createHash('sha1').update(JSON.stringify(canon)).digest('hex').slice(0, 12);
}

const clean = (l, isRace) => l.valid !== false && !l.pit && !l.neutralised && l.lapMs > 0 && !(isRace && l.lapNum === 1);
const uniq = (xs) => [...new Set(xs)].sort((a, b) => a - b);
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const KIND_LABEL = (type, isRace) => (isRace ? 'Race' : isQuali(type) ? 'Qualifying' : 'Practice');

function statsOf(sessions) {
  const q = [];
  const r = [];
  const race = [];
  const compounds = [];
  const fuel = [];
  const temps = [];
  const weathers = [];
  for (const s of sessions) {
    q.push(...(isQuali(s.sessionType) ? s.laps : []));
    r.push(...(!isQuali(s.sessionType) ? s.laps : []));
    race.push(...(s.isRace ? s.laps : []));
    for (const l of s.laps) {
      if (l.compound != null) compounds.push(l.compound);
      if (s.isRace && typeof l.fuelKg === 'number') fuel.push(l.fuelKg);
    }
    temps.push(...s.trackTemps);
    weathers.push(...s.weathers);
  }
  const best = (ls) => (ls.length ? Math.min(...ls.map((l) => l.lapMs)) : null);
  const med = (ls) => (ls.length ? median(ls.map((l) => l.lapMs)) : null);
  return {
    bestQ: best(q), medianQ: med(q), cleanLapsQ: q.length,
    bestR: best(r), medianR: med(r), cleanLapsR: r.length,
    raceLaps: race.length, racePaceMs: race.length >= MIN_RACE_LAPS ? med(race) : null,
    avgRaceFuelKg: fuel.length ? round(fuel.reduce((a, b) => a + b, 0) / fuel.length, 1) : null,
    compounds: uniq(compounds),
    trackTempMin: temps.length ? Math.min(...temps) : null, trackTempMax: temps.length ? Math.max(...temps) : null,
    weathers: uniq(weathers),
  };
}

const TRACK_ID = Object.fromEntries(Object.entries(TRACKS).map(([id, name]) => [name, Number(id)]));

// The sheet's setup for a circuit as values by key, for qualifying ('q') or the race ('r'). A range (brake bias) keeps its low end
// as the value and the whole range in valueText.
function sheetValues(circuit, k) {
  const values = {};
  const valueText = {};
  for (const row of ROWS) {
    const t = row.want(circuit, k);
    values[row.key] = t ? t.lo : null;
    if (t && t.lo !== t.hi) valueText[row.key] = `${t.lo}-${t.hi}`;
  }
  return { values, valueText };
}

// The sheet's own setups as the recommended defaults for a track: qualifying and race, or one if they are the same.
function recommendedSetups(circuit, trackId) {
  const q = sheetValues(circuit, 'q');
  const r = sheetValues(circuit, 'r');
  const same = ROWS.every((row) => q.values[row.key] === r.values[row.key] && q.valueText[row.key] === r.valueText[row.key]);
  const make = (kind, name, v) => ({
    key: `sheet-${kind}`, trackId, recommended: true, kind, orphan: false, values: v.values, valueText: v.valueText, autoName: name, name, named: true,
    favorite: false, note: '', updatedAt: null, firstAt: null, lastAt: null, sessions: [], stats: statsOf([]), sheetOff: null, vsSheet: null,
  });
  return same ? [make('q', 'Recommended', q)] : [make('q', 'Recommended · Qualifying', q), make('r', 'Recommended · Race', r)];
}

// The setup against the sheet's circuit: how many values differ, and the rows (right, wrong, which way) for each kind.
const vsSheet = (values, circuit) => {
  if (!circuit) return null;
  const q = compareValues(values, circuit, 'q');
  const r = compareValues(values, circuit, 'r');
  return { off: { q: q.off, r: r.off }, rows: { q: q.rows, r: r.rows } };
};

// sessions: the store's setupLibrarySessions rows; notes: its setup_note rows; sheet: { game, circuits } or null.
// Returns [{ trackId, track, circuit, favorites, lastAt, setups }], most recently driven track first.
function buildLibrary({ sessions, notes = [], sheet = null }) {
  const tracks = new Map(); // trackId -> Map(key -> setup)
  const setupsOf = (trackId) => {
    if (!tracks.has(trackId)) tracks.set(trackId, new Map());
    return tracks.get(trackId);
  };

  for (const s of sessions) {
    const runs = [...s.runs].sort((a, b) => a.fromLap - b.fromLap);
    if (!runs.length) continue;
    const temps = s.weather.map((w) => w.trackTemp).filter((v) => typeof v === 'number');
    const weathers = s.weather.map((w) => w.weather).filter((v) => typeof v === 'number');
    // The run in force on each lap: the last one that started on or before it.
    const perKey = new Map();
    for (const l of s.laps) {
      if (!clean(l, s.isRace)) continue;
      const run = runs.filter((r) => r.fromLap <= l.lapNum).pop() || runs[0];
      const key = identity(run.setup);
      if (!perKey.has(key)) perKey.set(key, { run, laps: [] });
      perKey.get(key).laps.push(l);
    }
    // A run with no clean lap still counts as having been run.
    for (const run of runs) {
      const key = identity(run.setup);
      if (!perKey.has(key)) perKey.set(key, { run, laps: [] });
    }
    for (const [key, { run, laps }] of perKey) {
      const map = setupsOf(s.trackId);
      if (!map.has(key)) map.set(key, { key, trackId: s.trackId, track: s.track, values: run.setup, sessions: [], pieces: [] });
      const entry = map.get(key);
      entry.sessions.push({
        uid: s.uid, sessionId: s.sessionId, startedAt: s.startedAt, name: s.name, sessionType: s.sessionType, isRace: s.isRace, grid: s.grid, finish: s.finish,
        cleanLaps: laps.length, bestMs: laps.length ? Math.min(...laps.map((l) => l.lapMs)) : null,
        medianMs: laps.length ? median(laps.map((l) => l.lapMs)) : null, compounds: uniq(laps.map((l) => l.compound).filter((c) => c != null)),
        brakeBias: run.setup.brakeBias ?? null,
      });
      entry.pieces.push({ sessionType: s.sessionType, isRace: s.isRace, laps, trackTemps: temps, weathers });
    }
  }

  const noteOf = new Map(notes.map((n) => [`${n.trackId}:${n.key}`, n]));
  // A setup you named or starred outlives its sessions; an unmarked one with no sessions is not in the library.
  for (const n of notes) {
    if (!n.name && !n.favorite && !n.note) continue;
    const map = setupsOf(n.trackId);
    if (!map.has(n.key)) map.set(n.key, { key: n.key, trackId: n.trackId, track: TRACKS[n.trackId] || null, values: n.values, sessions: [], pieces: [], orphan: true });
  }

  const out = [];
  for (const [trackId, map] of tracks) {
    const track = TRACKS[trackId] || null;
    const circuit = sheet && track ? sheet.circuits.find((c) => c.track === track) : null;
    const setups = [...map.values()].map((e) => {
      const n = noteOf.get(`${trackId}:${e.key}`);
      const sessionsNewestFirst = [...e.sessions].sort((a, b) => b.startedAt - a.startedAt);
      const firstAt = e.sessions.length ? Math.min(...e.sessions.map((x) => x.startedAt)) : null;
      const first = [...e.sessions].sort((a, b) => a.startedAt - b.startedAt)[0];
      const cmp = vsSheet(e.values, circuit);
      return {
        key: e.key, trackId, values: e.values, orphan: !!e.orphan,
        autoName: first ? `${track || 'Track'} · ${DAY.format(new Date(first.startedAt))} · ${KIND_LABEL(first.sessionType, first.isRace)}` : `${track || 'Track'} setup`,
        name: null, named: false,
        favorite: !!(n && n.favorite), note: (n && n.note) || '', updatedAt: n ? n.updatedAt : null,
        firstAt, lastAt: sessionsNewestFirst.length ? sessionsNewestFirst[0].startedAt : null,
        sessions: sessionsNewestFirst,
        stats: statsOf(e.pieces.map((p) => ({ ...p, laps: p.laps }))),
        sheetOff: cmp ? cmp.off : null,
        vsSheet: cmp ? cmp.rows : null,
        _typedName: n && n.name ? n.name : '',
      };
    });
    // Names: yours, or the generated one, made unique within the track.
    const seen = new Map();
    setups.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
    for (const s of setups) {
      if (s._typedName) {
        s.name = s._typedName;
        s.named = true;
      } else {
        const n = (seen.get(s.autoName) || 0) + 1;
        seen.set(s.autoName, n);
        s.name = n === 1 ? s.autoName : `${s.autoName} (${n})`;
      }
      delete s._typedName;
    }
    setups.sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.lastAt ?? 0) - (a.lastAt ?? 0));
    out.push({ trackId, track, circuit: circuit ? circuit.circuit : null, reference: circuit ? { q: referenceRows(circuit, 'q'), r: referenceRows(circuit, 'r'), notes: circuit.notes || null } : null, favorites: setups.filter((s) => s.favorite).length, lastAt: Math.max(...setups.map((s) => s.lastAt ?? 0)), setups });
  }
  // Every track in the sheet is in the library, driven or not, with the sheet's setups first as the recommended defaults.
  for (const circuit of sheet ? sheet.circuits : []) {
    const trackId = TRACK_ID[circuit.track];
    if (trackId == null) continue; // a circuit the game has no track id for yet
    let t = out.find((x) => x.trackId === trackId);
    if (!t) {
      t = { trackId, track: circuit.track, circuit: circuit.circuit, reference: { q: referenceRows(circuit, 'q'), r: referenceRows(circuit, 'r'), notes: circuit.notes || null }, favorites: 0, lastAt: 0, setups: [] };
      out.push(t);
    }
    t.setups.unshift(...recommendedSetups(circuit, trackId));
  }
  // The tracks you have driven first, most recent first; then the rest of the sheet's, by name.
  return out.sort((a, b) => b.lastAt - a.lastAt || String(a.track).localeCompare(String(b.track)));
}

module.exports = { identity, buildLibrary, IDENTITY_KEYS, MIN_RACE_LAPS };
