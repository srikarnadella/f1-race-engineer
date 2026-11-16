const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { startServer } = require('../src/server/httpServer');
const { loadPairKey } = require('../src/server/pairKey');

// Saving a setup's name, star or note from a phone: allowed only to a device that scanned the pairing QR code (it carries a
// key), never from a page that merely sits in a browser on the same network.
const KEY = 'a'.repeat(32);

async function start({ pairKey = KEY, post } = {}) {
  const saved = [];
  const s = startServer({
    httpPort: 0, host: '127.0.0.1', getSnapshot: () => ({ ok: true }), pairKey,
    post: post || ((p, body) => { if (p === '/api/setups/note') { saved.push(body); return { ok: true }; } return null; }),
  });
  if (!s.server.listening) await once(s.server, 'listening');
  return { ...s, port: s.server.address().port, saved };
}

function send(port, { method = 'POST', url = '/api/setups/note', headers = {}, body = '{}' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method, path: url, headers: { 'Content-Type': 'application/json', ...headers } }, async (res) => {
      let text = '';
      for await (const c of res) text += c;
      resolve({ status: res.statusCode, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), headers: res.headers });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const ok = (s) => send(s.port, { headers: { 'X-Undercut-Key': KEY, Origin: `http://localhost:${s.port}`, Host: `localhost:${s.port}` }, body: JSON.stringify({ trackId: 10, key: 'abcdefabcdef', favorite: true }) });

test('write: a device with the key saves, and the handler gets exactly what was sent', async (t) => {
  const s = await start();
  t.after(s.close);
  const r = await ok(s);
  assert.deepStrictEqual([r.status, r.json], [200, { ok: true }]);
  assert.deepStrictEqual(s.saved, [{ trackId: 10, key: 'abcdefabcdef', favorite: true }]);
});

test('write: without the key, or with a wrong one, nothing is saved', async (t) => {
  const s = await start();
  t.after(s.close);
  for (const headers of [{}, { 'X-Undercut-Key': 'b'.repeat(32) }, { 'X-Undercut-Key': 'a' }, { 'X-Undercut-Key': `${KEY}x` }]) {
    const r = await send(s.port, { headers });
    assert.strictEqual(r.status, 403, JSON.stringify(headers));
    assert.match(r.json.error, /not paired|scan the QR/i);
  }
  assert.deepStrictEqual(s.saved, []);
});

test('write: a request that names another site as its origin is refused even with the key', async (t) => {
  const s = await start();
  t.after(s.close);
  const r = await send(s.port, { headers: { 'X-Undercut-Key': KEY, Origin: 'http://evil.example' }, body: JSON.stringify({ trackId: 1 }) });
  assert.strictEqual(r.status, 403);
  assert.deepStrictEqual(s.saved, []);
});

test('write: a browser asking permission first (OPTIONS) gets no permission, so another site cannot send it', async (t) => {
  const s = await start();
  t.after(s.close);
  const r = await send(s.port, { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-undercut-key' } });
  assert.ok(!r.headers['access-control-allow-origin'], 'no CORS grant');
});

test('write: with no key configured (a replay, or the command line without one) every write is refused', async (t) => {
  const s = await start({ pairKey: null });
  t.after(s.close);
  const r = await send(s.port, { headers: { 'X-Undercut-Key': KEY } });
  assert.strictEqual(r.status, 403);
});

test('write: bad bodies are refused with the reason, and an oversized one is cut off', async (t) => {
  const s = await start({ post: () => { throw new Error('setup note: a name is at most 60 characters'); } });
  t.after(s.close);
  const h = { 'X-Undercut-Key': KEY };
  const bad = await send(s.port, { headers: h, body: JSON.stringify({ trackId: 10 }) });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.json.error, /at most 60 characters/);
  assert.strictEqual((await send(s.port, { headers: h, body: 'not json' })).status, 400);
  assert.strictEqual((await send(s.port, { headers: h, body: '[1,2]' })).status, 400);
  let big;
  try {
    big = await send(s.port, { headers: h, body: JSON.stringify({ note: 'x'.repeat(20000) }) });
  } catch {
    big = { status: 413 }; // the connection was cut off before the answer
  }
  assert.strictEqual(big.status, 413);
});

test('write: an unknown address is a 404, and reading is untouched by all of this', async (t) => {
  const s = await start();
  t.after(s.close);
  assert.strictEqual((await send(s.port, { url: '/api/nothing', headers: { 'X-Undercut-Key': KEY } })).status, 404);
  const g = await send(s.port, { method: 'GET', url: '/api/pair', body: '' });
  assert.strictEqual(g.status, 200);
});

test('pairing: the QR code and the printed address carry the key, and the plain address shown for typing does not', async (t) => {
  const s = startServer({ httpPort: 0, getSnapshot: () => ({}), pairKey: KEY });
  if (!s.server.listening) await once(s.server, 'listening');
  t.after(s.close);
  const pair = await send(s.server.address().port, { method: 'GET', url: '/api/pair', body: '' });
  if (pair.json && pair.json.url) {
    assert.ok(!pair.json.url.includes(KEY), 'the address to type has no key');
    assert.ok(typeof s.pairLink === 'function' && s.pairLink().includes(`k=${KEY}`), 'the QR link does');
  }
});

// The QR image: the key goes only to the PC itself (the app window, a browser on the PC). Another device that opens the
// dashboard sees the plain address, so looking at Settings on a phone is not a way to pair it.
test('pairing: the QR image carries the key only when the PC itself asks for it', async (t) => {
  const { qrSvg } = require('../src/server/qr');
  const s = startServer({ httpPort: 0, getSnapshot: () => ({}), pairKey: KEY });
  if (!s.server.listening) await once(s.server, 'listening');
  t.after(s.close);
  if (!s.pairLink()) return t.skip('no LAN address on this machine');
  const ask = (remoteAddress) => new Promise((resolve) => {
    let body = '';
    const res = { writeHead: () => {}, end: (b) => { body = String(b); resolve(body); } };
    s.server.emit('request', { method: 'GET', url: '/api/qr', headers: {}, socket: { remoteAddress } }, res);
  });
  const plain = s.pairLink().split('/?k=')[0];
  assert.strictEqual(await ask('127.0.0.1'), qrSvg(s.pairLink()), 'the PC gets the QR with the key');
  assert.strictEqual(await ask('::ffff:127.0.0.1'), qrSvg(s.pairLink()));
  assert.strictEqual(await ask('192.168.1.23'), qrSvg(plain), 'a phone on the Wi-Fi gets the address only');
});

test('pair key: made once, kept in the data folder, and the same on the next start', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairkey-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = loadPairKey(dir);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.strictEqual(loadPairKey(dir), a);
  fs.writeFileSync(path.join(dir, 'pair-key'), 'garbage');
  const b = loadPairKey(dir);
  assert.match(b, /^[0-9a-f]{32}$/, 'a damaged file is replaced, not trusted');
  assert.notStrictEqual(b, 'garbage');
});
