const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeXlsx } = require('./helpers/xlsx');
const { syntheticPackets, replay } = require('./helpers/synthetic');
const { start } = require('../src/index');

// The setup sheet, imported once into the app's own data folder (setups.json), then compared live. The synthetic race is
// at the Red Bull Ring.
const HEADER = ['Circuit', 'Aero', 'Differential', 'Susp. geometry', 'Suspension', 'Brakes', 'Tires Q', 'Tires R', 'Compounds', 'Strategy (50%)', 'Fuel 50%', 'Laps 50%', 'Quali recharge (MJ)', 'Race recharge', 'Notes'];
const austria = ['Austria', '50-12q 50-24r', '100-60', 'LLLL', '41-41-1-6-20-47', '98q 97r/56-57', '29.5-20.5', '29.5-20.5', 'C3-C5', 'MH 14-16', '', 36, '', '', 'moderately easy onestop'];

test('setup import: a pipeline given the sheet compares the car to the track it is at, on every tick', () => {
  const { parseSetupSheet } = require('../src/data/setupSheet');
  const dir = tmpDirSync();
  const file = path.join(dir, 's.xlsx');
  fs.writeFileSync(file, makeXlsx([{ name: 'F1 26', rows: [['x'], HEADER, austria] }]));
  const setups = parseSetupSheet(file);
  fs.rmSync(dir, { recursive: true, force: true });
  let last = null;
  replay(syntheticPackets(), { pipelineOptions: { setups }, onTick: ({ snap }) => { last = snap; } });
  assert.strictEqual(last.setup.available, true);
  assert.strictEqual(last.setup.circuit, 'Austria');
  assert.strictEqual(last.setup.rows.length, 14);
  assert.strictEqual(last.setup.kind, 'r');
  assert.strictEqual(last.setup.editable, false, 'a race');
  assert.ok(last.setup.rows.some((r) => r.current != null), 'the car\'s own values are there');
});

test('setup import: without a sheet the snapshot says there is nothing to compare, and the rest is unchanged', () => {
  let last = null;
  replay(syntheticPackets(), { onTick: ({ snap }) => { last = snap; } });
  assert.strictEqual(last.setup.available, false);
  assert.deepStrictEqual(last.setup.rows, []);
});

function tmpDirSync() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'undercut-setups-'));
}

// Bridges hold race.db and a port open: every one started here is stopped before its folder is removed.
function bridges(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercut-setups-'));
  const started = [];
  const quiet = console.log;
  console.log = () => {};
  t.after(async () => {
    console.log = quiet;
    for (const b of started) await b.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, begin: () => { const b = start({ httpPort: 0, udpPort: 0, udpHost: '127.0.0.1', dataDir }); started.push(b); return b; } };
}

test('bridge: importing the spreadsheet writes setups.json in the data folder, takes effect at once, and survives a restart', async (t) => {
  const { dataDir, begin } = bridges(t);
  const file = path.join(dataDir, 'sheet.xlsx');
  fs.writeFileSync(file, makeXlsx([{ name: 'F1 26', rows: [['x'], HEADER, austria] }]));
  const bridge = begin();
  assert.strictEqual(bridge.setupsInfo(), null, 'nothing imported yet');
  const done = await bridge.importSetups(file);
  assert.deepStrictEqual(done, { game: 'F1 26', circuits: 1 });
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'setups.json'), 'utf8'));
  assert.strictEqual(saved.circuits[0].track, 'Red Bull Ring');
  assert.deepStrictEqual(bridge.setupsInfo(), { game: 'F1 26', circuits: 1 });
  await bridge.stop();
  const again = begin();
  assert.deepStrictEqual(again.setupsInfo(), { game: 'F1 26', circuits: 1 });
});

test('bridge: a spreadsheet that cannot be read is refused and leaves the earlier import alone', async (t) => {
  const { dataDir, begin } = bridges(t);
  const good = path.join(dataDir, 'good.xlsx');
  fs.writeFileSync(good, makeXlsx([{ name: 'F1 26', rows: [['x'], HEADER, austria] }]));
  const bad = path.join(dataDir, 'bad.xlsx');
  fs.writeFileSync(bad, 'this is not a spreadsheet');
  const bridge = begin();
  await bridge.importSetups(good);
  await assert.rejects(bridge.importSetups(bad), /spreadsheet/i);
  assert.strictEqual(bridge.setupsInfo().circuits, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'setups.json'), 'utf8')).circuits.length, 1);
  const wrongTab = path.join(dataDir, 'tab.xlsx');
  fs.writeFileSync(wrongTab, makeXlsx([{ name: 'F1 24', rows: [['x']] }]));
  await assert.rejects(bridge.importSetups(wrongTab), /F1 26/);
  const empty = path.join(dataDir, 'empty.xlsx');
  fs.writeFileSync(empty, makeXlsx([{ name: 'F1 26', rows: [['x'], HEADER] }]));
  await assert.rejects(bridge.importSetups(empty), /no circuits/i);
  assert.strictEqual(bridge.setupsInfo().circuits, 1, 'still the first import');
});
