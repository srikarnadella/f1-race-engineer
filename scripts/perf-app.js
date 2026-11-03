// What the desktop app costs the PC it shares with F1 26 (roadmap W0).
// Launches the app in a throwaway profile, times it to a usable Home, then
// samples CPU and RAM of every app process (main, window, GPU, utility) in
// four phases: idle with the window open, idle minimized, and a real race fed
// over UDP at its recorded 60 Hz pace with the dashboard showing and minimized.
//
//   node scripts/perf-app.js [--capture <dir or .f1log[.gz]>] [--from-sec 600] [--phase-sec 30] [--exe <Undercut.exe>]
//
// Numbers go in docs/performance.md. Windows only (process data from CIM).
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');
const { readLog } = require('../src/capture/logFile');

const HTTP_PORT = 18080; // not the user's 8080/20777, so a running copy of the app is left alone
const UDP_PORT = 20797;
const CDP_PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every process under rootPid (inclusive) from one CIM listing: [{ pid, parent, name, cpuS, wsMB, privateMB }].
function treeOf(rootPid, all) {
  const keep = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all) if (!keep.has(p.pid) && keep.has(p.parent)) { keep.add(p.pid); grew = true; }
  }
  return all.filter((p) => keep.has(p.pid));
}

// CPU as % of one core and of the whole machine, from two samples of the same tree taken wallMs apart.
// A process that started between the samples counts from zero; one that exited is dropped.
function summarize(before, after, wallMs, cores) {
  const prev = new Map(before.map((p) => [p.pid, p.cpuS]));
  const cpuS = after.reduce((sum, p) => sum + p.cpuS - (prev.get(p.pid) || 0), 0);
  const oneCore = (cpuS * 1000 / wallMs) * 100;
  return {
    cpuOneCore: oneCore,
    cpuMachine: oneCore / cores,
    wsMB: after.reduce((s, p) => s + p.wsMB, 0),
    privateMB: after.reduce((s, p) => s + p.privateMB, 0),
    processes: after.length,
  };
}

function listProcesses() {
  const ps = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.KernelModeTime + $_.UserModeTime),$($_.WorkingSetSize),$($_.PrivatePageCount),$($_.Name)" }';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 1 << 24 });
  return out.trim().split(/\r?\n/).map((line) => {
    const [pid, parent, cpu100ns, ws, priv, ...name] = line.split(',');
    return { pid: +pid, parent: +parent, cpuS: +cpu100ns / 1e7, wsMB: +ws / 2 ** 20, privateMB: +priv / 2 ** 20, name: name.join(',') };
  });
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (m) => {
    const msg = JSON.parse(String(m));
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  return {
    send: (method, params = {}) => new Promise((res) => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params })); }),
    close: () => ws.close(),
  };
}

async function measure(rootPid, ms) {
  const before = treeOf(rootPid, listProcesses());
  const t0 = Date.now();
  await sleep(ms);
  const after = treeOf(rootPid, listProcesses());
  return summarize(before, after, Date.now() - t0, os.cpus().length);
}

// Sends the capture's packets from fromSec on, at their recorded pace, until signal aborts.
async function feed(file, fromSec, signal, onStart) {
  const sock = dgram.createSocket('udp4');
  let sent = 0;
  let startT = null;
  let startWall = 0;
  for await (const { tMs, buf } of readLog(file)) {
    if (signal.aborted) break;
    if (tMs < fromSec * 1000) continue;
    if (startT === null) { startT = tMs; startWall = Date.now(); onStart(); }
    const wait = startWall + (tMs - startT) - Date.now();
    if (wait > 0) await sleep(wait);
    sock.send(buf, UDP_PORT, '127.0.0.1');
    sent++;
  }
  sock.close();
  return sent;
}

function dirMB(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirMB(p) * 2 ** 20 : fs.statSync(p).size;
  }
  return total / 2 ** 20;
}

async function main() {
  const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
  let capture = arg('capture', 'captures/2026-10-17_203013');
  if (fs.existsSync(capture) && fs.statSync(capture).isDirectory()) capture = path.join(capture, fs.readdirSync(capture).find((f) => f.startsWith('packets.f1log')));
  const fromSec = Number(arg('from-sec', 600));
  const phaseMs = Number(arg('phase-sec', 30)) * 1000;
  const exe = arg('exe', null);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'undercut-perf-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ httpPort: HTTP_PORT, udpPort: UDP_PORT, share: false, phoneVoice: false }));
  const cmd = exe || require('electron');
  const args = [...(exe ? [] : ['.']), `--remote-debugging-port=${CDP_PORT}`];
  const t0 = Date.now();
  const child = spawn(cmd, args, { env: { ...process.env, UNDERCUT_USER_DATA: profile }, stdio: 'ignore' });

  let page = null;
  try {
    // Usable Home: the page has loaded and drawn the Home screen.
    let startupMs = null;
    while (startupMs === null) {
      if (Date.now() - t0 > 60000) throw new Error('no usable Home within 60 s');
      await sleep(100);
      try {
        const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
        const t = targets.find((x) => x.type === 'page' && x.url.includes(`localhost:${HTTP_PORT}`));
        if (!t) continue;
        page = page || await cdp(t.webSocketDebuggerUrl);
        const r = await page.send('Runtime.evaluate', { expression: "document.readyState === 'complete' && !!document.querySelector('.home')", returnByValue: true });
        if (r.result && r.result.result.value === true) startupMs = Date.now() - t0;
      } catch { /* not up yet */ }
    }
    // Electron's DevTools endpoint has no window control, so minimize through Windows itself.
    const windowState = async (state) => {
      const ps = `Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);';` +
        ` [U.W]::ShowWindow((Get-Process -Id ${child.pid}).MainWindowHandle, ${state === 'minimized' ? 6 : 9}) | Out-Null`;
      execFileSync('powershell.exe', ['-NoProfile', '-Command', ps]);
    };

    await sleep(5000); // let startup work settle
    const rows = [];
    rows.push(['Idle, Home showing', await measure(child.pid, phaseMs)]);
    await windowState('minimized');
    rows.push(['Idle, minimized', await measure(child.pid, phaseMs)]);
    await windowState('normal');

    const stop = new AbortController();
    let started;
    const feeding = new Promise((r) => { started = r; });
    const fed = feed(capture, fromSec, stop.signal, started);
    await feeding; // skipping to fromSec reads the gzip from the start
    await sleep(5000); // the field model fills before sampling
    await page.send('Runtime.evaluate', { expression: "document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }))" });
    rows.push(['Race 60 Hz, dashboard showing', await measure(child.pid, phaseMs)]);
    await windowState('minimized');
    rows.push(['Race 60 Hz, minimized', await measure(child.pid, phaseMs)]);
    stop.abort();
    const sent = await fed;

    const installDir = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'undercut');
    console.log(`\nUndercut perf, ${new Date().toISOString().slice(0, 10)}, ${os.cpus()[0].model.trim()}, ${os.cpus().length} threads, ${Math.round(os.totalmem() / 2 ** 30)} GB`);
    console.log(`Capture ${path.basename(path.dirname(capture))} from ${fromSec} s; ${sent} packets fed; phases of ${phaseMs / 1000} s\n`);
    console.log('| Phase | CPU (% of one core) | CPU (% of PC) | RAM working set (MB) | RAM private (MB) | Processes |');
    console.log('|---|---|---|---|---|---|');
    for (const [name, r] of rows) {
      console.log(`| ${name} | ${r.cpuOneCore.toFixed(1)} | ${r.cpuMachine.toFixed(2)} | ${r.wsMB.toFixed(0)} | ${r.privateMB.toFixed(0)} | ${r.processes} |`);
    }
    console.log(`\nStartup to a usable Home: ${(startupMs / 1000).toFixed(2)} s`);
    if (fs.existsSync(installDir)) console.log(`Installed size: ${dirMB(installDir).toFixed(0)} MB (${installDir})`);
  } finally {
    if (page) page.close();
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
    await sleep(1000);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

if (require.main === module) main().catch((err) => { console.error(err); process.exitCode = 1; });

module.exports = { treeOf, summarize };
