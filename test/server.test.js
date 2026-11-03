const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { once } = require('events');
const WebSocket = require('ws');
const { startServer } = require('../src/server/httpServer');

async function start() {
  const s = startServer({ httpPort: 0, getSnapshot: () => ({ ok: true }) });
  if (!s.server.listening) await once(s.server, 'listening');
  return { ...s, port: s.server.address().port };
}

test('server: an encoded ../ cannot read files outside public/', async (t) => {
  const s = await start();
  t.after(s.close);
  const res = await new Promise((resolve) => http.get({ port: s.port, path: '/..%2Fpackage.json' }, resolve));
  res.resume();
  assert.strictEqual(res.statusCode, 404);
});

test('server: a WebSocket frame over 1 KB closes the connection', async (t) => {
  const s = await start();
  t.after(s.close);
  const ws = new WebSocket(`ws://localhost:${s.port}`);
  ws.on('error', () => {});
  await once(ws, 'message'); // the first snapshot
  ws.send('x'.repeat(2048));
  const [code] = await once(ws, 'close');
  assert.strictEqual(code, 1009); // message too big
});

test('server: bound to this PC only, it offers no pairing address and other devices cannot reach it', async (t) => {
  const s = startServer({ httpPort: 0, host: '127.0.0.1', getSnapshot: () => ({ ok: true }) });
  if (!s.server.listening) await once(s.server, 'listening');
  t.after(s.close);
  assert.strictEqual(s.server.address().address, '127.0.0.1');
  const res = await new Promise((resolve) => http.get({ port: s.server.address().port, path: '/api/pair' }, resolve));
  let body = '';
  for await (const chunk of res) body += chunk;
  assert.deepStrictEqual(JSON.parse(body), { url: null });
});
