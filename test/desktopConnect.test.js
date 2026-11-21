const test = require('node:test');
const assert = require('node:assert');
const { open } = require('./helpers/dashboard');

// Connect's "Other devices" (public/desktop.js). Sharing is https whenever it is on (the pairing key must not cross the
// Wi-Fi in plain text), so there is no separate "voice on phones" switch; and paired phones can be forgotten in one press.
function fakeApi(over = {}, extra = {}) {
  const status = { ...extra, version: '0.1.0', mode: 'live', replay: null, recording: null, settings: { httpPort: 8080, udpPort: 20777, share: true }, pairUrl: 'https://192.168.1.23:8080', addresses: ['192.168.1.23'], clients: 1, dataDir: 'C:/data', analyzing: [] };
  const ok = async () => status;
  const calls = [];
  return { calls, api: { status: ok, setSettings: ok, record: ok, stopRecording: ok, replay: ok, live: ok, captures: async () => [], analyze: ok, deleteCapture: ok, deleteSession: ok, showCapture: ok, openReport: ok, openDataFolder: ok, openInBrowser: ok, unpair: async () => { calls.push('unpair'); return status; }, speech: { start: ok, stop: ok }, on: () => () => {}, ...over } };
}
const settle = () => new Promise((r) => setTimeout(r, 10));
async function openConnect(t, extra = {}) {
  const fake = fakeApi({}, extra);
  const app = open(t, { before: (w) => { w.undercut = fake.api; } });
  await settle();
  const doc = app.window.document;
  [...doc.querySelectorAll('.home__dest')].find((b) => b.querySelector('.home__name').textContent === 'Connect and record').click();
  await settle();
  return { ...app, doc, fake, share: () => doc.querySelector('.pc-share') };
}

test('connect: sharing is https, so there is no separate voice switch, and the one-time phone warning is shown', async (t) => {
  const app = await openConnect(t);
  const text = app.share().textContent;
  assert.doesNotMatch(text, /Voice questions on phones/);
  assert.match(text, /isn't private/, 'what the phone says the first time, and what to tap');
  assert.match(text, /Advanced/);
  assert.deepStrictEqual(app.errors, []);
});

test('connect: "Forget paired phones" makes a new key, and the QR code is fetched again', async (t) => {
  const app = await openConnect(t);
  const qr = app.doc.querySelector('.pc-share__qr');
  const before = qr.getAttribute('src');
  const forget = [...app.share().querySelectorAll('button')].find((b) => /Forget paired phones/.test(b.textContent));
  assert.ok(forget, 'the button is there while sharing');
  forget.click();
  await settle();
  assert.deepStrictEqual(app.fake.calls, ['unpair']);
  assert.notStrictEqual(qr.getAttribute('src'), before, 'a new QR code (it carries the new key)');
  assert.deepStrictEqual(app.errors, []);
});

// The certificate names the PC's addresses when Undercut starts; a new address from the router means every phone warns
// again (and voice may not open) until a restart remakes it. Connect says so instead of leaving it a mystery.
test('connect: when the PC\'s address changed since the start, it says to restart Undercut', async (t) => {
  const app = await openConnect(t, { certStale: true });
  app.send({ source: 'live', capturing: false, connected: false }); // Connect redraws on the live feed
  await settle();
  assert.match(app.share().textContent, /address changed.*restart Undercut/i);
  assert.deepStrictEqual(app.errors, []);
});

test('connect: no restart line while the address is the one the certificate names', async (t) => {
  const app = await openConnect(t);
  app.send({ source: 'live', capturing: false, connected: false });
  await settle();
  assert.match(app.share().textContent, /isn't private/);
  assert.doesNotMatch(app.share().textContent, /restart Undercut/i);
});
