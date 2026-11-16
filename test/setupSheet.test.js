const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeXlsx } = require('./helpers/xlsx');
const { parseSetupSheet, parseAero, parseDiff, parseSuspension, parseBrakes, parseTyres, parseCompounds } = require('../src/data/setupSheet');

// The community setup spreadsheet (one tab per game year, one row per circuit) read into plain numbers. The cell formats
// below are copied from the real F1 26 tab: a "q" suffix is qualifying, an "r" suffix the race, nothing means both.

test('setup sheet: aero is front-rear wing, split into qualifying and race when the cell says so', () => {
  assert.deepStrictEqual(parseAero('50-22'), { q: { front: 50, rear: 22 }, r: { front: 50, rear: 22 } });
  assert.deepStrictEqual(parseAero('30-0q / 42-15r'), { q: { front: 30, rear: 0 }, r: { front: 42, rear: 15 } });
  assert.deepStrictEqual(parseAero('50-12q 50-24r'), { q: { front: 50, rear: 12 }, r: { front: 50, rear: 24 } });
  assert.deepStrictEqual(parseAero('41-0'), { q: { front: 41, rear: 0 }, r: { front: 41, rear: 0 } });
  assert.strictEqual(parseAero(''), null);
  assert.strictEqual(parseAero('see notes'), null);
});

test('setup sheet: differential is on-throttle then off-throttle, the off-throttle may differ for qualifying and the race', () => {
  assert.deepStrictEqual(parseDiff('100-65'), { q: { on: 100, off: 65 }, r: { on: 100, off: 65 } });
  assert.deepStrictEqual(parseDiff('100-45q 60r'), { q: { on: 100, off: 45 }, r: { on: 100, off: 60 } });
  assert.deepStrictEqual(parseDiff('100-75q 80r'), { q: { on: 100, off: 75 }, r: { on: 100, off: 80 } });
  assert.strictEqual(parseDiff(''), null);
});

test('setup sheet: suspension is the six numbers in the car menu order', () => {
  assert.deepStrictEqual(parseSuspension('41-38-1-5-21-47'), { frontSuspension: 41, rearSuspension: 38, frontAntiRollBar: 1, rearAntiRollBar: 5, frontHeight: 21, rearHeight: 47 });
  assert.strictEqual(parseSuspension('41-38-1'), null);
});

test('setup sheet: brakes are pressure then bias; pressure may differ for qualifying and the race, bias may be a range', () => {
  assert.deepStrictEqual(parseBrakes('98/56'), { pressure: { q: 98, r: 98 }, bias: { lo: 56, hi: 56 } });
  assert.deepStrictEqual(parseBrakes('98q 97r/56-57'), { pressure: { q: 98, r: 97 }, bias: { lo: 56, hi: 57 } });
  assert.deepStrictEqual(parseBrakes('100q 97r/57'), { pressure: { q: 100, r: 97 }, bias: { lo: 57, hi: 57 } });
  assert.deepStrictEqual(parseBrakes('97/59-60'), { pressure: { q: 97, r: 97 }, bias: { lo: 59, hi: 60 } });
  assert.strictEqual(parseBrakes(''), null);
});

test('setup sheet: tyre pressures are front then rear, separated by a space or a dash', () => {
  assert.deepStrictEqual(parseTyres('29.5 20.5'), { front: 29.5, rear: 20.5 });
  assert.deepStrictEqual(parseTyres('29.5-26.5'), { front: 29.5, rear: 26.5 });
  assert.deepStrictEqual(parseTyres('23.0 20.5'), { front: 23, rear: 20.5 });
  assert.strictEqual(parseTyres(''), null);
});

test('setup sheet: compounds are a range or a list of C numbers', () => {
  assert.deepStrictEqual(parseCompounds('C3-C5'), [3, 4, 5]);
  assert.deepStrictEqual(parseCompounds('C1, C3, C4'), [1, 3, 4]);
  assert.deepStrictEqual(parseCompounds('C2-C4'), [2, 3, 4]);
  assert.deepStrictEqual(parseCompounds(''), []);
});

const HEADER = ['Circuit', 'Aero', 'Differential', 'Susp. geometry', 'Suspension', 'Brakes', 'Tires Q', 'Tires R', 'Compounds', 'Strategy (50%)', 'Fuel 50%', 'Laps 50%', 'Quali recharge (MJ)', 'Race recharge', 'Notes'];
const spa = ['Belgium', '22-0', '100-45', 'LLLL', '41-41-1-5-20-46', '100/57', '29.5-26.5', '29.5-26.5', 'C2-C4', 'HM 13-15, MH 7-9', '', 22, '', 7.6, 'Casa di Cancro'];
const aus = ['Australia', '30-0q / 42-15r', '100-45q 60r', 'LLLL', '41-38-1-5-21-47', '98/56', '29.5 20.5', '29.5 20.5', 'C3-C5', 'MH 11-13/HM 16-18', '27.5 laps / -1.9', 29, 6, 6, 'lico hell'];

function fixture(t) {
  const file = path.join(require('os').tmpdir(), `setups-${process.pid}-${Math.random().toString(36).slice(2)}.xlsx`);
  fs.writeFileSync(file, makeXlsx([
    { name: 'F1 26', rows: [['SHEET WILL NOT BE UPDATED'], HEADER, aus, spa, [], ['Tire Temperatures'], ['C1', '95 - 115']] },
    { name: 'F1 25 ', rows: [['x'], HEADER, ['Belgium', '99-99']] },
  ]));
  t.after(() => fs.rmSync(file, { force: true }));
  return file;
}

test('setup sheet: the F1 26 tab becomes one entry per circuit, mapped to the game\'s track name', (t) => {
  const sheet = parseSetupSheet(fixture(t));
  assert.strictEqual(sheet.game, 'F1 26');
  assert.deepStrictEqual(sheet.circuits.map((c) => c.track), ['Melbourne', 'Spa']);
  const aust = sheet.circuits[0];
  assert.strictEqual(aust.circuit, 'Australia');
  assert.deepStrictEqual(aust.aero.q, { front: 30, rear: 0 });
  assert.deepStrictEqual(aust.aero.r, { front: 42, rear: 15 });
  assert.deepStrictEqual(aust.diff.r, { on: 100, off: 60 });
  assert.strictEqual(aust.suspension.rearHeight, 47);
  assert.deepStrictEqual(aust.brakes.bias, { lo: 56, hi: 56 });
  assert.deepStrictEqual(aust.tyres.q, { front: 29.5, rear: 20.5 });
  assert.deepStrictEqual(aust.compounds, [3, 4, 5]);
  assert.strictEqual(aust.strategy, 'MH 11-13/HM 16-18');
  assert.strictEqual(aust.notes, 'lico hell');
  assert.strictEqual(aust.geometry, 'LLLL');
});

test('setup sheet: it stops at the first blank row, ignores the other tabs, and refuses a file with no tab for the game', (t) => {
  const sheet = parseSetupSheet(fixture(t));
  assert.strictEqual(sheet.circuits.length, 2, 'the tyre temperature block below is not a circuit');
  const file = path.join(require('os').tmpdir(), `setups-bad-${process.pid}.xlsx`);
  fs.writeFileSync(file, makeXlsx([{ name: 'Sheet1', rows: [['nothing']] }]));
  t.after(() => fs.rmSync(file, { force: true }));
  assert.throws(() => parseSetupSheet(file), /F1 26/);
  assert.throws(() => parseSetupSheet(path.join(__dirname, 'no-such.xlsx')), /ENOENT|no such/i);
});

test('setup sheet: a circuit row with a cell it cannot read keeps the rest and leaves that part empty', (t) => {
  const file = path.join(require('os').tmpdir(), `setups-odd-${process.pid}.xlsx`);
  fs.writeFileSync(file, makeXlsx([{ name: 'F1 26', rows: [['x'], HEADER, ['Monaco', '50-50', '100-30', 'LLLL', '38-41-1-4-21-46', '100/56', '22.5 20.5', '22.5 20.5', 'C3-C5', 'MH 11-13, SH ??-??', 'Yes', 39, 'Yes', 'Yes', 'Diarrhea track'], ['Imola', '??', '', 'LLLL', 'who knows', '', '', '', '', '', '', '', '', '', '']] }]));
  t.after(() => fs.rmSync(file, { force: true }));
  const sheet = parseSetupSheet(file);
  const imola = sheet.circuits.find((c) => c.track === 'Imola');
  assert.strictEqual(imola.aero, null);
  assert.strictEqual(imola.suspension, null);
  assert.strictEqual(imola.diff, null);
  assert.strictEqual(sheet.circuits.find((c) => c.track === 'Monaco').suspension.frontSuspension, 38);
});

test('setup sheet: the real F1 26 tab, when the file is here', { skip: fs.existsSync(path.join(__dirname, '..', 'notes', 'F1 game setups (22-26).xlsx')) ? false : 'not in this checkout (notes/ is private)' }, () => {
  const sheet = parseSetupSheet(path.join(__dirname, '..', 'notes', 'F1 game setups (22-26).xlsx'));
  assert.ok(sheet.circuits.length >= 24, String(sheet.circuits.length));
  const by = (n) => sheet.circuits.find((c) => c.circuit === n);
  assert.deepStrictEqual(by('Australia').aero.q, { front: 30, rear: 0 });
  assert.deepStrictEqual(by('Belgium').aero.r, { front: 22, rear: 0 });
  assert.deepStrictEqual(by('Austria').brakes.pressure, { q: 98, r: 97 });
  assert.deepStrictEqual(by('Britain').brakes.bias, { lo: 59, hi: 60 });
  for (const c of sheet.circuits) {
    assert.ok(c.track, `${c.circuit} has no game track name`);
    for (const k of ['aero', 'diff', 'suspension', 'brakes', 'tyres']) assert.ok(c[k], `${c.circuit} ${k} did not parse`);
  }
});
