const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { startUdpListener } = require('./udp/listener');
const { startReplay } = require('./capture/replay');
const { createRecorder } = require('./capture/recorder');
const { createCaptureSession, defaultCaptureDir } = require('./capture/session');
const { createTrackMemory } = require('./state/trackMemory');
const { RIVAL_ID } = require('./state/debrief');
const { createPipeline } = require('./pipeline');
const { startServer } = require('./server/httpServer');

const USAGE = `Usage: node src/index.js [options]

  --demo <file.f1log>   Replay a recorded session (.f1log or .f1log.gz) instead of listening for live UDP
  --speed <n>           Replay speed multiplier for --demo (default 1)
  --record <file>       Capture raw live packets to a .f1log file (live mode only)
  --capture             Live mode, saving a full capture session for validation: raw
                        packets, every dashboard call, and driver marks (Mark button / M key)
  --capture-dir <dir>   Where to save it (default captures/<date_time>)
  --port <n>            Dashboard HTTP/WebSocket port (default 8080)
  --udp-port <n>        F1 telemetry UDP port (default 20777)
  --udp-host <addr>     Interface to bind UDP on (default 0.0.0.0, so console/LAN senders work too)
  --https-cert <file>   Serve the dashboard over https with this certificate (PEM), with
  --https-key <file>    its key - needed for voice questions on a phone or tablet
  -h, --help            Show this help`;

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      demo: { type: 'string' },
      speed: { type: 'string', default: '1' },
      record: { type: 'string' },
      capture: { type: 'boolean', default: false },
      'capture-dir': { type: 'string' },
      port: { type: 'string', default: '8080' },
      'udp-port': { type: 'string', default: '20777' },
      'udp-host': { type: 'string', default: '0.0.0.0' },
      'https-cert': { type: 'string' },
      'https-key': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const httpPort = Number(values.port);
  const udpPort = Number(values['udp-port']);
  for (const [flag, n] of [['--port', httpPort], ['--udp-port', udpPort]]) {
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${flag} must be a port number (1-65535)`);
  }
  if (values.demo && values.record) throw new Error('--record only applies to live mode, not --demo');
  const capture = values.capture || !!values['capture-dir'];
  if (values.demo && capture) throw new Error('--capture only applies to live mode, not --demo');
  if (values.record && capture) throw new Error('use either --record or --capture (a capture already records the packets)');
  if (!values['https-cert'] !== !values['https-key']) throw new Error('--https-cert and --https-key go together');
  let tls = null;
  if (values['https-cert']) {
    try {
      tls = { cert: fs.readFileSync(path.resolve(values['https-cert'])), key: fs.readFileSync(path.resolve(values['https-key'])) };
    } catch (err) {
      throw new Error(`can't read the https certificate or key: ${err.message}`);
    }
  }

  return {
    help: values.help,
    demoFile: values.demo ? path.resolve(values.demo) : null,
    recordFile: values.record ? path.resolve(values.record) : null,
    captureDir: capture ? path.resolve(values['capture-dir'] || defaultCaptureDir(path.resolve(__dirname, '..'))) : null,
    httpPort,
    udpPort,
    udpHost: values['udp-host'],
    tls,
    speed: Math.max(0.1, Number(values.speed) || 1),
  };
}

function main() {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(1);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  // Live and demo share everything from here down - only the packet source
  // differs, which is the whole point of the single parsePacket() path.
  // Live races teach the next race at the same track (pit loss, when the AI
  // stops); a demo replay would only teach it the same race again.
  const memory = createTrackMemory(opts.demoFile ? null : path.resolve(__dirname, '..', 'data', 'tracks.json'));
  const capture = opts.captureDir
    ? createCaptureSession({ dir: opts.captureDir, meta: { version: require('../package.json').version, udpPort: opts.udpPort, node: process.version } })
    : null;

  // The engine runs on its own 10Hz tick, whether or not a dashboard is
  // connected - pit-loss measurement, wear history and weather memory must
  // keep going while a device sleeps. Clients only ever read the latest
  // result, so a reconnect can't trigger an extra, out-of-step evaluation.
  // Live sessions' debriefs are saved to data/sessions (gitignored) and
  // reloaded on the next start; a demo replay would only fill it with copies of itself.
  const pipeline = createPipeline({
    memory,
    debriefDir: opts.demoFile ? null : path.resolve(__dirname, '..', 'data', 'sessions'),
    source: opts.demoFile ? 'demo' : 'live',
    capturing: !!capture,
  });
  const { fieldModel, debrief, dispatch: onPacket } = pipeline;
  const engineTick = setInterval(() => {
    try {
      const latest = pipeline.tick();
      server.broadcast();
      if (capture) capture.logOutputs(latest);
    } catch (err) {
      console.error('[engine] snapshot failed:', err);
    }
  }, 100);

  // A driver's Mark from the dashboard, stamped with where they were.
  function onClientMessage(msg) {
    if (msg.type !== 'mark' || !capture) return;
    const idx = fieldModel.playerIndex();
    const car = idx == null ? null : fieldModel.getCar(idx);
    const lap = car && car.lapData;
    const ok = capture.addMarker(msg, {
      sessionTime: Math.round(fieldModel.getSessionTime() * 1000) / 1000,
      lap: lap ? lap.currentLapNum : null,
      lapDistance: lap ? Math.round(lap.lapDistance) : null,
      position: lap ? lap.carPosition : null,
      speed: car && car.telemetry ? car.telemetry.speed : null,
    });
    if (ok && msg.tag && msg.tag !== 'mark') console.log(`[capture] mark tagged: ${msg.tag}`);
    else if (ok) console.log(`[capture] mark at lap ${lap ? lap.currentLapNum : '?'}, ${lap ? Math.round(lap.lapDistance) : '?'} m`);
  }

  // Debrief screens fetch these on demand.
  const MODEL_INFO = (() => {
    try {
      const m = require('./ml/models/overtake.json');
      return { overtake: { question: m.question, horizonS: m.horizonS, trainedOn: m.trainedOn, evaluation: m.evaluation, weights: m.features.map((f, j) => ({ feature: f, weight: m.weights[j] })) } };
    } catch (_) {
      return { overtake: null };
    }
  })();
  function api(pathname, params) {
    const lap = (k) => (params.get(k) ? Number(params.get(k)) : null);
    // b: a lap number, or a rival's best lap ('r<carIndex>').
    const b = params.get('b');
    if (pathname === '/api/debrief/compare') return debrief.compare(params.get('session'), lap('a'), b && RIVAL_ID.test(b) ? b : lap('b'));
    if (pathname === '/api/debrief/rivals') return debrief.rivals(params.get('session'));
    const { analysis } = pipeline.snapshot();
    if (pathname === '/api/models') return { ...MODEL_INFO, tyre: analysis ? analysis.tyreModel : null };
    return null;
  }

  const server = startServer({ httpPort: opts.httpPort, getSnapshot: pipeline.snapshot, onClientMessage, api, tls: opts.tls });

  let socket = null;
  let recorder = null;

  if (opts.demoFile) {
    console.log(`[demo] replaying ${opts.demoFile} (looping)`);
    // Each loop replays the same sessionUID, so FieldModel can't detect the
    // restart on its own - reset explicitly before every pass.
    startReplay({ filePath: opts.demoFile, onPacket, onLoopStart: fieldModel.reset, speed: opts.speed }).catch((err) => {
      console.error(`[demo] replay failed: ${err.message}`);
      process.exit(1);
    });
  } else {
    if (opts.recordFile) {
      recorder = createRecorder(opts.recordFile);
      console.log(`[record] capturing raw packets to ${opts.recordFile}`);
    }
    if (capture) {
      console.log(`[capture] saving this session to ${capture.dir}`);
      console.log('[capture] tap MARK on the dashboard (or press M) whenever a call looks wrong, is missing, or you lock up / spin');
    }
    socket = startUdpListener({
      port: opts.udpPort,
      host: opts.udpHost,
      onPacket,
      onRawPacket: capture ? capture.recordPacket : recorder ? recorder.record : undefined,
    });
  }

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[main] shutting down');
    clearInterval(engineTick);
    pipeline.flush();
    if (socket) socket.close();
    server.close();
    // Let the capture files finish writing (gzip trailer) before exiting.
    // Replay's pending setTimeout would otherwise keep the process alive.
    const exit = setTimeout(() => process.exit(0), 3000);
    try {
      if (recorder) await recorder.close();
      if (capture) await capture.close();
    } finally {
      clearTimeout(exit);
      process.exit(0);
    }
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Closing the Windows terminal with the X sends SIGHUP, about 10 s before the kill.
  process.on('SIGHUP', shutdown);
}

main();
