// The key a phone or tablet carries after scanning the pairing QR code: without it a device on the Wi-Fi can look at the dashboard
// but not save anything (src/server/httpServer.js). Made once, kept beside the other data, so a paired phone stays paired across
// restarts. Delete the file (or the data folder) to unpair every device.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMAT = /^[0-9a-f]{32}$/;

function loadPairKey(dir) {
  const file = path.join(dir, 'pair-key');
  try {
    const kept = fs.readFileSync(file, 'utf8').trim();
    if (FORMAT.test(kept)) return kept;
  } catch {
    // none yet
  }
  const key = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, key, { mode: 0o600 });
  } catch (err) {
    console.warn(`[pair] could not keep the pairing key (${err.message}); devices will need to pair again next start`);
  }
  return key;
}

module.exports = { loadPairKey };
