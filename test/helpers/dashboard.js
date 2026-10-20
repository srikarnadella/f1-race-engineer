const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { syntheticPackets, replay } = require('./synthetic');

// The dashboard shell (public/app.js) in jsdom, connected to a fake bridge:
// the page as a driver uses it - the link, the screens, the keys, auto-switch.
const PUBLIC = path.join(__dirname, '..', '..', 'public');
const SCRIPTS = ['widgets.js', 'debrief.js', 'ask.js', 'app.js'].map((f) => new vm.Script(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), { filename: path.join(PUBLIC, f) }));
const HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace(/<script[^>]*src=[^>]*><\/script>/g, '');

let snapshots = null;
function raceSnapshots() {
  if (!snapshots) {
    snapshots = [];
    replay(syntheticPackets(), { onTick: ({ tMs, snap }) => { if (tMs % 500 < 100) snapshots.push(JSON.parse(JSON.stringify(snap))); } });
  }
  return snapshots;
}

function open(t, { storage = {}, url = 'http://192.168.1.5:8080/' } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url, pretendToBeVisual: true });
  const { window } = dom;
  t.after(() => window.close());
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, JSON.stringify(v));
  const sockets = [];
  window.WebSocket = class {
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    close() {
      if (this.onclose) this.onclose();
    }
  };
  window.fetch = async () => ({ ok: false, json: async () => ({}) });
  window.Response = Response; // the recorded demo wraps fetch with it
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const errors = [];
  window.console.error = (...a) => errors.push(a.join(' '));
  const ctx = dom.getInternalVMContext();
  for (const s of SCRIPTS) s.runInContext(ctx);
  const bridge = () => sockets[sockets.length - 1];
  const send = (snap) => bridge().onmessage({ data: JSON.stringify(snap) });
  const connect = () => bridge().onopen();
  const $ = (id) => window.document.getElementById(id);
  const press = (key) => window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
  const activeTab = () => window.document.querySelector('.tab.is-active').textContent.trim().replace(/^\d/, ''); // minus its key badge
  return { window, sockets, bridge, send, connect, $, press, activeTab, errors };
}

module.exports = { open, raceSnapshots };
