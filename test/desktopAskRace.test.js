const test = require('node:test');
const assert = require('node:assert');
const { open } = require('./helpers/dashboard');
const { MODELS } = require('../src/llm/catalog');

// Ask the race (public/askrace.js, roadmap L3): its own place, the "not while racing" notice first,
// then Ollama and the models: download with progress, cancel, delete. window.undercut.llm is the
// app's bridge to Ollama (desktop/preload.js); here a fake.
function fakeApi({ installed = true, models = ['qwen3:4b'] } = {}) {
  const status = { version: '0.1.0', mode: 'live', replay: null, recording: null, settings: { httpPort: 8080, udpPort: 20777, share: false, phoneVoice: false }, pairUrl: null, addresses: [], clients: 1, dataDir: 'C:/data', analyzing: [] };
  const ok = async () => status;
  const handlers = {};
  const calls = [];
  let have = [...models];
  // The app's download list (main process): it outlives the page.
  let downloads = [];
  const emit = () => handlers.llm && handlers.llm({ kind: 'downloads', downloads: downloads.map((d) => ({ ...d })) });
  const setDl = (model, patch) => {
    downloads = downloads.some((d) => d.model === model) ? downloads.map((d) => (d.model === model ? { ...d, ...patch } : d)) : [...downloads, { model, fraction: 0, completed: 0, total: 2.0e9, error: null, ...patch }];
    emit();
  };
  const llm = {
    status: async () => (installed ? { installed: true, version: '0.12.3', live: false, busy: false } : { installed: false, installUrl: 'https://ollama.com/download', live: false, busy: false }),
    catalog: async () => MODELS,
    models: async () => have.map((name) => ({ name, size: 2e9 })),
    pull: async (id) => { calls.push(['pull', id]); setDl(id, { state: 'downloading', fraction: 0 }); return new Promise(() => {}); },
    cancelPull: async (id) => { calls.push(['cancel', id]); setDl(id, { state: 'cancelled' }); },
    downloads: async () => downloads.map((d) => ({ ...d })),
    clearDownloads: async () => { downloads = downloads.filter((d) => d.state === 'downloading'); emit(); },
    remove: async (id) => { calls.push(['remove', id]); have = have.filter((x) => x !== id); return true; },
    // Questions (L5): the sessions in race.db, the answer with its chart and evidence, chart commands.
    sessions: async () => SESSIONS,
    results: async () => [{ position: 3, driver: 'LECLERC', you: false }, { position: 4, driver: 'YOU', you: true }, { position: 5, driver: 'ANTONELLI', you: false }],
    ask: async (model, sessionId, question) => { calls.push(['ask', model, sessionId, question]); return answer(question); },
    chart: async (sessionId, kind, args) => { calls.push(['chart', sessionId, kind, args]); return { ...CHART, kind, title: `Chart ${kind}` }; },
    insight: async (sessionId, kind) => { calls.push(['insight', sessionId, kind]); return kind === 'history' ? { title: 'Your races here', error: 'Track history compares races; this session is not a race', lines: [], charts: [] } : { title: 'Pit stops', lines: ['Stop 1: in on lap 7, out on lap 8, medium to hard.', 'It cost 15.7 s against the cars that did not stop on those laps.'], charts: kind === 'tyres' ? [STINT_CHART] : [] }; },
    stop: async () => { calls.push(['stop']); },
  };
  return {
    api: { status: ok, setSettings: ok, record: ok, stopRecording: ok, replay: ok, live: ok, captures: async () => [], analyze: ok, deleteCapture: ok, deleteSession: ok, showCapture: ok, openReport: ok, openDataFolder: ok, openInBrowser: ok, speech: { start: ok, stop: ok }, llm, on: (ch, fn) => { handlers[ch] = fn; return () => {}; } },
    handlers,
    calls,
    progress: (id, fraction) => setDl(id, { fraction, completed: fraction * 2.0e9 }),
    finish: (id) => { have.push(id); setDl(id, { state: 'done', fraction: 1 }); },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 15));

const SESSIONS = [
  { session_id: 21, track: 'Spa', type: 'Short qualifying', is_race: false, date: '2026-10-20', finish: 19 },
  { session_id: 19, track: 'Silverstone', type: 'Race', is_race: true, date: '2026-10-19', grid: 10, finish: 4 },
];
const CHART = {
  kind: 'positions', title: 'Your position, lap by lap', x: { label: 'Lap' }, y: { label: 'Position', invert: true },
  series: [{ name: 'You', you: true, points: [[1, 4], [2, 3], [3, 3], [4, 4]] }, { name: 'LECLERC', points: [[1, 3], [2, 4], [3, 4], [4, 3]] }],
  marks: [{ x: 3, label: 'Pit' }], finding: 'P4 to P4 from lap 1 to lap 4; highest P3 (lap 2).',
};
// A gap chart whose trend (laps 2-4) carries the range it could be (engine: src/llm/charts.js).
const GAP_CHART = {
  kind: 'gap_to_driver', title: 'Gap to LECLERC', x: { label: 'Lap' }, y: { label: 'Seconds behind LECLERC (below 0: ahead)', zero: true },
  series: [{ name: 'You to LECLERC', you: true, points: [[1, 2.0], [2, 2.4], [3, 2.6], [4, 3.1]] }], marks: [],
  bands: [{ label: 'Trend and the range it could be', from: 1, to: 4, slope: 0.34, slopeLo: 0.2, slopeHi: 0.48, line: [[1, 2.0], [2, 2.34], [3, 2.68], [4, 3.02]], band: [[1, 1.7, 2.3], [2, 2.1, 2.58], [3, 2.4, 2.96], [4, 2.7, 3.34]] }],
  finding: 'Against LECLERC: 2.000 s behind after lap 1, 3.100 s behind after lap 4. You lost 0.34 s a lap to LECLERC over laps 1-4 (80% sure it was between 0.20 and 0.48 s).',
};
// A stint-pace chart: each stint its own colour and its own trend with the range it could be.
const STINT_CHART = {
  kind: 'stint_pace', title: 'Lap time by tyre stint', x: { label: 'Lap' }, y: { label: 'Lap time (s)' },
  series: [{ name: 'Medium, laps 2-6', tone: 'is-you', points: [[2, 80.0], [3, 80.1], [4, 80.2], [5, 80.3], [6, 80.4]] }, { name: 'Hard, laps 9-13', tone: 'is-ref', points: [[9, 79.0], [10, 79.05], [11, 78.98], [12, 79.02], [13, 79.0]] }],
  bands: [
    { label: 'Trend and the range it could be', from: 2, to: 6, slope: 0.1, slopeLo: 0.09, slopeHi: 0.11, line: [[2, 80.0], [6, 80.4]], band: [[2, 79.95, 80.05], [4, 80.18, 80.22], [6, 80.35, 80.45]] },
    { label: 'Trend and the range it could be', from: 9, to: 13, slope: 0, slopeLo: -0.02, slopeHi: 0.02, line: [[9, 79.0], [13, 79.0]], band: [[9, 78.95, 79.05], [13, 78.95, 79.05]] },
  ],
  marks: [{ x: 7, label: 'Pit' }], finding: 'Pace by stint, clean laps only: Medium (laps 2-6): slower by 0.10 s a lap (80% sure between 0.09 and 0.11 s); Hard (laps 9-13): no clear change.',
};
const answer = (q) => (/hold up/.test(q)
  ? { answer: 'The mediums got slower by 0.10 s a lap.', grounded: true, unsupported: [], charts: [STINT_CHART], evidence: [STINT_CHART.finding], toolCalls: [] }
  : /trend/.test(q)
  ? { answer: 'You lost about a third of a second a lap to LECLERC.', grounded: true, unsupported: [], charts: [GAP_CHART], evidence: [`${GAP_CHART.title}: ${GAP_CHART.finding}`], toolCalls: [] }
  : /invent/.test(q)
  ? { answer: 'Your best was 1:29.000.', grounded: false, unsupported: ['1:29.000'], charts: [], evidence: ['Best lap: lap 2, 1:30.948.'], toolCalls: [] }
  : { answer: 'You went from P4 to P3 on lap 2, then back to P4.', grounded: true, unsupported: [], charts: [CHART], evidence: ['At the end of lap 2 you were P3.', `${CHART.title}: ${CHART.finding}`], toolCalls: [] });

async function openAsk(t, opts, snap = { source: 'live', connected: false, debrief: { sessions: [] } }) {
  const fake = fakeApi(opts);
  const app = open(t, { before: (w) => { w.undercut = fake.api; } });
  await settle();
  app.connect();
  app.send(snap);
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Ask the race')).click();
  await settle();
  const row = (id) => doc.querySelector(`.llm__model[data-model="${id}"]`);
  const btn = (id, label) => [...row(id).querySelectorAll('button')].find((b) => b.textContent === label);
  const dl = (id) => doc.querySelector(`.llm__dl[data-model="${id}"]`);
  const go = (name) => [...doc.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith(name)).click();
  return { ...app, doc, fake, row, btn, dl, go };
}

test('ask the race: its own place, and the first thing it says is not to use it while racing', async (t) => {
  const app = await openAsk(t);
  assert.strictEqual(app.doc.querySelector('.place__title').textContent, 'Ask the race');
  assert.match(app.doc.querySelector('.llm__notice').textContent, /Not for use while racing/);
  assert.deepStrictEqual(app.errors, []);
});

test('ask the race: without Ollama, where to get it and nothing to download yet', async (t) => {
  const app = await openAsk(t, { installed: false });
  const link = app.doc.querySelector('a.llm__get');
  assert.strictEqual(link.getAttribute('href'), 'https://ollama.com/download');
  assert.strictEqual(app.doc.querySelectorAll('.llm__model').length, 0);
});

test('ask the race: every model offered, with its size and licence; the downloaded one can be deleted', async (t) => {
  const app = await openAsk(t);
  assert.deepStrictEqual([...app.doc.querySelectorAll('.llm__model')].map((r) => r.dataset.model), MODELS.map((m) => m.id));
  assert.match(app.row('qwen3:1.7b').textContent, /1\.4 GB/);
  assert.strictEqual(app.row('qwen3:1.7b').querySelector('a.llm__licence').textContent, 'Apache 2.0');
  assert.ok(app.btn('qwen3:4b', 'Delete'), 'downloaded');
  assert.ok(app.btn('llama3.2:3b', 'Download'), 'not yet');
});

test('ask the race: a download shows its progress beside the model and in the download manager, and ends as downloaded', async (t) => {
  const app = await openAsk(t);
  assert.match(app.doc.querySelector('.llm__dls').textContent, /Nothing downloading/);
  app.btn('llama3.2:3b', 'Download').click();
  await settle();
  assert.deepStrictEqual(app.fake.calls, [['pull', 'llama3.2:3b']]);
  app.fake.progress('llama3.2:3b', 0.5);
  assert.match(app.row('llama3.2:3b').textContent, /50%/);
  assert.strictEqual(app.row('llama3.2:3b').querySelector('progress').value, 0.5);
  assert.match(app.dl('llama3.2:3b').textContent, /Llama 3.2 3B.*50%.*1.0 of 2.0 GB/);
  app.fake.finish('llama3.2:3b');
  await settle();
  assert.ok(app.btn('llama3.2:3b', 'Delete'));
  assert.match(app.dl('llama3.2:3b').textContent, /Downloaded/);
  app.btn('qwen3:4b', 'Delete').click();
  await settle();
  assert.deepStrictEqual(app.fake.calls[1], ['remove', 'qwen3:4b']);
  assert.ok(app.btn('qwen3:4b', 'Download'));
  assert.deepStrictEqual(app.errors, []);
});

test('ask the race: leaving mid-download and coming back finds it still going, not a fresh Download button', async (t) => {
  const app = await openAsk(t);
  app.btn('phi4-mini', 'Download').click();
  await settle();
  app.fake.progress('phi4-mini', 0.3);
  app.doc.querySelector('.place__back').click();
  app.fake.progress('phi4-mini', 0.4); // it kept going while you were away
  app.go('Ask the race');
  await settle();
  assert.strictEqual(app.btn('phi4-mini', 'Download'), undefined);
  assert.strictEqual(app.row('phi4-mini').querySelector('progress').value, 0.4);
  assert.match(app.dl('phi4-mini').textContent, /40%/);
  assert.deepStrictEqual(app.errors, []);
});

test('ask the race: the download manager cancels a download and clears the finished ones', async (t) => {
  const app = await openAsk(t);
  app.btn('phi4-mini', 'Download').click();
  await settle();
  [...app.dl('phi4-mini').querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
  await settle();
  assert.deepStrictEqual(app.fake.calls[1], ['cancel', 'phi4-mini']);
  assert.match(app.dl('phi4-mini').textContent, /Cancelled/);
  assert.ok(app.btn('phi4-mini', 'Download'), 'can be downloaded again');
  [...app.doc.querySelectorAll('.llm__dls button')].find((b) => b.textContent === 'Clear finished').click();
  await settle();
  assert.strictEqual(app.dl('phi4-mini'), null);
});

test('ask the race: while the game is sending telemetry, downloads wait and it says why', async (t) => {
  const app = await openAsk(t, {}, { source: 'live', connected: true, debrief: { sessions: [] } });
  assert.match(app.doc.querySelector('.llm__manage .llm__live').textContent, /sending telemetry/);
  assert.strictEqual(app.btn('llama3.2:3b', 'Download').disabled, true);
});

test('ask the race: with a model downloaded, ask about the newest race and get the answer, its chart and its evidence (roadmap L5)', async (t) => {
  const app = await openAsk(t);
  const pick = app.doc.querySelector('.llm__session');
  assert.strictEqual(pick.value, '19', 'the newest race, not the qualifying after it');
  assert.strictEqual(app.doc.querySelector('.llm__model-btn').textContent, 'Qwen3 4B', 'the switcher shows the model answering');
  const box = app.doc.querySelector('.llm__question');
  box.value = 'How did my position change?';
  app.doc.querySelector('.llm__ask').click();
  await settle();
  assert.deepStrictEqual(app.fake.calls.find((c) => c[0] === 'ask'), ['ask', 'qwen3:4b', 19, 'How did my position change?']);
  const item = app.doc.querySelector('.llm__answer');
  assert.match(item.querySelector('.llm__q').textContent, /How did my position change/);
  assert.match(item.querySelector('.llm__a').textContent, /P4 to P3 on lap 2/);
  assert.ok(item.querySelector('svg.llm__chart'), 'the chart, drawn');
  assert.match(item.querySelector('.llm__finding').textContent, /highest P3/);
  assert.strictEqual(item.querySelectorAll('.llm__evidence li').length, 2);
  assert.strictEqual(item.querySelector('.llm__unsupported'), null);
  assert.deepStrictEqual(app.errors, []);
});

test('ask the race: an answer with something not in your data says so plainly', async (t) => {
  const app = await openAsk(t);
  app.doc.querySelector('.llm__question').value = 'invent something';
  app.doc.querySelector('.llm__ask').click();
  await settle();
  assert.match(app.doc.querySelector('.llm__unsupported').textContent, /not in your data: 1:29.000/i);
});

test('ask the race: the chart buttons draw straight from the data, no model involved', async (t) => {
  const app = await openAsk(t);
  [...app.doc.querySelectorAll('.llm__chip--chart')].find((b) => b.textContent === 'Positions').click();
  await settle();
  assert.deepStrictEqual(app.fake.calls.filter((c) => c[0] === 'ask'), []);
  assert.strictEqual(JSON.stringify(app.fake.calls.find((c) => c[0] === 'chart')), JSON.stringify(['chart', 19, 'positions', {}])); // the page's {} is another window's object
  assert.ok(app.doc.querySelector('.llm__answer svg.llm__chart'));
  const gap = app.doc.querySelector('.llm__gap-driver');
  assert.deepStrictEqual([...gap.options].map((o) => o.textContent), ['P3 LECLERC', 'P5 ANTONELLI'], 'gap to: the other cars, nearest first');
});

test('ask the race: no question box until a model is downloaded, and none while you race', async (t) => {
  const none = await openAsk(t, { models: [] });
  assert.strictEqual(none.doc.querySelector('.llm__composer').hidden, true, 'nothing to type into');
  assert.match(none.doc.querySelector('.llm__chat').textContent, /Download a model to start/);
  assert.strictEqual(none.doc.querySelector('.llm__manage').hidden, false, 'it opens on the models');
  const live = await openAsk(t, {}, { source: 'live', connected: true, debrief: { sessions: [] } });
  assert.strictEqual(live.doc.querySelector('.llm__ask').disabled, true);
});

test('ask the race: a chat - the question as your message, the answer under it, newest at the bottom', async (t) => {
  const app = await openAsk(t);
  assert.match(app.doc.querySelector('.llm__empty').textContent, /Ask about Silverstone Race/);
  for (const q of ['First?', 'Second?']) {
    app.doc.querySelector('.llm__question').value = q;
    app.doc.querySelector('.llm__ask').click();
    await settle();
  }
  assert.deepStrictEqual([...app.doc.querySelectorAll('.llm__answer .llm__q')].map((x) => x.textContent), ['First?', 'Second?']);
  assert.strictEqual(app.doc.querySelector('.llm__empty').hidden, true, 'the suggestions give way to the conversation');
  assert.strictEqual(app.doc.querySelector('.llm__question').value, '', 'the box clears for the next question');
});

test('ask the race: the model switcher lists your models, switches the one answering, and opens Manage models', async (t) => {
  const app = await openAsk(t, { models: ['qwen3:4b', 'llama3.2:3b'] });
  const btn = app.doc.querySelector('.llm__model-btn');
  btn.click();
  const options = [...app.doc.querySelectorAll('.llm__model-option')];
  assert.deepStrictEqual(options.map((o) => o.querySelector('.llm__option-name').textContent), ['Qwen3 4B', 'Llama 3.2 3B'], 'in the catalog order');
  assert.strictEqual(options[0].getAttribute('aria-checked'), 'true');
  options[1].click();
  assert.strictEqual(btn.textContent, 'Llama 3.2 3B');
  app.doc.querySelector('.llm__question').value = 'Best lap?';
  app.doc.querySelector('.llm__ask').click();
  await settle();
  assert.strictEqual(app.fake.calls.find((c) => c[0] === 'ask')[1], 'llama3.2:3b');
  btn.click();
  app.doc.querySelector('.llm__manage-btn').click();
  assert.strictEqual(app.doc.querySelector('.llm__chat').hidden, true);
  assert.strictEqual(app.doc.querySelector('.llm__manage').hidden, false, 'the full models and downloads view');
  assert.ok(app.doc.querySelector('.llm__manage .llm__dls'), 'with the download manager');
  app.doc.querySelector('.llm__back').click();
  assert.strictEqual(app.doc.querySelector('.llm__chat').hidden, false);
  assert.deepStrictEqual(app.errors, []);
});

test('ask the race: the conversation is still there after going Home and back', async (t) => {
  const app = await openAsk(t);
  app.doc.querySelector('.llm__question').value = 'Remember me?';
  app.doc.querySelector('.llm__ask').click();
  await settle();
  app.doc.querySelector('.place__back').click();
  app.go('Ask the race');
  await settle();
  assert.deepStrictEqual([...app.doc.querySelectorAll('.llm__answer .llm__q')].map((x) => x.textContent).slice(-1), ['Remember me?']);
});

test('ask the race: "Ask about this session" in Race analysis opens the chat on that session', async (t) => {
  const fake = fakeApi();
  const app = open(t, { before: (w) => { w.undercut = fake.api; } });
  await settle();
  app.connect();
  // Race analysis lists the Silverstone race (the debrief's own record of it).
  const silverstone = { id: 'd19', live: false, startedAt: new Date(2026, 9, 19, 17, 43).getTime(), sessionType: 15, sessionName: 'Race', isRace: true, track: 'Silverstone', totalLaps: 6, grid: 10, finish: 4, positionsGained: 6, official: true, points: 12, fieldBestSectors: [], bestSectors: [], positionChart: null, bestLap: null, theoreticalBestMs: null, medianPaceMs: null, consistencyMs: null, cleanLaps: 0, fieldBestMs: null, fastestLap: null, pitStops: 0, penalties: [], safetyCars: 0, stints: [], laps: [], comparable: [], field: [] };
  app.send({ source: 'live', connected: false, debrief: { sessions: [silverstone] } });
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Race analysis')).click();
  doc.querySelector('.ana__ask').click();
  await settle();
  assert.strictEqual(doc.querySelector('.place__title').textContent, 'Ask the race');
  assert.strictEqual(doc.querySelector('.llm__session').value, '19', 'race.db\'s Silverstone race, not the newest session');
  assert.deepStrictEqual(app.errors, []);
});

test('ask the race: Manage models shows no stray "null", and the model answering is marked Selected', async (t) => {
  const app = await openAsk(t);
  app.doc.querySelector('.llm__model-btn').click();
  app.doc.querySelector('.llm__manage-btn').click();
  assert.doesNotMatch(app.doc.querySelector('.llm__manage').textContent, /null|undefined/);
  assert.match(app.row('qwen3:4b').textContent, /Selected/);
});

test('ask the race: a slow answer counts its seconds, so it never looks frozen', async (t) => {
  const fake = fakeApi();
  let finish = null;
  fake.api.llm.ask = () => new Promise((r) => { finish = r; });
  const app = open(t, { before: (w) => { w.undercut = fake.api; } });
  await settle();
  app.connect();
  app.send({ source: 'live', connected: false, debrief: { sessions: [] } });
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.textContent.startsWith('Ask the race')).click();
  await settle();
  doc.querySelector('.llm__question').value = 'Slow one?';
  doc.querySelector('.llm__ask').click();
  await new Promise((r) => setTimeout(r, 1150));
  assert.match(doc.querySelector('.llm__thinking').textContent, /1 s/);
  finish({ answer: 'Done.', grounded: true, unsupported: [], charts: [], evidence: [], toolCalls: [] });
  await settle();
  assert.strictEqual(doc.querySelector('.llm__thinking'), null);
});

test('ask the race: a trend with its range is drawn as a band with the line through it, and named in the legend', async (t) => {
  const app = await openAsk(t);
  app.doc.querySelector('.llm__question').value = 'What is the trend against Leclerc?';
  app.doc.querySelector('.llm__ask').click();
  await settle();
  const band = app.doc.querySelector('svg.llm__chart .llm__band');
  assert.ok(band, 'a band');
  assert.match(band.getAttribute('d'), /^M[\d.,L-]+Z$/, 'a closed shape from the lower edge to the upper');
  assert.ok(app.doc.querySelector('svg.llm__chart .llm__trend'), 'the trend line');
  assert.match(app.doc.querySelector('.llm__legend').textContent, /Trend and the range it could be/);
  assert.deepStrictEqual(app.errors, []);
});

test('ask the race: a chart with no trend is drawn as before, with no band', async (t) => {
  const app = await openAsk(t);
  app.doc.querySelector('.llm__question').value = 'Show me positions';
  app.doc.querySelector('.llm__ask').click();
  await settle();
  assert.strictEqual(app.doc.querySelector('.llm__band'), null);
});

test('ask the race: the suggested questions show what it can do now - a summary, the stops, the tyres, lost time, pace', async (t) => {
  const app = await openAsk(t);
  assert.deepStrictEqual([...app.doc.querySelectorAll('.llm__suggest .llm__chip--ask')].map((b) => b.textContent),
    ['Summarize my race', 'Was my pit stop good?', 'How did my tyres hold up?', 'Which laps cost me the most time?', 'Who had the best race pace?', 'What was my best lap?']);
});

test('ask the race: a suggested question asks it', async (t) => {
  const app = await openAsk(t);
  [...app.doc.querySelectorAll('.llm__suggest .llm__chip--ask')].find((b) => b.textContent === 'Was my pit stop good?').click();
  await settle();
  assert.deepStrictEqual(app.fake.calls.filter((c) => c[0] === 'ask').map((c) => c[3]), ['Was my pit stop good?']);
});

test('ask the race: the Charts menu draws tyre pace by stint with no model', async (t) => {
  const app = await openAsk(t);
  [...app.doc.querySelectorAll('.llm__chip--chart')].find((b) => b.textContent === 'Tyre pace by stint').click();
  await settle();
  assert.strictEqual(JSON.stringify(app.fake.calls.find((c) => c[0] === 'chart')), JSON.stringify(['chart', 19, 'stint_pace', {}]));
  assert.deepStrictEqual(app.fake.calls.filter((c) => c[0] === 'ask'), []);
});

test('ask the race: stints are drawn in their own colours, each with its trend and range, and the legend names them', async (t) => {
  const app = await openAsk(t);
  app.doc.querySelector('.llm__question').value = 'How did my tyres hold up?';
  app.doc.querySelector('.llm__ask').click();
  await settle();
  const svg = app.doc.querySelector('svg.llm__chart');
  assert.ok(svg.querySelector('.llm__series.is-you') && svg.querySelector('.llm__series.is-ref'), 'two colours');
  assert.strictEqual(svg.querySelectorAll('.llm__band').length, 2);
  assert.strictEqual(svg.querySelectorAll('.llm__trend').length, 2);
  const legend = app.doc.querySelector('.llm__legend').textContent;
  assert.match(legend, /Medium, laps 2-6/);
  assert.strictEqual(legend.split('Trend and the range it could be').length - 1, 1, 'named once, not once per stint');
  assert.match(app.doc.querySelector('.llm__axis').textContent, /107% of your best/);
  assert.deepStrictEqual(app.errors, []);
});

// --- The insight buttons (no model) and the uncertainty line ---
const INSIGHT_LABELS = ['Race summary', 'Pit stops', 'Tyres', 'Lost time', 'Race pace', 'Calls', 'History', 'Handling'];

test('ask the race: the Charts menu also holds the insight buttons, the engine\'s own findings with no model', async (t) => {
  const app = await openAsk(t);
  const chips = [...app.doc.querySelectorAll('.llm__tools-menu .llm__chip--insight')];
  assert.deepStrictEqual(chips.map((b) => b.textContent), INSIGHT_LABELS);
  chips.find((b) => b.textContent === 'Pit stops').click();
  await settle();
  assert.strictEqual(JSON.stringify(app.fake.calls.find((c) => c[0] === 'insight')), JSON.stringify(['insight', 19, 'pit_stops']));
  assert.deepStrictEqual(app.fake.calls.filter((c) => c[0] === 'ask'), [], 'no model');
  const lines = [...app.doc.querySelectorAll('.llm__answer .llm__lines li')].map((li) => li.textContent);
  assert.deepStrictEqual(lines, ['Stop 1: in on lap 7, out on lap 8, medium to hard.', 'It cost 15.7 s against the cars that did not stop on those laps.']);
  assert.match(app.doc.querySelector('.llm__answer .llm__q').textContent, /Pit stops/);
  assert.match(app.doc.querySelector('.llm__answer .llm__fine').textContent, /no model/i);
});

test('ask the race: an insight with a chart draws it, and one that cannot answer says why', async (t) => {
  const app = await openAsk(t);
  [...app.doc.querySelectorAll('.llm__chip--insight')].find((b) => b.textContent === 'Tyres').click();
  await settle();
  assert.ok(app.doc.querySelector('.llm__answer svg.llm__chart'));
  [...app.doc.querySelectorAll('.llm__chip--insight')].find((b) => b.textContent === 'History').click();
  await settle();
  const last = [...app.doc.querySelectorAll('.llm__answer')].pop();
  assert.match(last.textContent, /not a race/);
  assert.strictEqual(last.querySelector('.llm__lines'), null);
});

test('ask the race: every answer from the model carries a small line that it can be wrong and rests on one recording', async (t) => {
  const app = await openAsk(t);
  app.doc.querySelector('.llm__question').value = 'How did the stop go?';
  app.doc.querySelector('.llm__ask').click();
  await settle();
  const fine = app.doc.querySelector('.llm__answer .llm__fine').textContent;
  assert.match(fine, /small model/i);
  assert.match(fine, /can misjudge/i);
  assert.match(fine, /one session|this session/i);
  assert.match(fine, /80%/);
});

test('ask the race: the notice under the box says answers can be wrong, not only that they come from the recording', async (t) => {
  const app = await openAsk(t);
  assert.match(app.doc.querySelector('.llm__notice').textContent, /can be wrong|can misjudge/i);
  assert.match(app.doc.querySelector('.llm__notice').textContent, /Not for use while racing/);
});

test('ask the race: a chart button is labelled as drawn from the recording with no model', async (t) => {
  const app = await openAsk(t);
  [...app.doc.querySelectorAll('.llm__chip--chart')].find((b) => b.textContent === 'Positions').click();
  await settle();
  assert.match(app.doc.querySelector('.llm__answer .llm__fine').textContent, /no model/i);
});
