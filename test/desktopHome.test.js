const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');

// The desktop app's Home (public/desktop.js): a landing page that fills the
// window, with one way into each part of the app. window.undercut is the
// app's bridge (desktop/preload.js); here a fake that answers like an idle PC.
function fakeApi() {
  const status = { version: '0.1.0', mode: 'live', replay: null, recording: null, settings: { httpPort: 8080, udpPort: 20777, share: false, phoneVoice: false }, pairUrl: null, addresses: [], clients: 1, dataDir: 'C:/data', analyzing: [] };
  const ok = async () => status;
  return { status: ok, setSettings: ok, record: ok, stopRecording: ok, replay: ok, live: ok, captures: async () => [], analyze: ok, deleteCapture: ok, deleteSession: ok, showCapture: ok, openReport: ok, openDataFolder: ok, openInBrowser: ok, speech: { start: ok, stop: ok }, on: () => () => {} };
}
const settle = () => new Promise((r) => setTimeout(r, 10));
// Intervals the page starts, so a test can fire one by hand instead of waiting for it.
function recordIntervals(w, intervals) {
  const set = w.setInterval.bind(w);
  const clear = w.clearInterval.bind(w);
  w.setInterval = (fn, ms, ...a) => { const id = set(fn, ms, ...a); intervals.push({ id, fn, ms, cleared: false }); return id; };
  w.clearInterval = (id) => { const i = intervals.find((x) => x.id === id); if (i) i.cleared = true; clear(id); };
}
async function openApp(t, { storage = {} } = {}) {
  const intervals = [];
  const app = open(t, { storage, before: (w) => { w.undercut = fakeApi(); recordIntervals(w, intervals); } });
  await settle();
  const doc = app.window.document;
  const rail = doc.querySelector('.rail');
  const dests = () => [...doc.querySelectorAll('.home__dest')];
  const dest = (name) => dests().find((b) => b.querySelector('.home__name').textContent === name);
  return { ...app, doc, rail, dests, dest, intervals };
}

test('home: the app opens on Home, filling the window with no rail, one way into each part', async (t) => {
  const app = await openApp(t);
  assert.strictEqual(app.rail.hidden, true, 'no dashboard rail around Home');
  assert.deepStrictEqual(app.dests().map((b) => b.querySelector('.home__name').textContent),
    ['Live dashboard', 'Race analysis', 'Setups', 'Ask the race', 'Storage', 'Connect and record']);
  assert.deepStrictEqual(app.errors, []);
});

test('home: Settings opens from Home; Ask the race is one of the places (roadmap L3)', async (t) => {
  const app = await openApp(t);
  [...app.doc.querySelectorAll('.home button')].find((b) => b.textContent === 'Settings').click();
  assert.strictEqual(app.$('settings-sheet').hidden, false);
  assert.strictEqual(app.dest('Ask the race').disabled, false);
});

test('home: one short line of state per destination; the live race shows position, lap and the call', async (t) => {
  const app = await openApp(t);
  app.connect();
  const snap = raceSnapshots().find((s) => s.connected && s.player && s.player.position && s.strategy && s.strategy.call);
  app.send(snap);
  const live = app.dest('Live dashboard').querySelector('.home__state').textContent;
  assert.match(live, new RegExp(`P${snap.player.position}`));
  assert.match(live, new RegExp(`lap ${snap.player.currentLapNum}`));
  assert.match(live, new RegExp(snap.strategy.call.action));
  for (const b of app.dests()) {
    const state = b.querySelector('.home__state').textContent;
    assert.ok(state.length > 0 && state.length <= 48, `${b.querySelector('.home__name').textContent}: "${state}" is one short line`);
  }
  assert.deepStrictEqual(app.errors, []);
});

test('home: a phone or browser on the Wi-Fi gets the dashboard, no Home', (t) => {
  const app = open(t);
  assert.strictEqual(app.window.document.querySelector('.home'), null);
  assert.strictEqual(app.window.document.querySelector('.rail').hidden, false);
  assert.ok(!app.$('settings-sheet').classList.contains('sheet--wide'), 'phones keep the narrow Settings sheet');
});

test('home: in the app, Settings is laid out across the window: toggles, voice commands and this PC side by side', async (t) => {
  const app = await openApp(t);
  const sheet = app.$('settings-sheet');
  assert.ok(sheet.classList.contains('sheet--wide'));
  const col = (el) => el.dataset.col;
  assert.deepStrictEqual([...sheet.querySelectorAll('.setting')].filter((s) => !s.hidden).map(col), ['toggles', 'toggles', 'toggles', 'toggles', 'toggles', 'voice', 'pc', 'pc'], 'units, setup screen, spotter, auto-switch, hands-free; voice commands; this PC, then the keyboard');
});

test('home: the background is a slideshow of real races, each credited while it shows, and it stops when you leave', async (t) => {
  const app = await openApp(t);
  const slides = [...app.doc.querySelectorAll('.home__photo')];
  assert.strictEqual(slides.length, 3);
  for (const img of slides) assert.ok(img.getAttribute('alt').length > 20, 'each photograph says what it shows');
  const shown = () => slides.findIndex((img) => img.classList.contains('is-on'));
  const credit = () => app.doc.querySelector('.home__credit').textContent;
  assert.strictEqual(shown(), 0);
  const first = credit();
  assert.match(first, /CC BY/);

  const timer = app.intervals.find((i) => i.ms === 8000);
  assert.ok(timer, 'a new photograph every 8 s');
  timer.fn();
  assert.strictEqual(shown(), 1);
  assert.notStrictEqual(credit(), first, 'the credit follows the photograph on screen');
  timer.fn();
  timer.fn();
  assert.strictEqual(shown(), 0, 'and wraps around');

  // Minimized or behind the game: nothing changes.
  Object.defineProperty(app.doc, 'hidden', { configurable: true, get: () => true });
  timer.fn();
  assert.strictEqual(shown(), 0);
  Object.defineProperty(app.doc, 'hidden', { configurable: true, get: () => false });

  // Leaving Home stops the slideshow for good.
  app.dest('Live dashboard').click();
  timer.fn();
  assert.strictEqual(timer.cleared, true);
  assert.deepStrictEqual(app.errors, []);
});

const place = (app) => app.doc.querySelector('.place');
const placeTitle = (app) => place(app) && place(app).querySelector('.place__title').textContent;

test('home: every destination but Live dashboard opens a place of its own: the whole window, no dashboard rail, a way back Home', async (t) => {
  const app = await openApp(t);
  for (const name of ['Race analysis', 'Setups', 'Ask the race', 'Storage', 'Connect and record']) {
    app.dest(name).click();
    assert.strictEqual(app.doc.querySelector('.home'), null, `${name}: Home is gone`);
    assert.strictEqual(placeTitle(app), name);
    assert.strictEqual(app.rail.hidden, true, `${name}: not a dashboard tab`);
    place(app).querySelector('.place__back').click();
    assert.ok(app.doc.querySelector('.home'), `${name}: back to Home`);
    assert.strictEqual(app.rail.hidden, true);
  }
  app.dest('Live dashboard').click();
  assert.strictEqual(app.activeTab(), 'Drive');
  assert.strictEqual(app.rail.hidden, false, 'the dashboard is the one with the rail');
  assert.strictEqual(place(app), null);
  assert.deepStrictEqual(app.errors, []);
});

test('home: Esc leaves a place for Home, after closing any open sheet first', async (t) => {
  const app = await openApp(t);
  app.dest('Storage').click();
  app.$('settings').click();
  app.press('Escape');
  assert.strictEqual(app.$('settings-sheet').hidden, true);
  assert.strictEqual(placeTitle(app), 'Storage', 'the first Esc only closed the sheet');
  app.press('Escape');
  assert.ok(app.doc.querySelector('.home'));
});

test('home: the dashboard rail is race screens only, and auto-switch never pulls you out of Home or a place', async (t) => {
  const app = await openApp(t, { storage: { 'raceEngineer.auto': true } });
  app.dest('Live dashboard').click();
  const tabs = [...app.doc.querySelectorAll('.tab')].map((b) => b.textContent.replace(/^\d/, ''));
  assert.deepStrictEqual(tabs, ['Home', 'Drive', 'Battle', 'Strategy', 'Weather', 'Custom']);
  app.press('7');
  assert.strictEqual(app.activeTab(), 'Drive', 'no number key leads out of the dashboard');

  [...app.doc.querySelectorAll('.tab')].find((b) => b.textContent === 'Home').click();
  app.dest('Storage').click();
  app.connect();
  app.send({ ...raceSnapshots()[200], connected: true, focus: { screen: 'battle', reason: 'Car behind within 1 s' } });
  assert.strictEqual(placeTitle(app), 'Storage');
  assert.deepStrictEqual(app.errors, []);
});

test('storage: every saved session on disk is listed, not just the 10 in memory, and an older one can be deleted (roadmap G3)', async (t) => {
  const s = (id, track, day) => ({ id, live: false, startedAt: Date.UTC(2026, 9, day), track, sessionName: 'Race', finish: 5, grid: 8, laps: [], bestLap: null });
  const inMemory = Array.from({ length: 10 }, (_, k) => s(`m${k}`, 'Spa', 20 - k));
  const older = [s('o1', 'Monza', 5), s('o2', 'Imola', 4)];
  const deleted = [];
  const intervals = [];
  const app = open(t, {
    before: (w) => {
      w.undercut = { ...fakeApi(), deleteSession: async (id) => { deleted.push(id); return true; } };
      recordIntervals(w, intervals);
      w.fetch = async (url) => (String(url).endsWith('/api/debrief/older')
        ? { ok: true, json: async () => ({ sessions: older.filter((x) => !deleted.includes(x.id)) }) }
        : { ok: false, json: async () => ({}) });
    },
  });
  await settle();
  app.connect();
  app.send({ ...raceSnapshots()[200], debrief: { sessions: inMemory } });
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.querySelector('.home__name').textContent === 'Storage').click();
  await settle();
  const titles = () => [...doc.querySelectorAll('.pc-row__title')].map((b) => b.textContent).filter((x) => /Race$/.test(x));
  assert.strictEqual(titles().length, 12);
  assert.deepStrictEqual(titles().slice(-2), ['Monza Race', 'Imola Race']);
  const row = [...doc.querySelectorAll('.pc-row')].find((r) => r.textContent.includes('Imola'));
  [...row.querySelectorAll('button')].find((b) => b.textContent === 'Delete').click();
  await settle();
  assert.deepStrictEqual(deleted, ['o2']);
  assert.strictEqual(titles().length, 11);
  assert.deepStrictEqual(app.errors, []);
});

test('storage: Open in Race analysis opens that session, not the newest', async (t) => {
  const s = (id, track, day) => ({ id, live: false, startedAt: Date.UTC(2026, 9, day), track, sessionName: 'Race', isRace: true, finish: 5, grid: 8, laps: [], bestLap: null, stints: [], penalties: [], positionChart: null, field: [], comparable: [] });
  const app = await openApp(t);
  app.connect();
  app.send({ ...raceSnapshots()[200], debrief: { sessions: [s('a', 'Spa', 20), s('b', 'Monza', 10)] } });
  app.dest('Storage').click();
  const row = [...app.doc.querySelectorAll('.pc-row')].find((r) => r.textContent.includes('Monza'));
  [...row.querySelectorAll('button')].find((b) => b.textContent === 'Open in Race analysis').click();
  assert.match(app.doc.querySelector('.ana__title').textContent, /Monza/);
  assert.deepStrictEqual(app.errors, []);
});

test('storage: disk use per store, largest first, and it updates after a delete (roadmap W3)', async (t) => {
  let use = { raceDb: 19.6e6, sessions: 2.2e6, captures: 410e6, other: 70e3, total: 19.6e6 + 2.2e6 + 410e6 + 70e3 };
  const app = open(t, {
    before: (w) => {
      w.undercut = {
        ...fakeApi(),
        diskUse: async () => use,
        captures: async () => [{ name: 'rec1', bytes: 410e6, startedAt: Date.UTC(2026, 9, 1), marks: 0, track: 'Spa', session: 'Race', report: null }],
        deleteCapture: async () => { use = { ...use, captures: 0, total: use.total - use.captures }; return true; },
      };
    },
  });
  await settle();
  app.connect();
  app.send({ ...raceSnapshots()[200], debrief: { sessions: [] } });
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.querySelector('.home__name').textContent === 'Storage').click();
  await settle();
  const rows = () => [...doc.querySelectorAll('.disk__row')].map((r) => [r.querySelector('.disk__name').textContent, r.querySelector('.disk__size').textContent]);
  assert.deepStrictEqual(rows(), [['Recordings', '410 MB'], ['Race store', '20 MB'], ['Saved sessions', '2 MB'], ['Other', '70 KB']]);
  assert.match(doc.querySelector('.disk__total').textContent, /432 MB/);
  const rec = [...doc.querySelectorAll('.pc-row')].find((r) => r.textContent.includes('Spa'));
  [...rec.querySelectorAll('button')].find((b) => b.textContent === 'Delete').click();
  await settle();
  assert.deepStrictEqual(rows().map((r) => r[0]), ['Race store', 'Saved sessions', 'Other'], 'an empty store drops out');
  assert.deepStrictEqual(app.errors, []);
});

test('storage: the downloaded models are a row of their own, from Ollama (roadmap W3)', async (t) => {
  const use = { raceDb: 20e6, sessions: 2e6, captures: 0, other: 0, total: 22e6 };
  const app = open(t, {
    before: (w) => {
      w.undercut = { ...fakeApi(), diskUse: async () => use, llm: { models: async () => [{ name: 'qwen3:1.7b', size: 1.36e9 }, { name: 'qwen3:4b', size: 2.5e9 }] } };
    },
  });
  await settle();
  app.connect();
  app.send({ ...raceSnapshots()[200], debrief: { sessions: [] } });
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.querySelector('.home__name').textContent === 'Storage').click();
  await settle();
  const row = [...doc.querySelectorAll('.disk__row')].find((r) => r.querySelector('.disk__name').textContent === 'Models');
  assert.ok(row, 'a Models row');
  assert.strictEqual(row.querySelector('.disk__size').textContent, '3.9 GB');
  assert.match(row.textContent, /2 models, kept by Ollama/);
  assert.deepStrictEqual(app.errors, []);
});

test('home: the Storage line counts every saved session, the older ones on disk too', async (t) => {
  const s = (id, day) => ({ id, live: false, startedAt: Date.UTC(2026, 9, day), track: 'Spa', sessionName: 'Race', finish: 5, grid: 8, laps: [], bestLap: null });
  const app = open(t, {
    before: (w) => {
      w.undercut = fakeApi();
      w.fetch = async (url) => (String(url).endsWith('/api/debrief/older') ? { ok: true, json: async () => ({ sessions: [s('o1', 1), s('o2', 2)] }) } : { ok: false, json: async () => ({}) });
    },
  });
  await settle();
  app.connect();
  app.send({ ...raceSnapshots()[200], debrief: { sessions: Array.from({ length: 10 }, (_, k) => s(`m${k}`, 10 + k)) } });
  await settle();
  const storage = [...app.window.document.querySelectorAll('.home__dest')].find((b) => b.querySelector('.home__name').textContent === 'Storage');
  assert.match(storage.textContent, /12 sessions/);
});

test('storage: each saved session has a "learn from this" switch, shown only for sessions the race store holds (roadmap K2)', async (t) => {
  const s = (id, track, day) => ({ id, live: false, startedAt: Date.UTC(2026, 9, day), track, sessionName: 'Race', finish: 5, grid: 8, laps: [], bestLap: null });
  const flags = { a: true, b: false }; // c is a session the race store doesn't hold
  const calls = [];
  const app = open(t, {
    before: (w) => {
      w.undercut = {
        ...fakeApi(),
        learnFlags: async (ids) => Object.fromEntries(ids.filter((id) => id in flags).map((id) => [id, flags[id]])),
        setLearn: async (id, on) => { calls.push([id, on]); flags[id] = on; return true; },
      };
    },
  });
  await settle();
  app.connect();
  app.send({ ...raceSnapshots()[200], debrief: { sessions: [s('a', 'Spa', 20), s('b', 'Monza', 10), s('c', 'Imola', 5)] } });
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.querySelector('.home__name').textContent === 'Storage').click();
  await settle();
  const rowOf = (track) => [...doc.querySelectorAll('.pc-row')].find((r) => r.textContent.includes(track));
  const learnBtn = (track) => [...rowOf(track).querySelectorAll('button')].find((b) => /^Learn from this/.test(b.textContent));
  assert.strictEqual(learnBtn('Spa').textContent, 'Learn from this: on');
  assert.strictEqual(learnBtn('Monza').textContent, 'Learn from this: off');
  assert.strictEqual(learnBtn('Imola'), undefined, 'no switch without a row in the race store');
  learnBtn('Spa').click();
  await settle();
  assert.deepStrictEqual(calls, [['a', false]]);
  assert.strictEqual(learnBtn('Spa').textContent, 'Learn from this: off');
  learnBtn('Monza').click();
  await settle();
  assert.deepStrictEqual(calls[1], ['b', true]);
  assert.strictEqual(learnBtn('Monza').textContent, 'Learn from this: on');
  assert.deepStrictEqual(app.errors, []);
});

test('storage: a recording\'s packets can be dropped, one by one or by age, and a recording without them offers neither replay nor analyze (roadmap Q7)', async (t) => {
  const cap = (name, packets) => ({ name, bytes: 5e8, startedAt: Date.UTC(2026, 8, 1), marks: 0, report: packets ? null : { checks: [], laps: 3, marks: [], durationS: 600 }, track: 'Spa', session: 'Race', packets });
  let list = [cap('2026-09-01_100000', true), cap('2026-08-01_100000', false)];
  const calls = [];
  const app = open(t, {
    before: (w) => {
      w.undercut = {
        ...fakeApi(),
        captures: async () => list,
        dropPackets: async (name) => { calls.push(['one', name]); list = list.map((c) => (c.name === name ? cap(name, false) : c)); return true; },
        dropOldPackets: async (days) => { calls.push(['old', days]); return { count: 1, bytes: 5e8 }; },
      };
    },
  });
  await settle();
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.querySelector('.home__name').textContent === 'Storage').click();
  await settle();
  const rows = () => [...doc.querySelectorAll('#storage-recordings .pc-row, .pc-lib__col .pc-row')].filter((r) => /Spa/.test(r.textContent));
  const labels = (r) => [...r.querySelectorAll('button')].map((b) => b.textContent);
  const [withPackets, without] = rows();
  assert.ok(labels(withPackets).includes('Replay') && labels(withPackets).includes('Drop packets'));
  assert.ok(!labels(without).includes('Replay') && !labels(without).includes('Analyze') && !labels(without).includes('Drop packets'), labels(without).join());
  assert.match(without.textContent, /packets dropped/);
  [...withPackets.querySelectorAll('button')].find((b) => b.textContent === 'Drop packets').click();
  await settle();
  assert.deepStrictEqual(calls[0], ['one', '2026-09-01_100000']);
  assert.ok(!labels(rows()[0]).includes('Replay'), 'the row updates');
  [...doc.querySelectorAll('button')].find((b) => /^Drop packets older than 30 days/.test(b.textContent)).click();
  await settle();
  assert.deepStrictEqual(calls[1], ['old', 30]);
  assert.deepStrictEqual(app.errors, []);
});

test('settings: "Check for updates" asks only when pressed, and offers the download page only for a newer version (roadmap S2)', async (t) => {
  let asked = 0;
  let opened = 0;
  let answer = { current: '0.1.0', latest: '0.2.0', newer: true };
  const app = open(t, { before: (w) => { w.undercut = { ...fakeApi(), checkUpdate: async () => { asked++; return answer; }, openUpdate: async () => { opened++; return true; } }; } });
  await settle();
  const doc = app.window.document;
  assert.strictEqual(asked, 0, 'nothing is asked at start-up');
  app.$('settings').click();
  const btn = () => [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Check for updates');
  assert.ok(btn());
  assert.strictEqual(asked, 0, 'nor on opening Settings');
  btn().click();
  await settle();
  assert.strictEqual(asked, 1);
  assert.match(doc.querySelector('.setting--pc').textContent, /Version 0\.2\.0 is out \(this is 0\.1\.0\)/);
  [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Open the download page').click();
  assert.strictEqual(opened, 1);
  answer = { current: '0.1.0', latest: '0.1.0', newer: false };
  btn().click();
  await settle();
  assert.match(doc.querySelector('.setting--pc').textContent, /You have the latest version \(0\.1\.0\)/);
  assert.ok(![...doc.querySelectorAll('button')].some((b) => b.textContent === 'Open the download page'));
  assert.deepStrictEqual(app.errors, []);
});

test('settings: "Import setups" picks the spreadsheet through the PC, shows what was imported, and says why when it cannot (setup lab)', async (t) => {
  let picked = 0;
  let reply = { game: 'F1 26', circuits: 24 };
  const withStatus = { ...fakeApi() };
  const app = open(t, {
    before: (w) => {
      w.undercut = {
        ...withStatus,
        status: async () => ({ ...(await withStatus.status()), setups: null }),
        importSetups: async () => { picked++; if (reply instanceof Error) throw reply; return reply; },
      };
    },
  });
  await settle();
  const doc = app.window.document;
  app.$('settings').click();
  const note = () => doc.querySelector('.setup-sheet__note').textContent;
  const btn = () => [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Import setups');
  assert.ok(btn());
  assert.match(note(), /No setup sheet yet/);
  assert.strictEqual(picked, 0, 'nothing happens until it is pressed');
  btn().click();
  await settle();
  assert.strictEqual(picked, 1);
  assert.match(note(), /24 circuits from F1 26/);
  reply = new Error('That is not a spreadsheet Undercut can read');
  btn().click();
  await settle();
  assert.match(note(), /not a spreadsheet/);
  reply = null; // the dialog was cancelled
  btn().click();
  await settle();
  assert.match(note(), /not a spreadsheet/, 'a cancelled dialog changes nothing on screen');
  assert.deepStrictEqual(app.errors, []);
});
