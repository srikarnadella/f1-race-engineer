// The key a phone or tablet carries after scanning the pairing QR code: without it a device on the Wi-Fi can look at the dashboard
// but not save anything (src/server/httpServer.js). Made once, kept beside the other data, so a paired phone stays paired across
// restarts. Connect's "Forget paired phones" (newPairKey) unpairs every device.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMAT = /^[0-9a-f]{32}$/;

function loadPairKey(dir) {
  try {
    const kept = fs.readFileSync(path.join(dir, 'pair-key'), 'utf8').trim();
    if (FORMAT.test(kept)) return kept;
  } catch {
    // none yet
  }
  return newPairKey(dir);
}

// A new key, kept: every device paired with the old one can look but no longer save (Connect's "Forget paired phones").
function newPairKey(dir) {
  const key = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pair-key'), key, { mode: 0o600 });
  } catch (err) {
    console.warn(`[pair] could not keep the pairing key (${err.message}); devices will need to pair again next start`);
  }
  return key;
}

module.exports = { loadPairKey, newPairKey };
