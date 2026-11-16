const test = require('node:test');
const assert = require('node:assert');
const { open } = require('./helpers/dashboard');

// Keep the screen awake: a phone or tablet beside the wheel must not dim and lock mid-race. It uses the browser's screen wake lock,
// which the browser only gives to a secure page (https or localhost); on plain http it says so.
function sentinel() {
  const listeners = [];
  return { released: false, addEventListener: (e, fn) => listeners.push(fn), release: async function () { this.released = true; listeners.forEach((fn) => fn()); } };
}
function lockApi({ refuse = false } = {}) {
  const taken = [];
  return { taken, request: async (kind) => { if (refuse) throw new Error('not allowed'); const s = sentinel(); s.kind = kind; taken.push(s); return s; } };
}
function phone(t, { storage = {}, wakeLock, desktop = false } = {}) {
  return open(t, { storage, before: (w) => {
    if (wakeLock) Object.defineProperty(w.navigator, 'wakeLock', { value: wakeLock, configurable: true });
    if (desktop) {
      const ok = async () => ({ version: '0.1.0', mode: 'live', replay: null, recording: null, settings: { httpPort: 8080, udpPort: 20777, share: false, phoneVoice: false }, pairUrl: null, addresses: [], clients: 1, dataDir: 'C:/data', analyzing: [] });
      w.undercut = { status: ok, setSettings: ok, record: ok, stopRecording: ok, replay: ok, live: ok, captures: async () => [], analyze: ok, deleteCapture: ok, deleteSession: ok, showCapture: ok, openReport: ok, openDataFolder: ok, openInBrowser: ok, speech: { start: ok, stop: ok }, on: () => () => {} };
    }
  } });
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('awake: on by default, a phone asks the browser to keep the screen on', async (t) => {
  const wl = lockApi();
  const app = phone(t, { wakeLock: wl });
  await settle();
  assert.strictEqual(wl.taken.length, 1);
  assert.strictEqual(wl.taken[0].kind, 'screen');
  assert.deepStrictEqual(app.errors, []);
});

test('awake: the switch in Settings releases it and takes it again, and the choice is remembered', async (t) => {
  const wl = lockApi();
  const app = phone(t, { wakeLock: wl });
  await settle();
  app.$('settings').click();
  const box = app.$('set-awake');
  assert.strictEqual(box.checked, true);
  box.checked = false;
  box.dispatchEvent(new app.window.Event('change'));
  await settle();
  assert.strictEqual(wl.taken[0].released, true);
  assert.strictEqual(JSON.parse(app.window.localStorage.getItem('raceEngineer.keepAwake')), false);
  box.checked = true;
  box.dispatchEvent(new app.window.Event('change'));
  await settle();
  assert.strictEqual(wl.taken.length, 2);
  const off = phone(t, { wakeLock: lockApi(), storage: { 'raceEngineer.keepAwake': false } });
  await settle();
  assert.strictEqual(off.window.navigator.wakeLock.taken.length, 0, 'switched off: never asked');
});

test('awake: the browser drops the lock when the page is hidden, so it is asked for again when the page comes back', async (t) => {
  const wl = lockApi();
  const app = phone(t, { wakeLock: wl });
  await settle();
  await wl.taken[0].release(); // what a browser does when you switch apps
  Object.defineProperty(app.window.document, 'visibilityState', { value: 'visible', configurable: true });
  app.window.document.dispatchEvent(new app.window.Event('visibilitychange'));
  await settle();
  assert.strictEqual(wl.taken.length, 2);
});

test('awake: a refusal (battery saver, a page that is not secure) is not an error', async (t) => {
  const app = phone(t, { wakeLock: lockApi({ refuse: true }) });
  await settle();
  assert.deepStrictEqual(app.errors, []);
});

test('awake: a browser without it says why and how to get it, instead of a switch that does nothing', async (t) => {
  const app = phone(t);
  app.$('settings').click();
  assert.match(app.doc ? app.doc.body.textContent : app.window.document.body.textContent, /secure page/i);
  assert.match(app.window.document.querySelector('#awake-hint').textContent, /Voice questions on phones/);
  assert.strictEqual(app.window.document.querySelector('#awake-hint').hidden, false);
  const ok = phone(t, { wakeLock: lockApi() });
  assert.strictEqual(ok.window.document.querySelector('#awake-hint').hidden, true);
});

test('awake: not offered in the desktop app, where the window sits on the PC', async (t) => {
  const app = phone(t, { wakeLock: lockApi(), desktop: true });
  await settle();
  assert.strictEqual(app.window.document.querySelector('#set-awake').closest('label').hidden, true);
  assert.strictEqual(app.window.navigator.wakeLock.taken.length, 0);
});
