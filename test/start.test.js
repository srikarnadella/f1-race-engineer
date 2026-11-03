const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { once } = require('events');
const { start } = require('../src/index');

// What the desktop app (desktop/main.js) and the command line both call.
function quiet(t) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  t.after(() => Object.assign(console, { log, warn }));
}
const get = (port, p) => new Promise((resolve, reject) => http.get({ port, path: p }, resolve).on('error', reject));

test('start: a live bridge keeps its data in dataDir, serves the dashboard, and stop() lets go of it', async (t) => {
  quiet(t);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercut-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const bridge = start({ httpPort: 0, udpPort: 0, udpHost: '127.0.0.1', dataDir });
  if (!bridge.server.listening) await once(bridge.server, 'listening');
  const { port } = bridge.server.address();

  const res = await get(port, '/');
  res.resume();
  assert.strictEqual(res.statusCode, 200);
  assert.ok(fs.existsSync(path.join(dataDir, 'race.db')), 'the race store lives in dataDir');

  await bridge.stop();
  await assert.rejects(get(port, '/'), 'the dashboard port is free again');
});

test('start: a dashboard port already in use is reported, not a silent exit', async (t) => {
  quiet(t);
  const taken = net.createServer().listen(0);
  await once(taken, 'listening');
  t.after(() => taken.close());
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercut-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { port } = /** @type {net.AddressInfo} */ (taken.address());
  let reported = null;
  const bridge = start({ httpPort: port, udpPort: 0, udpHost: '127.0.0.1', dataDir, onPortInUse: (p) => { reported = p; } });
  await once(bridge.server, 'error');
  assert.strictEqual(reported, port);
  await bridge.stop();
});

test('start: recording starts and stops while the bridge runs, without restarting it', async (t) => {
  quiet(t);
  const dgram = require('dgram');
  const { readLog } = require('../src/capture/logFile');
  const { syntheticPackets } = require('./helpers/synthetic');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercut-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const bridge = start({ httpPort: 0, udpPort: 0, udpHost: '127.0.0.1', dataDir });
  if (!bridge.server.listening) await once(bridge.server, 'listening');
  try {
    bridge.udp.address();
  } catch {
    await once(bridge.udp, 'listening');
  }
  const send = async (buf) => {
    const c = dgram.createSocket('udp4');
    await new Promise((resolve) => c.send(buf, bridge.udp.address().port, '127.0.0.1', resolve));
    c.close();
  };
  const [{ buf: first }] = syntheticPackets();

  await send(first); // before recording: not in the file
  await new Promise((resolve) => setTimeout(resolve, 100));
  const dir = path.join(dataDir, 'captures', 'run');
  assert.strictEqual(bridge.record(dir), dir);
  assert.strictEqual(bridge.recording(), dir);
  await send(first);
  await send(first);
  await new Promise((resolve) => setTimeout(resolve, 250)); // two engine ticks, and both packets in
  assert.strictEqual(bridge.snapshot().capturing, true, 'the dashboard shows MARK while recording');
  await bridge.stopRecording();
  assert.strictEqual(bridge.recording(), null);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.strictEqual(bridge.snapshot().capturing, false);

  const recorded = [];
  for await (const r of readLog(path.join(dir, 'packets.f1log.gz'), {})) recorded.push(r);
  assert.strictEqual(recorded.length, 2);
  assert.ok(fs.existsSync(path.join(dir, 'meta.json')));
  await bridge.stop();
});

test('start: the bridge says when telemetry is live and when a new session starts, for Ask the race (roadmap L2)', async (t) => {
  quiet(t);
  const dgram = require('dgram');
  const { syntheticPackets } = require('./helpers/synthetic');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercut-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let started = 0;
  const bridge = start({ httpPort: 0, udpPort: 0, udpHost: '127.0.0.1', dataDir, onSessionStart: () => { started++; } });
  if (!bridge.server.listening) await once(bridge.server, 'listening');
  try { bridge.udp.address(); } catch { await once(bridge.udp, 'listening'); }
  assert.strictEqual(bridge.live(), false, 'no game yet');
  const client = dgram.createSocket('udp4');
  for (const p of syntheticPackets().slice(0, 300)) await new Promise((r) => client.send(p.buf, bridge.udp.address().port, '127.0.0.1', r));
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(bridge.live(), true);
  assert.strictEqual(started, 1);
  client.close();
  await bridge.stop();
});
