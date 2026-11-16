const test = require('node:test');
const assert = require('node:assert');
const { scanText, trackedFiles } = require('../scripts/scan-published');

// Roadmap Q4. Everything in the repo is public, so nothing in it may carry the author's LAN address, personal
// email, local paths or a key. The scanner is checked on planted leaks first, then run over every tracked file.
// The planted leaks are built from pieces, so this file itself passes the scan.
const kinds = (text) => scanText(text).map((f) => f.kind);

test('scan: a LAN address that is not a documented example is found, the examples are not', () => {
  assert.deepStrictEqual(kinds('on http://192.168.' + '0.77:8080'), ['private-ip']);
  assert.deepStrictEqual(kinds('ssh 10.1.' + '2.3'), ['private-ip']);
  assert.deepStrictEqual(kinds('http://192.168.1.23:8080 and 192.168.1.5 and 10.0.0.5'), []);
  assert.deepStrictEqual(kinds('listening on 127.0.0.1 and 0.0.0.0 and 239.255.0.1'), []);
});

test('scan: a personal email is found; the noreply address and example domains are not', () => {
  assert.deepStrictEqual(kinds('write to someone@' + 'gmail.com'), ['email']);
  assert.deepStrictEqual(kinds('144623101+srikarnadella@users.noreply.github.com, a@example.com'), []);
});

test('scan: a local user path and secrets are found', () => {
  assert.deepStrictEqual(kinds('C:\\Users\\Someone\\Documents'), ['local-path']);
  assert.deepStrictEqual(kinds('/Users/' + 'someone/code'), ['local-path']);
  assert.deepStrictEqual(kinds('token ghp_' + 'a'.repeat(36)), ['secret']);
  assert.deepStrictEqual(kinds('-----BEGIN RSA PRIVATE ' + 'KEY-----'), ['secret']);
  assert.deepStrictEqual(kinds('AKIA' + 'A'.repeat(16)), ['secret']);
});

test('scan: findings say where, by line', () => {
  const [f] = scanText('fine\nfine\nhttp://192.168.' + '9.9/');
  assert.strictEqual(f.line, 3);
});

test('scan: nothing the repo publishes carries a LAN address, personal email, local path or secret', (t) => {
  let files;
  try {
    files = trackedFiles();
  } catch (_) {
    return t.skip('not a git checkout');
  }
  const found = [];
  const fs = require('fs');
  for (const f of files) found.push(...scanText(fs.readFileSync(f, 'utf8')).map((x) => `${f}:${x.line} ${x.kind} ${x.text}`));
  assert.deepStrictEqual(found, []);
});
