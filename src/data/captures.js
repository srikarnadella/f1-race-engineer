const fs = require('fs');
const path = require('path');

// The packet log of each capture folder (or the files given), skipping aborted captures.
function captureFiles(root, args = []) {
  const dirs = args.length ? args : fs.existsSync(path.join(root, 'captures'))
    ? fs.readdirSync(path.join(root, 'captures')).map((d) => path.join(root, 'captures', d)) : [];
  return dirs
    .map((d) => (fs.statSync(d).isDirectory() ? ['packets.f1log.gz', 'packets.f1log'].map((f) => path.join(d, f)).find((f) => fs.existsSync(f)) : d))
    .filter((f) => f && fs.statSync(f).size > 1e6);
}

module.exports = { captureFiles };
