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
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const json = body ? JSON.parse(body) : null;
      log.push({ method: req.method, path: req.url, body: json });
      const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (req.url === '/api/version') return send({ version: '0.12.3' });
      if (req.url === '/api/tags') return send({ models: [{ name: 'qwen3:4b', size: 2.5e9 }] });
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
  return { host: `http://127.0.0.1:${server.address().port}`, log, loaded };
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
