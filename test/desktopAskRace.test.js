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
const answer = (q) => (/invent/.test(q)
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
  assert.match(app.doc.querySelector('.llm__live').textContent, /The game is sending telemetry/);
  assert.strictEqual(app.btn('llama3.2:3b', 'Download').disabled, true);
});

test('ask the race: with a model downloaded, ask about the newest race and get the answer, its chart and its evidence (roadmap L5)', async (t) => {
  const app = await openAsk(t);
  const pick = app.doc.querySelector('.llm__session');
  assert.strictEqual(pick.value, '19', 'the newest race, not the qualifying after it');
  assert.deepStrictEqual([...app.doc.querySelector('.llm__pick-model').options].map((o) => o.value), ['qwen3:4b']);
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
  assert.strictEqual(none.doc.querySelector('.llm__question'), null);
  assert.match(none.doc.querySelector('.llm__askbox').textContent, /Download a model/);
  const live = await openAsk(t, {}, { source: 'live', connected: true, debrief: { sessions: [] } });
  assert.strictEqual(live.doc.querySelector('.llm__ask').disabled, true);
});
