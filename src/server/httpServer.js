const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { qrSvg, printQr } = require('./qr');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');

// Every non-internal IPv4 address on this PC - what you type on the iPad.
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

// The address to pair a device with. shortcut: a PC with VPN / WSL / Hyper-V
// adapters has several; home networks are nearly always 192.168.x or 10.x,
// so those win - the terminal still lists every address if this guesses wrong.
function pairAddress() {
  const all = lanAddresses();
  return all.find((a) => a.startsWith('192.168.')) || all.find((a) => a.startsWith('10.')) || all[0] || null;
}

// Read-only JSON for the debrief screens (lap comparison, rivals, models):
// heavier than the live snapshot and only wanted on demand.
function serveApi(req, res, api) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  let body;
  try {
    body = api(url.pathname, url.searchParams);
  } catch (err) {
    console.warn('[server] api error:', err.message);
    body = { error: 'Internal error' };
  }
  res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(body || { error: 'Not found' }));
}

function serveStatic(req, res) {
  // Drop any query string, then resolve inside PUBLIC_DIR and refuse anything
  // that escapes it (e.g. /../../secret) - the server listens on the LAN.
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  // fs throws synchronously (not via the callback) on a NUL byte, which
  // would take the whole bridge down from one bad request.
  if (pathname.includes('\0')) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  const filePath = path.resolve(PUBLIC_DIR, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      // A tiny local app - always serve the latest files to the iPad.
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  });
}

// Pushes the current snapshot to every connected client at a fixed rate
// (not per-packet) - the game can emit telemetry at 60Hz but a human eye
// and an iPad's battery don't need more than ~10 updates/sec.
// Dashboard -> bridge messages (e.g. a driver's capture marker). Anyone on
// the LAN can connect, so input is small, JSON objects only, rate-limited,
// and the handler decides what's valid.
const MAX_CLIENT_MESSAGE_BYTES = 1024;
const MAX_CLIENT_MESSAGES_PER_10S = 30;

function startServer({ httpPort = 8080, getSnapshot, tickHz = 10, onClientMessage = null, api = null }) {
  const pairUrl = () => {
    const ip = pairAddress();
    return ip ? `http://${ip}:${httpPort}` : null;
  };
  // Pairing (Settings): the LAN address and a QR code of it.
  const pairing = (pathname) => {
    if (pathname === '/api/pair') return { url: pairUrl() };
    return null;
  };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/qr') {
      const url = pairUrl();
      res.writeHead(url ? 200 : 404, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
      res.end(url ? qrSvg(url) : '');
    } else if (req.method === 'GET' && req.url.startsWith('/api/')) {
      serveApi(req, res, (p, q) => pairing(p) || (api ? api(p, q) : null));
    } else {
      serveStatic(req, res);
    }
  });
  const wss = new WebSocketServer({ server });
  // ws re-emits the HTTP server's errors; those are handled on `server` below.
  wss.on('error', () => {});

  wss.on('connection', (ws) => {
    // Without a listener, ws re-throws a client's protocol error (bad frame,
    // abrupt reset) as an uncaught exception and every viewer loses the feed.
    ws.on('error', (err) => console.warn('[server] dropping dashboard client:', err.message));
    let windowStart = Date.now();
    let inWindow = 0;
    ws.on('message', (data, isBinary) => {
      if (!onClientMessage || isBinary || data.length > MAX_CLIENT_MESSAGE_BYTES) return;
      if (Date.now() - windowStart > 10000) {
        windowStart = Date.now();
        inWindow = 0;
      }
      if (++inWindow > MAX_CLIENT_MESSAGES_PER_10S) return;
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      try {
        onClientMessage(msg);
      } catch (err) {
        console.warn('[server] client message handler failed:', err.message);
      }
    });
    ws.send(JSON.stringify(getSnapshot()));
  });

  const interval = setInterval(() => {
    if (wss.clients.size === 0) return;
    const payload = JSON.stringify(getSnapshot());
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }, 1000 / tickHz);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[server] port ${httpPort} is already in use - is another copy running? Try --port <n>.`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(httpPort, () => {
    const urls = lanAddresses().map((ip) => `http://${ip}:${httpPort}`);
    console.log(`[server] dashboard: http://localhost:${httpPort}`);
    for (const url of urls) console.log(`[server] on your iPad / LAN: ${url}`);
    const pair = pairUrl();
    if (pair) {
      console.log(`[server] scan to open ${pair} on your iPad or phone (same Wi-Fi):`);
      printQr(pair);
    }
  });

  return {
    close: () => {
      clearInterval(interval);
      wss.close();
      server.close();
    },
  };
}

module.exports = { startServer };
