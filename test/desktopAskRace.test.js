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
    ask: ok,
    stop: ok,
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
