// The recordings on disk (<data>/captures/<name>/), for the desktop Library:
// what each one is, its size, and the analyzer's report once there is one.
// Names come from the window, so each is checked to be a plain folder name
// before it touches the disk.
const fs = require('fs');
const path = require('path');
const { readLog } = require('../src/capture/logFile');
const { parsePacket } = require('../src/udp/parsePacket');
const { TRACKS, SESSION_TYPES } = require('../src/udp/gameIds');

const NAME = /^[\w-][\w.-]{0,63}$/;
const PACKET_FILES = ['packets.f1log.gz', 'packets.f1log'];
const SESSION_PACKET = 1;

function captureDir(root, name) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('No such recording');
  return path.join(root, name);
}
const packetsFile = (dir) => PACKET_FILES.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f)) || null;

// The first Session packet says where and what: only the start of the file is read.
// shortcut: a recording that spans several sessions is named after its first.
const identity = new Map(); // packets file + size -> { track, session }
async function identify(file, bytes) {
  const key = `${file}:${bytes}`;
  if (identity.has(key)) return identity.get(key);
  let found = { track: null, session: null };
  let n = 0;
  try {
    for await (const { buf } of readLog(file, { badLines: 0, truncated: false })) {
      if (++n > 5000) break;
      if (buf.length < 7 || buf.readUInt8(6) !== SESSION_PACKET) continue;
      const { data } = parsePacket(buf);
      if (!data) continue;
      found = { track: TRACKS[data.trackId] || null, session: SESSION_TYPES[data.sessionType] || null };
      break;
    }
  } catch {
    // an unreadable start: listed without a name
  }
  identity.set(key, found);
  return found;
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// Newest first. A folder without packets (a menu test) isn't a recording.
async function listCaptures(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    if (!NAME.test(name)) continue;
    const dir = path.join(root, name);
    const file = fs.statSync(dir).isDirectory() ? packetsFile(dir) : null;
    if (!file || fs.statSync(file).size === 0) continue;
    const bytes = fs.readdirSync(dir).reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
    const meta = readJson(path.join(dir, 'meta.json'));
    const markFile = path.join(dir, 'markers.jsonl');
    const marks = fs.existsSync(markFile)
      ? new Set(fs.readFileSync(markFile, 'utf8').split('\n').filter(Boolean).map((l) => readJsonLine(l)).filter(Boolean)).size
      : 0;
    const report = readJson(path.join(dir, 'report.json'));
    out.push({
      name,
      bytes,
      startedAt: meta && meta.startedAt ? Date.parse(meta.startedAt) : fs.statSync(dir).mtimeMs,
      marks,
      report: report ? summarizeReport(report) : null,
      ...(await identify(file, fs.statSync(file).size)),
    });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}
// A marker line's id: a tap and the tag chosen afterwards are one mark.
function readJsonLine(line) {
  try {
    return JSON.parse(line).id || null;
  } catch {
    return null;
  }
}

// What the Library shows of report.json (src/capture/analyze.js).
function summarizeReport(r) {
  return {
    checks: (r.checks || []).map(({ name, status, detail }) => ({ name, status, detail })),
    laps: (r.laps || []).length,
    marks: (r.markers || []).map((m) => ({ tag: m.tag, note: m.note || null, lap: m.lap == null ? null : m.lap, tMs: m.tMs })),
    durationS: r.capture ? r.capture.durationS : null,
  };
}

async function deleteCapture(root, name) {
  await fs.promises.rm(captureDir(root, name), { recursive: true, force: true });
}

module.exports = { listCaptures, captureDir, deleteCapture, packetsFile, summarizeReport };
