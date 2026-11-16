// The community setup spreadsheet (a tab per game year, a row per circuit: aero, differential, suspension, brakes,
// tyre pressures, compounds, strategy, notes) read into plain numbers, so the app can show the setup for the track
// you are at beside the one on your car. An .xlsx is a zip of XML; the few parts needed are read here with zlib, so
// no spreadsheet library is added.
//
// Cell formats (from the real F1 26 tab): "q" after a value is qualifying, "r" the race, nothing is both:
//   aero 30-0q / 42-15r   differential 100-45q 60r   suspension 41-38-1-5-21-47 (front, rear, front ARB, rear ARB,
//   front height, rear height)   brakes 98q 97r/56-57 (pressure, then bias, a range)   tyres 29.5 20.5 (front, rear).
// shortcut: the suspension geometry cell ("LLLL") is kept as text: what its letters mean isn't written down in the sheet.
const fs = require('fs');
const zlib = require('zlib');

// The sheet's circuit names against the game's own (src/udp/gameIds.js TRACKS); one the game list lacks keeps its name.
const GAME_TRACK = {
  Australia: 'Melbourne', China: 'Shanghai', Japan: 'Suzuka', Bahrain: 'Bahrain', 'Saudi Arabia': 'Jeddah', Miami: 'Miami', Canada: 'Montreal',
  Monaco: 'Monaco', Catalunya: 'Barcelona', Austria: 'Red Bull Ring', Britain: 'Silverstone', Belgium: 'Spa', Hungary: 'Hungaroring',
  Netherlands: 'Zandvoort', Italy: 'Monza', Azerbaijan: 'Baku', Singapore: 'Singapore', 'United States': 'Austin', Mexico: 'Mexico City',
  Brazil: 'Interlagos', 'Las Vegas': 'Las Vegas', Qatar: 'Losail', 'Abu Dhabi': 'Abu Dhabi', Imola: 'Imola',
};

// ---------- the zip ----------
function readZip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Not an .xlsx file (no zip directory)');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged .xlsx file');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files.set(name, () => (method === 0 ? data : zlib.inflateRawSync(data)).toString('utf8'));
    p += 46 + nameLen + extra + comment;
  }
  return files;
}

// ---------- the XML ----------
const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const textOf = (xml) => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1])).join('');
const colIndex = (ref) => [...ref.match(/^[A-Z]+/)[0]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function sheetRows(xml, strings) {
  const rows = [];
  for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells = [];
    for (const c of (row[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs);
      if (!ref) continue;
      const type = (/\bt="(\w+)"/.exec(attrs) || [])[1];
      const body = c[2] || '';
      let value = '';
      if (type === 'inlineStr') value = textOf(body);
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        if (v) value = type === 's' ? strings[+v[1]] ?? '' : unescape(v[1]);
      }
      cells[colIndex(ref[1])] = value;
    }
    rows.push(Array.from(cells, (x) => (x == null ? '' : String(x))));
  }
  return rows;
}

// ---------- the cells ----------
const num = (s) => Number(s);

// '50-22' | '30-0q / 42-15r' | '50-12q 50-24r' -> { q: { front, rear }, r: { front, rear } }
function parseAero(text) {
  const s = String(text || '').trim();
  const out = {};
  for (const m of s.matchAll(/(\d+)\s*-\s*(\d+)\s*([qr])/gi)) out[m[3].toLowerCase()] = { front: num(m[1]), rear: num(m[2]) };
  if (out.q || out.r) return { q: out.q || out.r, r: out.r || out.q };
  const one = /^(\d+)\s*-\s*(\d+)$/.exec(s);
  return one ? { q: { front: num(one[1]), rear: num(one[2]) }, r: { front: num(one[1]), rear: num(one[2]) } } : null;
}

// '100-65' | '100-45q 60r' -> { q: { on, off }, r: { on, off } }
function parseDiff(text) {
  const s = String(text || '').trim();
  const head = /^(\d+)\s*-\s*(\d+)\s*([qr])?(?:\s+(\d+)\s*([qr]))?$/i.exec(s);
  if (!head) return null;
  const on = num(head[1]);
  const offs = {};
  if (head[3]) offs[head[3].toLowerCase()] = num(head[2]);
  if (head[5]) offs[head[5].toLowerCase()] = num(head[4]);
  if (!head[3]) return { q: { on, off: num(head[2]) }, r: { on, off: num(head[2]) } };
  return { q: { on, off: offs.q ?? offs.r }, r: { on, off: offs.r ?? offs.q } };
}

function parseSuspension(text) {
  const m = /^(\d+)-(\d+)-(\d+)-(\d+)-(\d+)-(\d+)$/.exec(String(text || '').trim());
  if (!m) return null;
  const [frontSuspension, rearSuspension, frontAntiRollBar, rearAntiRollBar, frontHeight, rearHeight] = m.slice(1).map(num);
  return { frontSuspension, rearSuspension, frontAntiRollBar, rearAntiRollBar, frontHeight, rearHeight };
}

// '98/56' | '98q 97r/56-57' | '97/59-60' -> { pressure: { q, r }, bias: { lo, hi } }
function parseBrakes(text) {
  const [pressureText, biasText] = String(text || '').split('/').map((x) => x.trim());
  const bias = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(biasText || '');
  if (!pressureText || !bias) return null;
  const tagged = {};
  let plain = null;
  for (const m of pressureText.matchAll(/(\d+)\s*([qr])?/gi)) {
    if (m[2]) tagged[m[2].toLowerCase()] = num(m[1]);
    else plain = num(m[1]);
  }
  const q = tagged.q ?? tagged.r ?? plain;
  const r = tagged.r ?? tagged.q ?? plain;
  return q == null ? null : { pressure: { q, r }, bias: { lo: num(bias[1]), hi: num(bias[2] ?? bias[1]) } };
}

// '29.5 20.5' | '29.5-26.5' -> { front, rear }
function parseTyres(text) {
  const m = /^(\d+(?:\.\d+)?)[\s-]+(\d+(?:\.\d+)?)$/.exec(String(text || '').trim());
  return m ? { front: num(m[1]), rear: num(m[2]) } : null;
}

// 'C3-C5' -> [3, 4, 5]; 'C1, C3, C4' -> [1, 3, 4]
function parseCompounds(text) {
  const s = String(text || '');
  const nums = [...s.matchAll(/C(\d)/g)].map((m) => num(m[1]));
  if (!nums.length) return [];
  if (/C\d\s*-\s*C\d/.test(s) && nums.length === 2) return Array.from({ length: nums[1] - nums[0] + 1 }, (_, i) => nums[0] + i);
  return nums;
}

const maybeNumber = (s) => (s !== '' && !Number.isNaN(Number(s)) ? Number(s) : null);

// path: the .xlsx; game: the tab to read ('F1 26'). Returns { game, circuits: [...] }.
function parseSetupSheet(file, game = 'F1 26') {
  const zip = readZip(fs.readFileSync(file));
  const get = (name) => (zip.has(name) ? zip.get(name)() : null);
  const workbook = get('xl/workbook.xml');
  const rels = get('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw new Error('Not a spreadsheet this reader understands');
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*?\bId="([^"]+)"[^>]*?\bTarget="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const tab = [...workbook.matchAll(/<sheet\b[^>]*?\bname="([^"]*)"[^>]*?\br:id="([^"]+)"/g)].find((m) => unescape(m[1]).trim() === game);
  if (!tab) throw new Error(`The spreadsheet has no "${game}" tab`);
  const strings = [...(get('xl/sharedStrings.xml') || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const rows = sheetRows(get(`xl/${target.get(tab[2]).replace(/^\//, '').replace(/^xl\//, '')}`), strings);

  const headAt = rows.findIndex((r) => r[0] === 'Circuit');
  if (headAt < 0) throw new Error('No "Circuit" header row in the tab');
  const head = rows[headAt];
  const at = (name) => head.findIndex((h) => h && h.toLowerCase().startsWith(name.toLowerCase()));
  const col = { aero: at('Aero'), diff: at('Differential'), geometry: at('Susp. geometry'), suspension: at('Suspension'), brakes: at('Brakes'), tq: at('Tires Q'), tr: at('Tires R'), compounds: at('Compounds'), strategy: at('Strategy'), fuel: at('Fuel'), laps: at('Laps'), rq: at('Quali recharge'), rr: at('Race recharge'), notes: at('Notes') };
  const cell = (r, k) => (col[k] >= 0 ? (r[col[k]] || '').trim() : '');

  const circuits = [];
  for (const r of rows.slice(headAt + 1)) {
    if (!r[0] || !r[0].trim()) break;
    const circuit = r[0].trim();
    const tq = parseTyres(cell(r, 'tq'));
    circuits.push({
      circuit,
      track: GAME_TRACK[circuit] || circuit,
      aero: parseAero(cell(r, 'aero')),
      diff: parseDiff(cell(r, 'diff')),
      geometry: cell(r, 'geometry') || null,
      suspension: parseSuspension(cell(r, 'suspension')),
      brakes: parseBrakes(cell(r, 'brakes')),
      tyres: tq || parseTyres(cell(r, 'tr')) ? { q: tq || parseTyres(cell(r, 'tr')), r: parseTyres(cell(r, 'tr')) || tq } : null,
      compounds: parseCompounds(cell(r, 'compounds')),
      strategy: cell(r, 'strategy') || null,
      fuel: cell(r, 'fuel') || null,
      laps: maybeNumber(cell(r, 'laps')),
      rechargeQ: maybeNumber(cell(r, 'rq')),
      rechargeR: maybeNumber(cell(r, 'rr')),
      notes: cell(r, 'notes') || null,
    });
  }
  return { game, circuits };
}

module.exports = { parseSetupSheet, parseAero, parseDiff, parseSuspension, parseBrakes, parseTyres, parseCompounds };
