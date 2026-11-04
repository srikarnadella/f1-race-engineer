// The desktop app: the same bridge as `npm start`, in its own window, plus
// what the command line did with flags - record a race, replay one, analyze
// it, share the dashboard with phones and tablets - as buttons. Race data
// lives in %APPDATA%\Undercut\data, not next to the code (read-only once
// installed). The window is the dashboard itself (public/), served by the
// bridge like any other device; only this window gets window.undercut
// (preload.js), so phones on the Wi-Fi can't record, delete or change settings.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { once } = require('events');
const { Worker } = require('worker_threads');
const { app, BrowserWindow, dialog, shell, ipcMain } = require('electron');
const { start } = require('../src/index');
const { defaultCaptureDir } = require('../src/capture/session');
const { lanAddresses, pairAddress } = require('../src/server/httpServer');
const { listCaptures, captureDir, deleteCapture, packetsFile, summarizeReport, diskUse } = require('./library');
const { loadSettings, saveSettings, applySettings } = require('./settings');
const { setPriorities } = require('./priority');
const { ensureCert } = require('./tls');
const { startRecognizer, grammarPhrases } = require('./speech');
const { createOllama } = require('../src/llm/ollama');
const { createRaceTools } = require('../src/llm/tools');
const { MODELS, isOffered } = require('../src/llm/catalog');
const { askRace, insight, INSIGHT_KINDS } = require('../src/llm/ask');
const { buildChart, CHART_KINDS } = require('../src/llm/charts');

const UDP_HOST = '0.0.0.0'; // a console or second PC can send telemetry too
const SPEECH_IDLE_MS = 2 * 60 * 1000;

// A throwaway profile for measurements and checks (scripts/perf-app.js), so they never touch the user's races.
if (process.env.UNDERCUT_USER_DATA) app.setPath('userData', process.env.UNDERCUT_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit(); // a second copy would only find both ports taken
} else {
  const paths = {
    data: () => path.join(app.getPath('userData'), 'data'),
    captures: () => path.join(paths.data(), 'captures'),
    settings: () => path.join(app.getPath('userData'), 'settings.json'),
    tls: () => path.join(app.getPath('userData'), 'tls'),
  };
  let settings = null;
  /** @type {BrowserWindow | null} */
  let win = null;
  /** @type {ReturnType<typeof start> | null} */
  let bridge = null;
  let replay = null; // { name, label, file } while replaying a recording or the demo
  let tls = null;
  let quitting = false;
  const analyzing = new Set();

  const scheme = () => (tls ? 'https' : 'http');
  const localUrl = () => `${scheme()}://localhost:${settings.httpPort}`;

  function status() {
    const ip = settings.share ? pairAddress() : null;
    return {
      version: app.getVersion(),
      mode: replay ? 'replay' : 'live',
      replay: replay ? { name: replay.name, label: replay.label } : null,
      recording: bridge && bridge.recording() ? path.basename(bridge.recording()) : null,
      settings,
      pairUrl: ip ? `${scheme()}://${ip}:${settings.httpPort}` : null,
      addresses: settings.share ? lanAddresses() : [],
      clients: bridge ? bridge.clients() : 0,
      dataDir: paths.data(),
      analyzing: [...analyzing],
    };
  }
  const pushStatus = () => {
    if (win && !win.isDestroyed()) win.webContents.send('status', status());
  };

  // The synthetic demo race (src/sim), written once into the data folder.
  function demoFile() {
    const file = path.join(paths.data(), 'demo', 'synthetic-session.f1log.gz');
    if (!fs.existsSync(file)) {
      const { generate } = require('../src/sim/syntheticSession');
      const lines = [];
      generate((tMs, buf) => lines.push(JSON.stringify({ tMs, hex: buf.toString('hex') })));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, zlib.gzipSync(lines.join('\n') + '\n'));
    }
    return file;
  }

  async function launch() {
    tls = settings.share && settings.phoneVoice ? await ensureCert(paths.tls(), lanAddresses()) : null;
    bridge = start({
      demoFile: replay ? replay.file : null,
      recordFile: null,
      captureDir: null,
      speed: 1,
      tls,
      httpPort: settings.httpPort,
      httpHost: settings.share ? undefined : '127.0.0.1',
      udpPort: settings.udpPort,
      udpHost: UDP_HOST,
      dataDir: paths.data(),
      onSessionStart: () => ollama.sessionStarted(), // nothing of the model stays loaded while you race
      onPortInUse: (port) => {
        dialog.showErrorBox('Undercut can\'t start', `Port ${port} is already in use. Close the other copy of Undercut (or \`npm start\`), or pick another dashboard port in Settings.`);
        app.quit();
      },
      onReplayError: (err) => {
        dialog.showErrorBox('Can\'t replay that recording', err.message);
        switchTo(null);
      },
    });
    if (!bridge.server.listening) await once(bridge.server, 'listening');
  }

  // Ports, sharing, https or the packet source changed: a new bridge, the window reloaded.
  let switching = Promise.resolve();
  function switchTo(nextReplay, nextSettings = settings) {
    switching = switching.then(async () => {
      const old = bridge;
      bridge = null;
      if (old) await old.stop();
      replay = nextReplay;
      settings = nextSettings;
      await launch();
      if (win && !win.isDestroyed()) await win.loadURL(localUrl());
      pushStatus();
    });
    return switching.then(status);
  }

  // Ask the race (roadmap L2): the local model through Ollama, never while the game is sending telemetry.
  // Downloads go to the window as they move: at most 4 times a second, and at once when one ends.
  let sentDownloadsAt = 0;
  const sendDownloads = (list) => {
    const now = Date.now();
    if (list.every((d) => d.state === 'downloading') && now - sentDownloadsAt < 250) return;
    sentDownloadsAt = now;
    if (win && !win.isDestroyed()) win.webContents.send('llm', { kind: 'downloads', downloads: list });
  };
  const ollama = createOllama({ isLive: () => !!(bridge && bridge.live()), onDownloads: sendDownloads });

  // Only this window, on the bridge's own page, may call the PC.
  function handle(channel, fn) {
    ipcMain.handle(channel, (e, ...args) => {
      if (!win || e.sender !== win.webContents) throw new Error('Not allowed');
      return fn(...args);
    });
  }

  handle('status', status);
  // "Easy on the game": every Undercut process (main, window, GPU, utility) runs below normal priority, so
  // F1 26's threads win any contest for a core. Re-applied now and then: a process that restarts is new.
  const applyPriority = () => setPriorities([process.pid, ...app.getAppMetrics().map((m) => m.pid)], settings.easyOnGame, os.setPriority);
  setInterval(applyPriority, 10000).unref();
  handle('settings', (patch) => {
    const next = applySettings(settings, patch);
    saveSettings(paths.settings(), next);
    if (JSON.stringify(next) === JSON.stringify(settings)) return status();
    // Only the priority changed: nothing to restart.
    const { easyOnGame: a, ...rest } = settings;
    const { easyOnGame: b, ...nextRest } = next;
    if (a !== b && JSON.stringify(rest) === JSON.stringify(nextRest)) {
      settings = next;
      applyPriority();
      pushStatus();
      return status();
    }
    return switchTo(replay, next);
  });
  handle('record', () => {
    if (!bridge || replay) return status();
    bridge.record(defaultCaptureDir(paths.data()));
    pushStatus();
    return status();
  });
  handle('stopRecording', async () => {
    if (bridge) await bridge.stopRecording();
    pushStatus();
    return status();
  });
  handle('replay', (name) => {
    if (bridge && bridge.recording()) throw new Error('Stop recording first');
    if (name === 'demo') return switchTo({ name: 'demo', label: 'Demo race (made up)', file: demoFile() });
    const file = packetsFile(captureDir(paths.captures(), name));
    if (!file) throw new Error('No such recording');
    return switchTo({ name, label: name, file });
  });
  handle('live', () => (replay ? switchTo(null) : status()));
  handle('captures', () => listCaptures(paths.captures()));
  handle('diskUse', () => diskUse(paths.data()));
  handle('analyze', (name) => {
    const dir = captureDir(paths.captures(), name);
    if (analyzing.has(name)) throw new Error('Already analyzing');
    analyzing.add(name);
    pushStatus();
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'analyzeWorker.js'), { workerData: { dir } });
      const done = (fn) => (v) => {
        analyzing.delete(name);
        pushStatus();
        fn(v);
      };
      worker.once('message', done((m) => (m.error ? reject(new Error(m.error)) : resolve(summarizeReport(JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')))))));
      worker.once('error', done(reject));
    });
  });
  // Deleting can't be undone, so the PC asks itself - not the page.
  async function confirm(message, detail) {
    const { response } = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, message, detail });
    return response === 0;
  }
  handle('deleteCapture', async (name) => {
    const dir = captureDir(paths.captures(), name);
    if (replay && replay.name === name) throw new Error('Stop the replay first');
    if (bridge && bridge.recording() === dir) throw new Error('Stop recording first');
    if (!(await confirm(`Delete the recording ${name}?`, 'Its packets, marks and report are removed from this PC. This can\'t be undone.'))) return false;
    await deleteCapture(paths.captures(), name);
    return true;
  });
  handle('deleteSession', async (id, label) => {
    if (!bridge || replay) throw new Error('Go back to live to manage saved sessions');
    if (!(await confirm(`Delete ${typeof label === 'string' ? label.slice(0, 80) : 'this session'}?`, 'Its Debrief and its laps in the race database are removed from this PC. This can\'t be undone.'))) return false;
    return bridge.deleteSession(String(id));
  });
  handle('showCapture', (name) => shell.showItemInFolder(packetsFile(captureDir(paths.captures(), name)) || captureDir(paths.captures(), name)));
  handle('openReport', (name) => shell.openPath(path.join(captureDir(paths.captures(), name), 'report.md')));
  handle('openDataFolder', () => {
    fs.mkdirSync(paths.data(), { recursive: true });
    return shell.openPath(paths.data());
  });
  handle('openInBrowser', () => shell.openExternal(localUrl()));
  handle('llm:status', async () => ({ ...(await ollama.detect()), live: !!(bridge && bridge.live()), busy: ollama.busy() }));
  handle('llm:models', () => ollama.models());
  handle('llm:catalog', () => MODELS);
  // Only the models the app offers can be downloaded, asked or deleted from here.
  const offered = (id) => {
    if (!isOffered(id)) throw new Error('Not a model this app offers');
    return id;
  };
  handle('llm:pull', (id) => ollama.pull(offered(id)).then(() => true));
  handle('llm:downloads', () => ollama.downloads());
  handle('llm:clearDownloads', () => ollama.clearDownloads());
  handle('llm:cancelPull', (id) => ollama.cancelPull(offered(id)));
  handle('llm:delete', async (id) => {
    const m = MODELS.find((x) => x.id === offered(id));
    if (!(await confirm(`Delete ${m.name}?`, 'It is removed from this PC; you can download it again.'))) return false;
    await ollama.remove(id);
    return true;
  });
  // race.db read-only, opened for the one call and closed after it.
  const withRaceDb = async (fn) => {
    const file = path.join(paths.data(), 'race.db');
    if (!fs.existsSync(file)) throw new Error('No races saved yet');
    const tools = createRaceTools(file);
    try {
      return await fn(tools);
    } finally {
      tools.close();
    }
  };
  const sessionIdOf = (id) => {
    if (!Number.isInteger(id) || id < 1) throw new Error('Pick a session');
    return id;
  };
  handle('llm:sessions', () => withRaceDb((t) => t.run('sessions', {}).sessions));
  handle('llm:results', (id) => withRaceDb((t) => t.run('results', { session_id: sessionIdOf(id) }).results || []));
  handle('llm:ask', (model, id, question) => {
    if (typeof question !== 'string' || !question.trim()) throw new Error('Ask a question');
    offered(model);
    return withRaceDb((tools) => askRace({ ollama, tools, sessionId: sessionIdOf(id), model, question: question.slice(0, 2000) }));
  });
  // Chart commands: drawn from the data, no model. Only the built-in kinds and plain arguments.
  handle('llm:chart', (id, kind, args) => {
    if (!CHART_KINDS.includes(kind)) throw new Error('Not a chart this app draws');
    const a = args && typeof args === 'object' ? args : {};
    const clean = {};
    if (typeof a.driver === 'string' && a.driver.length <= 60) clean.driver = a.driver;
    for (const k of ['lap_a', 'lap_b']) if (Number.isInteger(a[k])) clean[k] = a[k];
    return withRaceDb((tools) => buildChart(tools, sessionIdOf(id), kind, clean));
  });
  // Insight buttons: the engine's own findings, no model. Only the built-in kinds.
  handle('llm:insight', (id, kind) => {
    if (typeof kind !== 'string' || !Object.hasOwn(INSIGHT_KINDS, kind)) throw new Error('Not an insight this app shows');
    return withRaceDb((tools) => insight(tools, sessionIdOf(id), kind));
  });
  handle('llm:stop', () => ollama.stop());

  // Voice questions (speech.js): one recognizer, kept warm for a couple of
  // minutes after the last question so the next one starts at once.
  let recognizer = null;
  let recognizerPhrases = '';
  let listening = false;
  let idleTimer = null;
  handle('speech:start', (phrases) => {
    const list = grammarPhrases(Array.isArray(phrases) ? phrases.filter((p) => typeof p === 'string').slice(0, 50) : []);
    clearTimeout(idleTimer);
    if (!recognizer || recognizerPhrases !== list.join('\n')) {
      if (recognizer) recognizer.stop();
      recognizerPhrases = list.join('\n');
      const r = startRecognizer({
        phrases: list,
        onLine: (msg) => {
          if (msg.error && recognizer === r) recognizer = null;
          if (listening && win && !win.isDestroyed()) win.webContents.send('speech', msg);
        },
      });
      recognizer = r;
    }
    listening = true;
    return true;
  });
  handle('speech:stop', () => {
    listening = false;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (recognizer) recognizer.stop();
      recognizer = null;
    }, SPEECH_IDLE_MS);
    return true;
  });

  // The window trusts the app's own certificate (https for phone voice), and only that one.
  app.on('certificate-error', (e, _wc, url, _err, certificate, callback) => {
    const ours = tls && new URL(url).hostname === 'localhost' && certificate.data.trim() === tls.cert.toString().trim();
    if (ours) e.preventDefault();
    callback(!!ours);
  });

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    settings = loadSettings(paths.settings());
    await launch();
    applyPriority();

    win = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 900,
      minHeight: 600,
      backgroundColor: '#06080b',
      autoHideMenuBar: true,
      show: false, // shown once the page has painted, not as an empty frame first
      icon: path.join(__dirname, '..', 'public', 'icon-512.png'),
      // The window is a dashboard client with a few named calls: no Node access.
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.once('ready-to-show', () => { win.show(); applyPriority(); }); // the window's own processes exist by now
    win.on('closed', () => { win = null; });
    // Links out (the website, GitHub) open in the browser, never inside the app...
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    // ...and the window itself never leaves the dashboard.
    win.webContents.on('will-navigate', (e, url) => {
      if (new URL(url).origin !== new URL(localUrl()).origin) e.preventDefault();
    });
    await win.loadURL(localUrl());
  });

  app.on('window-all-closed', () => app.quit());

  // Save the session (race.db, the debrief) and finish any recording before the process goes.
  app.on('will-quit', (e) => {
    if (recognizer) recognizer.stop();
    ollama.stop(); // and unloads the model
    if (!bridge || quitting) return;
    e.preventDefault();
    quitting = true;
    const b = bridge;
    bridge = null;
    b.stop().finally(() => app.quit());
  });
}
