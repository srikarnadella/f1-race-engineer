// "Voice on phones": browsers only open the microphone on a secure page, and
// a phone reaches the PC by its network address, which plain http can't make
// secure. So the app makes its own certificate for this PC's addresses, once,
// and remakes it when an address changes (a new router, Wi-Fi on another
// network). It isn't signed by anyone a phone trusts, so the phone warns once
// before it opens the page - the Connect screen says so.
const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

const YEARS = 5;

async function ensureCert(dir, ips) {
  const files = { key: path.join(dir, 'key.pem'), cert: path.join(dir, 'cert.pem'), ips: path.join(dir, 'ips.json') };
  const want = [...new Set(ips)].sort();
  try {
    if (JSON.stringify(JSON.parse(fs.readFileSync(files.ips, 'utf8'))) === JSON.stringify(want)) {
      return { key: fs.readFileSync(files.key), cert: fs.readFileSync(files.cert) };
    }
  } catch {
    // none yet, or unreadable: make a new one
  }
  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + YEARS);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Undercut on this PC' }], {
    keySize: 2048,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...want.map((ip) => ({ type: /** @type {7} */ (7), ip }))] },
    ],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(files.key, pems.private, { mode: 0o600 });
  fs.writeFileSync(files.cert, pems.cert);
  fs.writeFileSync(files.ips, JSON.stringify(want));
  return { key: Buffer.from(pems.private), cert: Buffer.from(pems.cert) };
}

module.exports = { ensureCert };
