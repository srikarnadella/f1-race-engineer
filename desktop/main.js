// The desktop app: the same bridge as `npm start`, in its own window, plus
// what the command line did with flags - record a race, replay one, analyze
// it, share the dashboard with phones and tablets - as buttons. Race data
// lives in %APPDATA%\Undercut\data, not next to the code (read-only once
// installed). The window is the dashboard itself (public/), served by the
// bridge like any other device; only this window gets window.undercut
// (preload.js), so phones on the Wi-Fi can't record, delete or change settings.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { once } = require('events');
const { Worker } = require('worker_threads');
const { app, BrowserWindow, dialog, shell, ipcMain } = require('electron');
const { start } = require('../src/index');
const { defaultCaptureDir } = require('../src/capture/session');
const { lanAddresses, pairAddress } = require('../src/server/httpServer');
const { listCaptures, captureDir, deleteCapture, packetsFile, summarizeReport } = require('./library');
const { loadSettings, saveSettings, applySettings } = require('./settings');
const { ensureCert } = require('./tls');
const { startRecognizer, grammarPhrases } = require('./speech');

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

  // Only this window, on the bridge's own page, may call the PC.
  function handle(channel, fn) {
    ipcMain.handle(channel, (e, ...args) => {
      if (!win || e.sender !== win.webContents) throw new Error('Not allowed');
      return fn(...args);
    });
  }

  handle('status', status);
  handle('settings', (patch) => {
    const next = applySettings(settings, patch);
    saveSettings(paths.settings(), next);
    return JSON.stringify(next) === JSON.stringify(settings) ? status() : switchTo(replay, next);
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
    win.once('ready-to-show', () => win.show());
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
    if (!bridge || quitting) return;
    e.preventDefault();
    quitting = true;
    const b = bridge;
    bridge = null;
    b.stop().finally(() => app.quit());
  });
}
