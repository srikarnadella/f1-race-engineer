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
  let finishPull = null;
  const llm = {
    status: async () => (installed ? { installed: true, version: '0.12.3', live: false, busy: false } : { installed: false, installUrl: 'https://ollama.com/download', live: false, busy: false }),
    catalog: async () => MODELS,
    models: async () => have.map((name) => ({ name, size: 2e9 })),
    pull: (id) => { calls.push(['pull', id]); return new Promise((r) => { finishPull = () => { have.push(id); r(true); }; }); },
    cancelPull: async (id) => { calls.push(['cancel', id]); },
    remove: async (id) => { calls.push(['remove', id]); have = have.filter((x) => x !== id); return true; },
    ask: ok,
    stop: ok,
  };
  return {
    api: { status: ok, setSettings: ok, record: ok, stopRecording: ok, replay: ok, live: ok, captures: async () => [], analyze: ok, deleteCapture: ok, deleteSession: ok, showCapture: ok, openReport: ok, openDataFolder: ok, openInBrowser: ok, speech: { start: ok, stop: ok }, llm, on: (ch, fn) => { handlers[ch] = fn; return () => {}; } },
    handlers,
    calls,
    finishPull: () => finishPull(),
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
  return { ...app, doc, fake, row, btn };
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

test('ask the race: a download shows its progress, can be cancelled, and ends as downloaded', async (t) => {
  const app = await openAsk(t);
  app.btn('llama3.2:3b', 'Download').click();
  await settle();
  assert.deepStrictEqual(app.fake.calls, [['pull', 'llama3.2:3b']]);
  app.fake.handlers.llm({ kind: 'pull', model: 'llama3.2:3b', fraction: 0.5 });
  assert.match(app.row('llama3.2:3b').textContent, /50%/);
  assert.strictEqual(app.row('llama3.2:3b').querySelector('progress').value, 0.5);
  assert.ok(app.btn('llama3.2:3b', 'Cancel'));
  app.fake.finishPull();
  await settle();
  assert.ok(app.btn('llama3.2:3b', 'Delete'));
  app.btn('qwen3:4b', 'Delete').click();
  await settle();
  assert.deepStrictEqual(app.fake.calls[1], ['remove', 'qwen3:4b']);
  assert.ok(app.btn('qwen3:4b', 'Download'));
  assert.deepStrictEqual(app.errors, []);
});

test('ask the race: while the game is sending telemetry, downloads wait and it says why', async (t) => {
  const app = await openAsk(t, {}, { source: 'live', connected: true, debrief: { sessions: [] } });
  assert.match(app.doc.querySelector('.llm__live').textContent, /The game is sending telemetry/);
  assert.strictEqual(app.btn('llama3.2:3b', 'Download').disabled, true);
});
