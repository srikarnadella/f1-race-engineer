const test = require('node:test');
const assert = require('node:assert');
const { syntheticPackets, replay } = require('./helpers/synthetic');
const { rng } = require('./helpers/rng');

// Feed health: is the telemetry arriving, how fast, and how much is lost on
// the way? Over Wi-Fi from a console, packets drop; a call made on a feed
// missing a third of its packets should say so. Loss is read from the game's
// overall frame counter on Car Telemetry, which is sent once per send-rate
// step: 1 frame apart at 60 Hz, 3 at 20 Hz, 6 in the synthetic race.
const TELEMETRY = 6;

function feedAfter(dropIf) {
  let last = null;
  replay(syntheticPackets().filter((p, i) => !(p.buf[6] === TELEMETRY && dropIf(i))), {
    onTick: ({ snap }) => { last = snap.feed; },
  });
  return last;
}

test('feed: an intact feed reads its rate and no loss', () => {
  const feed = feedAfter(() => false);
  assert.ok(Math.abs(feed.rateHz - 10) < 0.5, `rate ${feed.rateHz} Hz (telemetry every 100 ms)`);
  assert.strictEqual(feed.lossPct, 0);
});

test('feed: dropping every 10th telemetry packet reads as 10% loss', () => {
  let n = 0;
  const feed = feedAfter((i) => ++n % 10 === 0);
  assert.ok(Math.abs(feed.lossPct - 10) < 1, `loss ${feed.lossPct}%`);
  assert.ok(Math.abs(feed.rateHz - 9) < 0.5, `rate ${feed.rateHz} Hz`);
});

test('feed: random 5% loss reads as about 5%, averaged over the race', () => {
  // One 10 s window holds ~100 packets, so a single reading is 5 +/- 2.2 by chance alone.
  const r = rng(21);
  const readings = [];
  replay(syntheticPackets().filter((p) => !(p.buf[6] === TELEMETRY && r() < 0.05)), {
    onTick: ({ tMs, snap }) => { if (tMs > 10000 && tMs % 1000 < 100) readings.push(snap.feed.lossPct); },
  });
  const mean = readings.reduce((a, b) => a + b, 0) / readings.length;
  assert.ok(Math.abs(mean - 5) < 1, `mean loss ${mean.toFixed(2)}% over ${readings.length} readings`);
});

test('feed: a pause in the game is not loss, and the reading restarts after it', () => {
  // 30 s with nothing (paused, a menu), then the race carries on, 600 frames later.
  const packets = syntheticPackets();
  const cut = packets.findIndex((p) => p.tMs > 60000);
  const shifted = packets.slice(cut).map((p) => {
    const buf = Buffer.from(p.buf);
    buf.writeUInt32LE(buf.readUInt32LE(23) + 600, 23);
    return { tMs: p.tMs + 30000, buf };
  });
  let atResume = null;
  let last = null;
  replay([...packets.slice(0, cut), ...shifted], {
    onTick: ({ tMs, snap }) => {
      if (atResume === null && tMs > 60000 + 30000 + 2000) atResume = snap.feed;
      last = snap.feed;
    },
  });
  assert.strictEqual(atResume.lossPct, 0, 'the gap was a pause');
  assert.strictEqual(last.lossPct, 0);
});

test('feed: nothing yet is "no reading", not 0% loss', () => {
  let first = null;
  replay(syntheticPackets().slice(0, 3), { onTick: ({ snap }) => { if (!first) first = snap.feed; } });
  assert.deepStrictEqual(first, { rateHz: null, lossPct: null });
});
