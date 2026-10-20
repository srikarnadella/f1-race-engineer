const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { syntheticPackets, replay } = require('./helpers/synthetic');

// The contract between the server's snapshot and the dashboard: every widget,
// fed real snapshots, renders without throwing and never shows a placeholder
// for a missing field. The dashboard swallows a widget's error (one bad card
// must not blank the screen), so without this a renamed field fails silently.
// Compiled once each with their filenames, so coverage counts them as public/widgets.js and public/debrief.js.
const WIDGETS_JS = ['widgets.js', 'debrief.js'].map((f) => {
  const file = path.join(__dirname, '..', 'public', f);
  return new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
});
const LEAKS = /undefined|NaN|\bnull\b|\[object Object\]|Infinity/;

function dashboard(api = () => null) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const { window } = dom;
  window.fetch = async (url) => {
    const u = new URL(url, 'http://localhost');
    const body = api(u.pathname, u.searchParams);
    return { ok: !!body, status: body ? 200 : 404, json: async () => body };
  };
  for (const s of WIDGETS_JS) s.runInContext(dom.getInternalVMContext());
  const mounted = Object.entries(window.RaceWidgets.widgets).map(([id, def]) => {
    const card = window.document.createElement('section');
    card.className = `card card--${id}`;
    const body = window.document.createElement('div');
    card.append(body);
    window.document.body.append(card);
    return { id, card, update: def.mount(body) };
  });
  return { window, mounted };
}

// As the dashboard does: widgets other than these wait for the player's car.
const NO_PLAYER_OK = new Set(['radio', 'session', 'debrief']);

function render(d, snap, label) {
  for (const w of d.mounted) {
    if (!snap.player && !NO_PLAYER_OK.has(w.id)) continue;
    assert.doesNotThrow(() => w.update(snap), `${w.id} threw at ${label}`);
    const text = w.card.textContent;
    const leak = text.match(LEAKS);
    assert.ok(!leak, `${w.id} shows "${leak && leak[0]}" at ${label}: ...${leak && text.slice(Math.max(0, leak.index - 60), leak.index + 20)}...`);
  }
}

// Records every property path a widget reads ("player.paceMs",
// "nearby[].gapToPlayerMs"): 'missing' until the snapshot has the key,
// 'empty' while it is only ever null, 'set' once it held a value.
function tracked(value, path, reads) {
  if (!value || typeof value !== 'object') return value;
  return new Proxy(value, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver);
      if (typeof key === 'symbol' || typeof v === 'function' || key === 'toJSON') return v; // toJSON: JSON.stringify probing
      const p = Array.isArray(target) && /^\d+$/.test(key) ? `${path}[]` : `${path}.${key}`;
      if (!Object.prototype.hasOwnProperty.call(target, key)) {
        if (!reads.has(p)) reads.set(p, 'missing');
      } else if (v != null) reads.set(p, 'set');
      else if (reads.get(p) !== 'set') reads.set(p, 'empty');
      return tracked(v, p, reads);
    },
  });
}

function monacoFrames() {
  const file = path.join(__dirname, '..', 'site', 'race-data', 'snapshots.json.gz');
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
}

// Read by a widget but null all through the synthetic race, which has none of these yet.
const NOT_IN_THE_SYNTHETIC_RACE = [
  '$.analysis.pitTiming.wear.toInLaps (empty)', // at the slow-wear end the pick is always 'stay out' ("or later")
  '$.analysis.options (empty)', // safety-car options: it has a VSC, and they are for a full safety car
  '$.analysis.damage.lossPerLapMs (empty)', // no wing damage
  '$.analysis.quali (empty)', // a race, not qualifying
  '$.analysis.racePlan (empty)', // shown on the grid; it starts mid-race
  '$.analysis.weather.crossover.wetGainMs (empty)', // nobody switched to wets
  '$.debrief.sessions[].fieldBestSectors[] (empty)', // the synthetic race has no Session History packets
  '$.debrief.sessions[].points (empty)', // ...nor a final classification
  '$.debrief.sessions[].positionChart (empty)', // ...nor Lap Positions
];

test('dashboard: every field a widget reads exists in the snapshot the server builds', () => {
  // A path read but never present (or never anything but null) is a field
  // the server doesn't send: a rename on one side, and a card that stays blank.
  // Judged only on snapshots this code builds - the committed Monaco frames
  // were built by an earlier server and would hide a rename.
  const reads = new Map();
  const d = dashboard();
  const show = (snap) => {
    const t = tracked(snap, '$', reads);
    for (const w of d.mounted) if (snap.player || NO_PLAYER_OK.has(w.id)) w.update(t);
  };
  replay(syntheticPackets(), {
    onTick: ({ tMs, snap }) => {
      if (tMs % 1000 < 100 || 'debrief' in snap) show(snap);
    },
  });
  const never = [...reads].filter(([, state]) => state !== 'set').map(([p, state]) => `${p} (${state})`).sort();
  assert.deepStrictEqual(never, NOT_IN_THE_SYNTHETIC_RACE.sort());
});

test('dashboard: every widget renders every 2 s of the synthetic race without a leak', () => {
  const d = dashboard();
  let n = 0;
  replay(syntheticPackets(), {
    onTick: ({ tMs, snap }) => {
      if (tMs % 2000 < 100) {
        render(d, snap, `${(tMs / 1000).toFixed(1)} s`);
        n++;
      }
    },
  });
  assert.ok(n > 100, `${n} snapshots rendered`);
});

test('dashboard: every widget renders the recorded Monaco race (real game data) without a leak', () => {
  const d = dashboard();
  monacoFrames().forEach((f, i) => {
    if (i % 5 === 0) render(d, f.s, `frame ${i}`);
  });
});

test('dashboard: before any packet (no player, no session) the always-on widgets still render', () => {
  const d = dashboard();
  const p = replay([]);
  render(d, p.tick(), 'startup');
  render(d, { connected: false, updatedAtMs: 0, session: null, player: null, nearby: [], field: [], analysis: null, insights: [], strategy: null }, 'disconnected');
});

test('debrief: each view (summary, lap compare, rivals, calls, models) renders from the bridge API without a leak', async () => {
  // A finished stint, then the debrief screens as the bridge serves them.
  const p = replay(syntheticPackets());
  let snap = p.tick();
  while (!snap.debrief) snap = p.tick(); // the debrief rides every 10th tick
  assert.ok(snap.debrief.sessions.length, 'a session in the debrief');
  const api = (pathname, q) => {
    const lap = (k) => (q.get(k) ? Number(q.get(k)) : null);
    if (pathname === '/api/debrief/compare') return p.debrief.compare(q.get('session'), lap('a'), q.get('b') && /^r\d+$/.test(q.get('b')) ? q.get('b') : lap('b'));
    if (pathname === '/api/debrief/rivals') return p.debrief.rivals(q.get('session'));
    if (pathname === '/api/debrief/audit') return p.debrief.audit(q.get('session'));
    if (pathname === '/api/models') return { overtake: null, tyre: snap.analysis && snap.analysis.tyreModel };
    return null;
  };
  const d = dashboard(api);
  const deb = d.mounted.find((w) => w.id === 'debrief');
  deb.update(snap);
  const buttons = [...deb.card.querySelectorAll('.w-deb__views button')];
  assert.deepStrictEqual(buttons.map((b) => b.textContent), ['Summary', 'Lap compare', 'Rivals', 'Calls', 'Models']);
  for (const b of buttons) {
    b.click();
    deb.update(snap);
    await new Promise((resolve) => setTimeout(resolve, 0)); // the fetch
    const text = deb.card.textContent;
    assert.ok(!/Couldn't reach the bridge/.test(text), `${b.textContent}: the API call failed`);
    // The calls audit: the summary, and each graded call with what happened.
    if (b.textContent === 'Calls') {
      const a = p.debrief.audit(snap.debrief.sessions[0].id);
      assert.ok(a.calls.length && text.includes(`Right${a.summary.right}`) && text.includes(a.calls[0].why), text.slice(0, 300));
    }
    const leak = text.match(LEAKS);
    assert.ok(!leak, `${b.textContent} shows "${leak && leak[0]}": ...${leak && text.slice(Math.max(0, leak.index - 60), leak.index + 20)}...`);
  }
});

test('tyre card: the wear rate comes with its 90% range, e.g. "+0.090s (0.071-0.110)"', () => {
  const d = dashboard();
  const card = d.mounted.find((w) => w.id === 'tyrecall');
  let shown = null;
  replay(syntheticPackets(), {
    onTick: ({ snap }) => {
      const tm = snap.analysis && snap.analysis.tyreModel;
      if (shown || !tm || !Object.values(tm.compounds).some((c) => c.ciMs)) return;
      card.update(snap);
      shown = { text: card.card.textContent, tm };
    },
  });
  assert.ok(shown, 'the synthetic race gets a fitted range');
  const [, c] = Object.entries(shown.tm.compounds).find(([, x]) => x.ciMs);
  const s = (ms) => (ms / 1000).toFixed(3);
  assert.ok(shown.text.includes(`+${s(c.degMsPerLap)}s (${s(c.ciMs[0])}–${s(c.ciMs[1])})`), shown.text);
});

test('pit timing card: a pick that depends on tyre wear says so; a firm one adds nothing', () => {
  let snap = null;
  replay(syntheticPackets(), { onTick: ({ snap: s }) => { if (!snap && s.analysis && s.analysis.pitTiming) snap = s; } });
  assert.ok(snap, 'the synthetic race has a pit-timing pick');
  const lap = snap.player.currentLapNum;
  const show = (wear) => {
    const d = dashboard();
    const card = d.mounted.find((w) => w.id === 'pittiming');
    card.update({ ...snap, analysis: { ...snap.analysis, pitTiming: { ...snap.analysis.pitTiming, wear } } });
    return card.card.textContent;
  };
  assert.ok(!/tyre wear/.test(show({ holds: true, fromInLaps: null, toInLaps: null })));
  assert.match(show({ holds: false, fromInLaps: 1, toInLaps: 4 }), new RegExp(`Lap ${lap + 1}–${lap + 4}, depending on tyre wear`));
  assert.match(show({ holds: false, fromInLaps: 2, toInLaps: null }), new RegExp(`Lap ${lap + 2} or later, depending on tyre wear`));
});

test('race plan card: the plan comes with how often it wins the simulated races', () => {
  const { racePlan, planOdds } = require('../src/analysis/racePlan');
  const set = (index, c, life, deltaMs) => ({ index, visualTyreCompound: c, usableLife: life, lifeSpan: life, lapDeltaTimeMs: deltaMs, wear: 0, available: true });
  const inputs = { totalLaps: 30, pitLossMs: 18000, sets: [set(0, 16, 15, -600), set(1, 16, 15, -600), set(2, 17, 20, 0), set(3, 18, 25, 400)], deg: { 16: 150, 17: 90, 18: 60 } };
  const plan = { ...racePlan(inputs), odds: planOdds(inputs, { degSd: { 16: 60, 17: 36, 18: 24 }, pitLossSdMs: 3000 }), degSource: { 16: 'estimate', 17: 'estimate', 18: 'estimate' } };
  let snap = null;
  replay(syntheticPackets().slice(0, 3000), { onTick: ({ snap: s }) => { if (s.player) snap = s; } });
  const d = dashboard();
  const card = d.mounted.find((w) => w.id === 'pittiming');
  card.update({ ...snap, analysis: { ...snap.analysis, pitTiming: null, racePlan: plan } });
  const pct = plan.best.stops === 1 ? plan.odds.oneStopPct : plan.odds.twoStopPct;
  assert.match(card.card.textContent, new RegExp(`wins ${pct}% of 1,000 simulated races`));
});

test('battle card in qualifying: this lap and where you stand, not a car "0.0s behind" (Spa, 20 Oct 2026)', () => {
  let snap = null;
  replay(syntheticPackets(), { onTick: ({ snap: s }) => { if (!snap && s.player && s.strategy) snap = s; } });
  const quali = { status: 'garage', timeLeftS: 135, runs: 1, position: 19, gapToPoleMs: 2259, cut: null, traffic: null, projected: null, toLine: null };
  const card = dashboard().mounted.find((w) => w.id === 'battle');
  card.update({ ...snap, analysis: { ...snap.analysis, quali } });
  const text = card.card.textContent;
  assert.match(text, /This lap/);
  assert.match(text, /In the garage/);
  assert.match(text, /P19/);
  assert.doesNotMatch(text, /Ahead|Behind|Overtake mode/);
});

test('tyre tiles: a set that reaches the flag says so, not "measuring"', () => {
  let snap = null;
  replay(syntheticPackets(), { onTick: ({ snap: s }) => { if (!snap && s.player && s.strategy) snap = s; } });
  const toFlag = { ...snap, strategy: { ...snap.strategy, tyreLapsToCliff: null, tyresReachFlag: true } };
  const d = dashboard();
  for (const id of ['drive', 'tyrecall']) {
    const card = d.mounted.find((w) => w.id === id);
    card.update(toFlag);
    assert.match(card.card.textContent, /to the flag/i, id);
    assert.doesNotMatch(card.card.textContent, /Measuring/, id);
  }
});
