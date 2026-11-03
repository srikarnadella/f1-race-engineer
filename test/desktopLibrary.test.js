const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { X509Certificate } = require('crypto');
const { createCaptureSession } = require('../src/capture/session');
const { listCaptures, captureDir, deleteCapture } = require('../desktop/library');
const { ensureCert } = require('../desktop/tls');
const { syntheticPackets } = require('./helpers/synthetic');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'undercut-lib-'));

test('library: a recording is listed with its size, start, track, session and marks; newest first', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['2026-10-01_100000', '2026-10-02_100000']) {
    const c = createCaptureSession({ dir: path.join(root, name) });
    for (const p of syntheticPackets().slice(0, 400)) c.recordPacket(p.buf);
    if (name.endsWith('2_100000')) c.addMarker({ id: 'm1', tag: 'mark' }, { lap: 1 });
    await c.close();
  }
  fs.mkdirSync(path.join(root, 'empty-menu-test')); // no packets: not a recording
  const list = await listCaptures(root);
  assert.deepStrictEqual(list.map((c) => c.name), ['2026-10-02_100000', '2026-10-01_100000']);
  const [newest] = list;
  assert.ok(newest.bytes > 0);
  assert.strictEqual(newest.marks, 1);
  assert.strictEqual(newest.track, 'Red Bull Ring'); // the synthetic race
  assert.strictEqual(newest.session, 'Race');
  assert.strictEqual(newest.report, null);
});

test('library: a name that leaves the recordings folder is refused, and delete removes only that recording', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const bad of ['..', '../x', 'a/b', 'a\\b', '', '.hidden', 'C:']) assert.throws(() => captureDir(root, bad), /recording/);
  fs.mkdirSync(path.join(root, 'keep'));
  fs.mkdirSync(path.join(root, 'gone'));
  fs.writeFileSync(path.join(root, 'gone', 'packets.f1log'), 'x');
  await deleteCapture(root, 'gone');
  assert.deepStrictEqual(fs.readdirSync(root), ['keep']);
});

test('tls: a certificate for this PC names its addresses, is reused, and is remade when an address changes', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = await ensureCert(dir, ['192.168.1.23']);
  const cert = new X509Certificate(a.cert);
  assert.match(cert.subjectAltName, /IP Address:192\.168\.1\.23/);
  assert.match(cert.subjectAltName, /DNS:localhost/);
  assert.strictEqual((await ensureCert(dir, ['192.168.1.23'])).cert.toString(), a.cert.toString());
  const b = await ensureCert(dir, ['10.0.0.5']);
  assert.notStrictEqual(b.cert.toString(), a.cert.toString());
  assert.match(new X509Certificate(b.cert).subjectAltName, /IP Address:10\.0\.0\.5/);
});

test('settings: changes from the window are checked field by field; a bad file falls back to the defaults', (t) => {
  const { DEFAULTS, applySettings, loadSettings, saveSettings } = require('../desktop/settings');
  assert.deepStrictEqual(applySettings(DEFAULTS, { httpPort: 9000, share: false }), { ...DEFAULTS, httpPort: 9000, share: false });
  for (const bad of [{ httpPort: 80 }, { httpPort: '9000' }, { udpPort: 70000 }, { share: 'no' }, { httpPort: 20777 }, null, { evil: 1 }]) {
    assert.deepStrictEqual(applySettings(DEFAULTS, bad), DEFAULTS, JSON.stringify(bad));
  }
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  assert.deepStrictEqual(loadSettings(file), DEFAULTS);
  saveSettings(file, { ...DEFAULTS, phoneVoice: true });
  assert.strictEqual(loadSettings(file).phoneVoice, true);
  fs.writeFileSync(file, '{oops');
  assert.deepStrictEqual(loadSettings(file), DEFAULTS);
});
