const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');
const { once } = require('events');
const { startUdpListener } = require('../src/udp/listener');
const { parseCli } = require('../src/index');
const { syntheticPackets } = require('./helpers/synthetic');

test('UDP listener: real packets reach the engine, garbage and a crashing handler cost one packet each', async (t) => {
  const got = [];
  const raw = [];
  const warn = console.warn;
  const log = console.log;
  console.warn = () => {};
  console.log = () => {};
  t.after(() => {
    console.warn = warn;
    console.log = log;
  });
  let crashOnce = true;
  const socket = startUdpListener({
    port: 0,
    host: '127.0.0.1',
    onRawPacket: (b) => raw.push(b.length),
    onPacket: (id) => {
      if (crashOnce) {
        crashOnce = false;
        throw new Error('handler bug');
      }
      got.push(id);
    },
  });
  t.after(() => socket.close());
  await once(socket, 'listening');
  const { port } = socket.address();
  const sender = dgram.createSocket('udp4');
  t.after(() => sender.close());
  const send = (buf) => new Promise((resolve) => sender.send(buf, port, '127.0.0.1', resolve));
  const real = syntheticPackets().slice(0, 4).map((p) => p.buf);
  await send(real[0]); // the handler throws on this one
  await send(Buffer.from('not a packet'));
  for (const b of real.slice(1)) await send(b);
  const deadline = Date.now() + 2000;
  while (got.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(got, real.slice(1).map((b) => b[6]));
  assert.strictEqual(raw.length, 5, 'every datagram is offered to the recorder, garbage too');
});

test('CLI: defaults, and the combinations that make no sense are refused', () => {
  const o = parseCli([]);
  assert.strictEqual(o.httpPort, 8080);
  assert.strictEqual(o.udpPort, 20777);
  assert.strictEqual(o.udpHost, '0.0.0.0');
  assert.strictEqual(o.demoFile, null);
  assert.strictEqual(o.captureDir, null);
  assert.strictEqual(parseCli(['--speed', '0.01']).speed, 0.1, 'speed is clamped');
  assert.strictEqual(parseCli(['--speed', 'fast']).speed, 1, 'a speed that is not a number is the default');
  assert.ok(parseCli(['--capture']).captureDir.includes('captures'));
  for (const [args, msg] of [
    [['--port', '0'], /--port must be a port number/],
    [['--udp-port', '70000'], /--udp-port must be a port number/],
    [['--port', '8080.5'], /--port must be a port number/],
    [['--demo', 'x.f1log', '--record', 'y.f1log'], /--record only applies to live mode/],
    [['--demo', 'x.f1log', '--capture'], /--capture only applies to live mode/],
    [['--record', 'y.f1log', '--capture'], /either --record or --capture/],
    [['--https-cert', 'c.pem'], /go together/],
    [['--https-cert', 'missing.pem', '--https-key', 'missing.key'], /can't read the https certificate/],
    [['--bogus'], /Unknown option/],
  ]) assert.throws(() => parseCli(args), msg, args.join(' '));
});
