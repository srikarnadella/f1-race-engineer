// QR codes for pairing a phone or tablet with the bridge: printed in the
// terminal at start-up, and served as an SVG for the dashboard's Settings.
// qrcode-terminal (no dependencies) does the encoding; its vendored encoder
// gives the module grid for the SVG. Pinned to an exact version in
// package.json, since the vendor path isn't its public API.
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

const QUIET = 4; // modules of white border scanners need

function qrSvg(text) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + QUIET},${r + QUIET}h1v1h-1z`;
  const size = n + QUIET * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

function printQr(text) {
  qrcodeTerminal.generate(text, { small: true }, (art) => console.log(art));
}

module.exports = { qrSvg, printQr };
