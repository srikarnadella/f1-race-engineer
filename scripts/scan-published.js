// Scans what the repo publishes for things that must not be public: the author's LAN address, a personal
// email, a local user path, a key. `npm run scan` lists findings; test/publishedScan.test.js runs it in CI.
// shortcut: patterns, not entropy: it finds the usual leaks, not every secret; add a rule when one slips through.
const fs = require('fs');
const { execFileSync } = require('child_process');

// Addresses the docs, site and tests use as examples.
const EXAMPLE_IPS = new Set(['192.168.1.23', '192.168.1.5', '10.0.0.5']);
const RULES = [
  { kind: 'private-ip', re: /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g, ok: (m) => EXAMPLE_IPS.has(m) },
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ok: (m) => /@users\.noreply\.github\.com$|@example\.(?:com|org)$/.test(m) },
  { kind: 'local-path', re: /[A-Za-z]:\\Users\\[^\\\s'"]+|\/Users\/[a-z][\w.-]*\/|C:\/Users\/[^/\s'"]+/g, ok: () => false },
  { kind: 'secret', re: /ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/g, ok: () => false },
];

function scanText(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    for (const { kind, re, ok } of RULES) {
      for (const m of line.matchAll(re)) if (!ok(m[0])) found.push({ kind, line: i + 1, text: m[0].slice(0, 60) });
    }
  });
  return found;
}

// Tracked text files. The lockfile is dependency authors' emails, not ours; binaries aren't text.
function trackedFiles() {
  const list = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  return list.filter((f) => f !== 'package-lock.json' && !/\.(png|jpe?g|gif|ico|webp|woff2?|gz|exe|f1log|db|pem)$/i.test(f) && fs.existsSync(f));
}

module.exports = { scanText, trackedFiles };

if (require.main === module) {
  let n = 0;
  for (const f of trackedFiles()) {
    for (const x of scanText(fs.readFileSync(f, 'utf8'))) {
      console.log(`${f}:${x.line}  ${x.kind}  ${x.text}`);
      n++;
    }
  }
  console.log(n ? `${n} finding${n === 1 ? '' : 's'}` : 'clean');
  process.exitCode = n ? 1 : 0;
}
