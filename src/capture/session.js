const fs = require('fs');
const path = require('path');
const { createRecorder } = require('./recorder');
const { openLogWriter } = require('./logFile');

// A capture session is one folder holding everything needed to validate the
// tool against a real race afterwards (`npm run analyze -- <folder>`):
//
//   packets.f1log.gz  every raw UDP packet, replayable through the pipeline
//   outputs.jsonl     what the dashboard told the driver, as it changed
//   markers.jsonl     moments the driver flagged from the dashboard
//   meta.json         when, which build, which options
//
// All three logs share one clock (ms since the capture started), so a
// marker can be lined up with the packets and the calls around it.

const MARK_TAGS = new Set(['mark', 'wrong-call', 'missed-call', 'good-call', 'lockup', 'wheelspin', 'understeer', 'other']);
const STATUS_EVERY_MS = 10000;
const PACKET_NAMES = ['Motion', 'Session', 'LapData', 'Event', 'Participants', 'CarSetups', 'CarTelemetry', 'CarStatus', 'FinalClassification', 'LobbyInfo', 'CarDamage', 'SessionHistory', 'TyreSets', 'MotionEx', 'TimeTrial', 'LapPositions', 'CarTelemetry2'];

function defaultCaptureDir(root) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return path.join(root, 'captures', stamp);
}

function createCaptureSession({ dir, meta = {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const startedAt = Date.now();
  const t = () => Date.now() - startedAt;
  const packets = createRecorder(path.join(dir, 'packets.f1log.gz'), startedAt);
  const outputs = openLogWriter(path.join(dir, 'outputs.jsonl'));
  const markers = openLogWriter(path.join(dir, 'markers.jsonl'));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ startedAt: new Date(startedAt).toISOString(), ...meta }, null, 2));

  const counts = new Map(); // packetId -> count since the last status line
  let totalPackets = 0;
  let markCount = 0;
  let lastFormat = null;

  function recordPacket(buf) {
    packets.record(buf);
    totalPackets++;
    if (buf.length >= 7) {
      const id = buf.readUInt8(6);
      counts.set(id, (counts.get(id) || 0) + 1);
      lastFormat = buf.readUInt16LE(0);
    }
  }

  // --- What the dashboard said, logged only when it changes ---
  let prevInsights = new Map();
  let prevCall = '';
  let prevAdjust = '';
  let prevWeather = '';
  let prevConnected = null;
  const out = (kind, data) => outputs.write(JSON.stringify({ tMs: t(), kind, ...data }));

  function logOutputs(s) {
    if (s.connected !== prevConnected) {
      prevConnected = s.connected;
      out('connection', { connected: s.connected });
    }
    const now = new Map((s.insights || []).map((i) => [i.id, `${i.severity}|${i.message}`]));
    for (const [id, sig] of now) {
      if (prevInsights.get(id) !== sig) {
        const [severity, message] = [sig.slice(0, sig.indexOf('|')), sig.slice(sig.indexOf('|') + 1)];
        out(prevInsights.has(id) ? 'insight.change' : 'insight.add', { id, severity, message });
      }
    }
    for (const id of prevInsights.keys()) if (!now.has(id)) out('insight.remove', { id });
    prevInsights = now;

    const call = s.strategy ? `${s.strategy.call.action}|${s.strategy.call.reason}` : '';
    if (call !== prevCall) {
      prevCall = call;
      if (s.strategy) out('call', { action: s.strategy.call.action, reason: s.strategy.call.reason });
    }
    const adjust = s.adjust ? s.adjust.suggestions.map((x) => `${x.action} @ ${x.where}`).join(' ; ') : '';
    if (adjust !== prevAdjust) {
      prevAdjust = adjust;
      out('adjust', { suggestions: s.adjust ? s.adjust.suggestions.map(({ id, kind, action, where, why }) => ({ id, kind, action, where, why })) : [] });
    }
    const wx = s.analysis && s.analysis.weather;
    const weather = wx ? `${wx.trackState}|${wx.nextChange ? `${wx.nextChange.to}:${Math.round(wx.nextChange.inLaps)}` : ''}` : '';
    if (weather !== prevWeather) {
      prevWeather = weather;
      if (wx) out('weather', { trackState: wx.trackState, nextChange: wx.nextChange, now: wx.now });
    }
  }

  // A driver's flag from the dashboard. `context` is the live game state at
  // that moment, so the marker reads on its own even before analysis.
  // Re-sending the same id (a tag chosen after the tap) updates it; the
  // analyzer keeps the last line per id.
  function addMarker(msg, context) {
    if (!msg || typeof msg.id !== 'string' || msg.id.length > 40) return false;
    const tag = MARK_TAGS.has(msg.tag) ? msg.tag : 'mark';
    const note = typeof msg.note === 'string' ? msg.note.slice(0, 200) : undefined;
    markers.write(JSON.stringify({ tMs: t(), id: msg.id, tag, note, ...context }));
    if (tag === 'mark') markCount++;
    return true;
  }

  const status = setInterval(() => {
    const secs = STATUS_EVERY_MS / 1000;
    const rate = [...counts.values()].reduce((a, b) => a + b, 0) / secs;
    const types = [...counts.keys()].sort((a, b) => a - b).map((id) => PACKET_NAMES[id] || `#${id}`).join(', ');
    console.log(rate
      ? `[capture] ${Math.round(rate)} packets/s (format ${lastFormat}) · ${types} · ${totalPackets} total · ${markCount} mark(s)`
      : '[capture] no packets in the last 10s - is UDP telemetry on, and pointed at this PC?');
    counts.clear();
  }, STATUS_EVERY_MS);
  status.unref();

  async function close() {
    clearInterval(status);
    await Promise.all([packets.close(), outputs.close(), markers.close()]);
    console.log(`[capture] saved ${totalPackets} packets and ${markCount} mark(s) to ${dir}`);
    console.log(`[capture] analyze with: npm run analyze -- "${dir}"`);
  }

  return { dir, recordPacket, logOutputs, addMarker, close };
}

module.exports = { createCaptureSession, defaultCaptureDir, PACKET_NAMES };
