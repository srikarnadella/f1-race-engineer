const test = require('node:test');
const assert = require('node:assert');
const { syntheticPackets, replay } = require('./helpers/synthetic');
const { parsePacket } = require('../src/udp/parsePacket');
const { rng } = require('./helpers/rng');

// The bridge binds UDP on every interface, so anything on the LAN can send
// it bytes. A bad packet may cost itself, never the engine tick or the
// dashboard. Seeded, so a failure reproduces.
const MUTATIONS = {
  truncate: (buf, r) => buf.subarray(0, Math.floor(r() * buf.length)),
  // Body bytes only: the header still says "this session, this packet".
  flipBody: (buf, r) => {
    const b = Buffer.from(buf);
    for (let n = 0; n < 1 + r() * 20; n++) b[29 + Math.floor(r() * (b.length - 29))] = Math.floor(r() * 256);
    return b;
  },
  // A real header, then noise of the right length: the worst case, it parses.
  noiseBody: (buf, r) => {
    const b = Buffer.from(buf);
    for (let i = 29; i < b.length; i++) b[i] = Math.floor(r() * 256);
    return b;
  },
  extend: (buf, r) => Buffer.concat([buf, Buffer.from(Array.from({ length: 1 + Math.floor(r() * 400) }, () => Math.floor(r() * 256)))]),
  random: (buf, r) => Buffer.from(Array.from({ length: Math.floor(r() * 1500) }, () => Math.floor(r() * 256))),
};

// Every number the dashboard gets must be finite: JSON turns NaN into null
// and Infinity into null silently, and a card then reads "null laps".
function nonFinite(value, path = '$', out = []) {
  if (typeof value === 'number' && !Number.isFinite(value)) out.push(path);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) nonFinite(v, `${path}.${k}`, out);
  return out;
}

for (const [name, mutate] of Object.entries(MUTATIONS)) {
  test(`fuzz (${name}): bad packets mid-race never break the tick or put a non-finite number on screen`, () => {
    const r = rng(name.length * 7919);
    const packets = syntheticPackets().slice(0, 12000);
    const bad = [];
    let accepted = 0;
    replay(packets, {
      // One in five real packets is followed by a mangled copy of itself.
      onPacket: (p, pipeline) => {
        if (r() < 0.2 && pipeline.feed(mutate(p.buf, r))) accepted++;
      },
      onTick: ({ tMs, snap }) => {
        const where = nonFinite(snap);
        if (where.length && bad.length < 5) bad.push(`${tMs} ms: ${where.slice(0, 3).join(', ')}`);
      },
    });
    assert.ok(accepted > 100, `only ${accepted} mangled packets got into the engine`);
    assert.deepStrictEqual(bad, []);
  });
}

test('fuzz: the parser returns a whole result or throws a RangeError - never anything else', () => {
  const r = rng(42);
  let parsed = 0;
  for (const { buf } of syntheticPackets().slice(0, 3000)) {
    let out;
    try {
      out = parsePacket(MUTATIONS.noiseBody(buf, r));
    } catch (err) {
      assert.ok(err instanceof RangeError, err.message);
      continue;
    }
    parsed++;
    assert.strictEqual(out.header.packetId, buf[6]);
    assert.ok(out.data === null || typeof out.data === 'object');
  }
  assert.ok(parsed > 100, 'most noisy packets still parse');
});

test('parser: a NaN float marks the packet corrupt', () => {
  const buf = Buffer.from(syntheticPackets().find((p) => p.buf[6] === 2).buf); // Lap Data
  buf.writeFloatLE(NaN, 29 + 20); // the first car's lapDistance, after 20 bytes of times
  assert.throws(() => parsePacket(buf), RangeError);
});
