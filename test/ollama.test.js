const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createOllama } = require('../src/llm/ollama');

// Ask the race (roadmap L2): the local model only runs when asked, never while you race. A fake
// Ollama keeps a model loaded after a request until a request for it says keep_alive: 0, as the
// real one does, and logs every request it gets.
async function fakeOllama(t, { reply = null, slowMs = 0 } = {}) {
  const log = [];
  const loaded = new Set();
  const installed = new Set(['qwen3:4b']);
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const json = body ? JSON.parse(body) : null;
      log.push({ method: req.method, path: req.url, body: json });
      const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (req.url === '/api/version') return send({ version: '0.12.3' });
      if (req.url === '/api/tags') return send({ models: [...installed].map((name) => ({ name, size: 2.5e9 })) });
      if (req.url === '/api/delete') {
        if (!installed.delete(json.model)) res.statusCode = 404;
        return res.end();
      }
      if (req.url === '/api/pull') {
        // Two layers, streamed as Ollama does: one JSON object per line.
        res.setHeader('content-type', 'application/x-ndjson');
        const steps = [['pulling manifest'], ['pulling a', 'sha256:a', 1000, 0], ['pulling a', 'sha256:a', 1000, 500], ['pulling b', 'sha256:b', 100, 100], ['pulling a', 'sha256:a', 1000, 1000], ['verifying sha256 digest'], ['success']];
        for (const [status, digest, total, completed] of steps) {
          if (res.destroyed) return undefined;
          res.write(JSON.stringify({ status, ...(digest ? { digest, total, completed } : {}) }) + '\n');
          await new Promise((r2) => setTimeout(r2, slowMs || 5));
        }
        if (res.destroyed) return undefined;
        installed.add(json.model);
        return res.end();
      }
      if (req.url === '/api/ps') return send({ models: [...loaded].map((name) => ({ name })) });
      if (req.url === '/api/chat' || req.url === '/api/generate') {
        if (json.keep_alive === 0 || json.keep_alive === '0') loaded.delete(json.model);
        else loaded.add(json.model);
        if (req.url === '/api/generate') return send({ done: true });
        if (json.keep_alive !== 0) loaded.add(json.model);
        if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
        if (res.destroyed) return undefined;
        const message = reply ? reply(json, log) : { role: 'assistant', content: 'Lap 12 was your best.' };
        if (json.keep_alive === 0) loaded.delete(json.model);
        return send({ message, done: true });
      }
      res.statusCode = 404;
      return res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return { host: `http://127.0.0.1:${server.address().port}`, log, loaded, installed };
}

test('ollama: finds it, with its version and the models downloaded; says where to get it when missing', async (t) => {
  const fake = await fakeOllama(t);
  const o = createOllama({ host: fake.host });
  assert.deepStrictEqual(await o.detect(), { installed: true, version: '0.12.3' });
  assert.deepStrictEqual((await o.models()).map((m) => m.name), ['qwen3:4b']);
  const none = createOllama({ host: 'http://127.0.0.1:9' });
  assert.deepStrictEqual(await none.detect(), { installed: false, installUrl: 'https://ollama.com/download' });
});

test('ollama: an answer leaves no model in memory - the last request for it says keep_alive 0', async (t) => {
  const fake = await fakeOllama(t);
  const o = createOllama({ host: fake.host });
  const out = await o.ask({ model: 'qwen3:4b', question: 'Best lap?' });
  assert.strictEqual(out.answer, 'Lap 12 was your best.');
  const toModel = fake.log.filter((r) => r.body && r.body.model);
  assert.strictEqual(toModel[toModel.length - 1].body.keep_alive, 0);
  assert.deepStrictEqual([...fake.loaded], [], '/api/ps lists nothing after the answer');
});

test('ollama: the model calls race tools, the engine answers them, and it is still unloaded after', async (t) => {
  const fake = await fakeOllama(t, {
    reply: (json) => (json.messages.some((m) => m.role === 'tool')
      ? { role: 'assistant', content: 'You were P4 on lap 3.' }
      : { role: 'assistant', content: '', tool_calls: [{ function: { name: 'gaps', arguments: { session_id: 1, lap: 3 } } }] }),
  });
  const calls = [];
  const tools = { schemas: [{ type: 'function', function: { name: 'gaps', description: 'x', parameters: { type: 'object', properties: {} } } }], run: (name, args) => { calls.push([name, args]); return { cars: [{ position: 4, driver: 'YOU' }] }; } };
  const o = createOllama({ host: fake.host });
  const out = await o.ask({ model: 'qwen3:4b', question: 'Where was I on lap 3?', tools });
  assert.strictEqual(out.answer, 'You were P4 on lap 3.');
  assert.deepStrictEqual(calls, [['gaps', { session_id: 1, lap: 3 }]]);
  assert.deepStrictEqual(out.toolCalls.map((c) => c.name), ['gaps']);
  assert.deepStrictEqual(fake.loaded.size, 0);
  // The first round sent the tool schemas.
  assert.strictEqual(fake.log.find((r) => r.path === '/api/chat').body.tools[0].function.name, 'gaps');
});

test('ollama: while a session is live, a question is refused without reaching Ollama', async (t) => {
  const fake = await fakeOllama(t);
  let live = true;
  const o = createOllama({ host: fake.host, isLive: () => live });
  await assert.rejects(o.ask({ model: 'qwen3:4b', question: 'Best lap?' }), /not while you race/i);
  assert.deepStrictEqual(fake.log, []);
  live = false;
  assert.ok((await o.ask({ model: 'qwen3:4b', question: 'Best lap?' })).answer);
});

test('ollama: a session starting unloads a model left in memory, and stops an answer in progress', async (t) => {
  const fake = await fakeOllama(t, { slowMs: 300 });
  fake.loaded.add('gemma3:4b'); // loaded by something else, or a crashed answer
  const o = createOllama({ host: fake.host });
  const pending = o.ask({ model: 'qwen3:4b', question: 'Best lap?' });
  await new Promise((r) => setTimeout(r, 50));
  await o.sessionStarted();
  await assert.rejects(pending, /stopped/i);
  assert.deepStrictEqual([...fake.loaded], []);
  const unloads = fake.log.filter((r) => r.path === '/api/generate' && r.body.keep_alive === 0).map((r) => r.body.model).sort();
  assert.deepStrictEqual(unloads, ['gemma3:4b', 'qwen3:4b']);
});

test('ollama: Stop cancels the answer and still unloads the model', async (t) => {
  const fake = await fakeOllama(t, { slowMs: 300 });
  const o = createOllama({ host: fake.host });
  const pending = o.ask({ model: 'qwen3:4b', question: 'Best lap?' });
  await new Promise((r) => setTimeout(r, 50));
  await o.stop();
  await assert.rejects(pending, /stopped/i);
  assert.deepStrictEqual([...fake.loaded], []);
});

test('ollama: a session start does not touch Ollama if it was never used this run', async (t) => {
  const fake = await fakeOllama(t);
  const o = createOllama({ host: fake.host });
  await o.sessionStarted();
  assert.deepStrictEqual(fake.log, []);
});

test('ollama: a download reports its progress to 100% and the model is then listed (roadmap L3)', async (t) => {
  const fake = await fakeOllama(t);
  const o = createOllama({ host: fake.host });
  const seen = [];
  await o.pull('llama3.2:3b', (p) => seen.push(p.fraction));
  assert.ok(seen.length >= 3);
  assert.deepStrictEqual(seen, [...seen].sort((a, b) => a - b), 'progress never goes backwards');
  assert.strictEqual(seen[seen.length - 1], 1);
  assert.ok((await o.models()).some((m) => m.name === 'llama3.2:3b'));
});

test('ollama: a cancelled download leaves nothing listed; delete removes a model', async (t) => {
  const fake = await fakeOllama(t, { slowMs: 60 });
  const o = createOllama({ host: fake.host });
  const pending = o.pull('phi4-mini', () => {});
  await new Promise((r) => setTimeout(r, 100));
  o.cancelPull('phi4-mini');
  await assert.rejects(pending, /cancelled/i);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!(await o.models()).some((m) => m.name === 'phi4-mini'));
  await o.remove('qwen3:4b');
  assert.deepStrictEqual(await o.models(), []);
});

test('ollama: no downloads while you race either', async (t) => {
  const fake = await fakeOllama(t);
  const o = createOllama({ host: fake.host, isLive: () => true });
  await assert.rejects(o.pull('qwen3:1.7b', () => {}), /not while you race/i);
  assert.deepStrictEqual(fake.log, []);
});

test('catalog: every model offered fits a 4 GB GPU, names its licence, and only these can be downloaded', () => {
  const { MODELS, isOffered } = require('../src/llm/catalog');
  assert.ok(MODELS.length >= 3);
  assert.strictEqual(new Set(MODELS.map((m) => m.id)).size, MODELS.length);
  for (const m of MODELS) {
    assert.ok(m.sizeBytes > 0 && m.sizeBytes < 4e9, m.id);
    assert.ok(m.licence && /^https:\/\//.test(m.licenceUrl), m.id);
    assert.ok(m.name && m.note, m.id);
  }
  assert.strictEqual(isOffered('qwen3:4b'), true);
  assert.strictEqual(isOffered('llama3.1:70b'), false);
});

test('ollama: downloads are tracked outside any page - what is downloading, how far, and how each one ended', async (t) => {
  const fake = await fakeOllama(t, { slowMs: 40 });
  const updates = [];
  const o = createOllama({ host: fake.host, onDownloads: (list) => updates.push(list) });
  const done = o.pull('llama3.2:3b');
  // Mid-download: wait for the first progress, however busy the machine is.
  for (let i = 0; i < 200 && !(o.downloads()[0] && o.downloads()[0].fraction > 0); i++) await new Promise((r) => setTimeout(r, 5));
  const mid = o.downloads().find((d) => d.model === 'llama3.2:3b');
  assert.strictEqual(mid.state, 'downloading');
  assert.ok(mid.fraction > 0 && mid.fraction < 1, String(mid.fraction));
  assert.ok(mid.total > 0);
  await done;
  assert.deepStrictEqual(o.downloads().map((d) => [d.model, d.state, d.fraction]), [['llama3.2:3b', 'done', 1]]);
  assert.ok(updates.length >= 3 && updates[updates.length - 1][0].state === 'done');

  const cancelled = o.pull('phi4-mini');
  await new Promise((r) => setTimeout(r, 60));
  o.cancelPull('phi4-mini');
  await assert.rejects(cancelled, /cancelled/i);
  assert.strictEqual(o.downloads().find((d) => d.model === 'phi4-mini').state, 'cancelled');

  o.clearDownloads();
  assert.deepStrictEqual(o.downloads(), [], 'finished ones clear; none was still running');
});
