const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { start } = require('../src/index');
const { createTrackMemory } = require('../src/state/trackMemory');
const { createOutlines } = require('../src/state/trackOutline');

// What a race teaches a track (pit loss, wear: state/trackMemory.js) and the map's outline (state/trackOutline.js) are
// both kept in the data folder. Saving one must never take the other away, and a file written by an older Undercut, where
// both shared tracks.json, must still give back both.
function quiet(t) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  t.after(() => Object.assign(console, { log, warn }));
}
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercut-tracks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10]];
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('track files: the bridge keeps the outlines apart from what races taught, and saving either keeps both', async (t) => {
  quiet(t);
  const dataDir = tmp(t);
  // As an older Undercut left it: a pit loss at track 5 and Spa's outline, side by side in one file.
  fs.writeFileSync(path.join(dataDir, 'tracks.json'), JSON.stringify({ 5: { pitLossMs: [{ v: 21000, s: '111' }] }, 10: SQUARE }));
  const bridge = start({ httpPort: 0, udpPort: 0, udpHost: '127.0.0.1', dataDir });
  if (!bridge.server.listening) await once(bridge.server, 'listening');
  await bridge.stop();
  const outlines = path.join(dataDir, 'outlines.json');
  assert.ok(fs.existsSync(outlines), 'the outlines have a file of their own');
  assert.deepStrictEqual(read(outlines)[10], SQUARE, 'the old outline was carried over');
  assert.deepStrictEqual(read(path.join(dataDir, 'tracks.json'))[5], { pitLossMs: [{ v: 21000, s: '111' }] }, 'the pit loss is untouched');
});

test('track files: memory and outlines saved over and over in one data folder both come back after a restart', (t) => {
  const dir = tmp(t);
  const memFile = path.join(dir, 'tracks.json');
  const outFile = path.join(dir, 'outlines.json');
  const mem = createTrackMemory(memFile);
  const out = createOutlines({ file: outFile, legacyFile: memFile });
  mem.add(5, 'pitLossMs', 21000, '111');
  for (let lap = 0; lap < 2; lap++) for (let d = 0; d < 1000; d += 2) out.observe({ trackId: 5, length: 1000, distance: d, x: Math.cos(d / 159), z: Math.sin(d / 159), speedKmh: 200, inPit: false });
  mem.add(5, 'pitLossMs', 22000, '222');
  assert.deepStrictEqual(createTrackMemory(memFile).get(5, 'pitLossMs'), [21000, 22000]);
  const outline = createOutlines({ file: outFile, legacyFile: memFile }).get(5);
  assert.ok(Array.isArray(outline) && outline.length > 100, 'the outline is a list of points');
});

test('track files: a file already mixed up by the old bug gives each side only its own entries', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'tracks.json');
  fs.writeFileSync(file, JSON.stringify({ 5: { pitLossMs: [{ v: 21000, s: '111' }] }, 10: SQUARE }));
  const mem = createTrackMemory(file);
  assert.deepStrictEqual(Object.keys(mem.all()), ['5'], 'an outline is not a track memory');
  const out = createOutlines({ file: path.join(dir, 'outlines.json'), legacyFile: file });
  assert.strictEqual(out.get(5), null, 'a pit loss is not an outline');
  assert.deepStrictEqual(out.get(10), SQUARE);
  // An outlines file that a memory save overwrote: the object in it is not an outline, so the track can be drawn again.
  fs.writeFileSync(path.join(dir, 'outlines.json'), JSON.stringify({ 5: { pitLossMs: [21000] } }));
  assert.strictEqual(createOutlines({ file: path.join(dir, 'outlines.json') }).get(5), null);
});
