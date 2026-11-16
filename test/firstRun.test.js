const test = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const { createIntake } = require('../src/udp/intake');
const { startUdpListener } = require('../src/udp/listener');
const { open } = require('./helpers/dashboard');

// The first-run check: "No telemetry" says which of the usual causes it is.
const header = (format) => { const b = Buffer.alloc(40); b.writeUInt16LE(format, 0); return b; };

test('intake: counts what arrives and remembers the packet format and when', () => {
  let now = 1000;
  const intake = createIntake(() => now);
  assert.deepStrictEqual(intake.view(), { packets: 0, unreadable: 0, format: null, error: null, lastAgoMs: null });
  intake.note(header(2024));
  now = 1600;
  const v = intake.view();
  assert.strictEqual(v.packets, 1);
  assert.strictEqual(v.format, 2024);
  assert.strictEqual(v.lastAgoMs, 600);
});

test('intake: a datagram too short for a header is counted as unreadable and never throws', () => {
  const intake = createIntake();
  intake.note(Buffer.alloc(5));
  intake.note(null);
  assert.strictEqual(intake.view().unreadable, 2);
  assert.strictEqual(intake.view().format, null);
});

test('intake: a port another program already owns is recorded, not thrown', async (t) => {
  const blocker = dgram.createSocket('udp4');
  await new Promise((r) => blocker.bind(0, '127.0.0.1', r));
  const port = blocker.address().port;
  t.after(() => blocker.close());
  const intake = createIntake();
  const sock = startUdpListener({ port, host: '127.0.0.1', onPacket() {}, onError: (e) => intake.fail(e) });
  t.after(() => { try { sock.close(); } catch { /* never opened */ } });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(intake.view().error.code, 'EADDRINUSE');
});

const send = (app, extra) => app.send({ source: 'live', capturing: false, connected: false, udpPort: 20777, ...extra });

test('first run: nothing has arrived at all -> turn UDP on and check the port', (t) => {
  const app = open(t);
  app.connect();
  send(app, { intake: { packets: 0, unreadable: 0, format: null, error: null, lastAgoMs: null } });
  assert.match(app.$('status-banner').textContent, /UDP On, port 20777/);
});

test('first run: packets arrive in an old format -> say which format and what to set', (t) => {
  const app = open(t);
  app.connect();
  send(app, { intake: { packets: 400, unreadable: 0, format: 2023, error: null, lastAgoMs: 100 } });
  const text = app.$('status-banner').textContent;
  assert.match(text, /2023/);
  assert.match(text, /2025 or later/);
  assert.match(text, /old format/i);
});

test('first run: packets arrive in a good format but no session yet -> say it is working and to get on track', (t) => {
  const app = open(t);
  app.connect();
  send(app, { intake: { packets: 50, unreadable: 0, format: 2026, error: null, lastAgoMs: 100 } });
  const text = app.$('status-banner').textContent;
  assert.match(text, /arriving/i);
  assert.match(text, /on track/i);
  assert.doesNotMatch(text, /UDP On/, 'it is already on');
});

test('first run: the port is taken by another program -> say so and point to Settings', (t) => {
  const app = open(t);
  app.connect();
  send(app, { intake: { packets: 0, unreadable: 0, format: null, error: { code: 'EADDRINUSE', message: 'in use' }, lastAgoMs: null } });
  const text = app.$('status-banner').textContent;
  assert.match(text, /another program/i);
  assert.match(text, /20777/);
});

test('first run: an older bridge with no intake keeps the old message', (t) => {
  const app = open(t);
  app.connect();
  send(app, {});
  assert.match(app.$('status-banner').textContent, /UDP On, port 20777/);
});
