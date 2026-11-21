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

test('server: with https on, a plain http address is sent to the https one on the same port (old bookmarks, typed addresses)', async (t) => {
  const pems = await require('selfsigned').generate([{ name: 'commonName', value: 'test' }], { keySize: 2048 });
  const s = startServer({ httpPort: 0, getSnapshot: () => ({ ok: true }), tls: { key: pems.private, cert: pems.cert } });
  if (!s.server.listening) await once(s.server, 'listening');
  t.after(s.close);
  const port = s.server.address().port;
  const res = await new Promise((resolve, reject) => http.get({ port, path: '/?x=1', headers: { host: `192.168.1.23:${port}` } }, resolve).on('error', reject));
  res.resume();
  assert.strictEqual(res.statusCode, 301);
  assert.strictEqual(res.headers.location, `https://192.168.1.23:${port}/?x=1`);
  // https itself still serves the dashboard.
  const ok = await new Promise((resolve, reject) => require('https').get({ port, path: '/', rejectUnauthorized: false }, resolve).on('error', reject));
  ok.resume();
  assert.strictEqual(ok.statusCode, 200);
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

// Any page in a browser can open a WebSocket to localhost. The live feed is for the dashboard's own page (on the PC or a
// phone, whose Origin is this server) and for clients that send no Origin at all, never for another site.
test('server: a WebSocket from another site is refused; the dashboard\'s own page and plain clients get the feed', async (t) => {
  const s = await start();
  t.after(s.close);
  const tryOpen = (origin) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${s.port}`, origin ? { origin } : {});
    ws.on('message', () => { ws.close(); resolve('fed'); });
    ws.on('error', () => resolve('refused'));
    ws.on('unexpected-response', () => resolve('refused'));
  });
  assert.strictEqual(await tryOpen('https://example.com'), 'refused');
  assert.strictEqual(await tryOpen('null'), 'refused');
  assert.strictEqual(await tryOpen(`http://localhost:${s.port}`), 'fed');
  assert.strictEqual(await tryOpen(null), 'fed');
});
