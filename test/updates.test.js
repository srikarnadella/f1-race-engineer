const test = require('node:test');
const assert = require('node:assert');
const { isNewer, checkForUpdate, RELEASES_API } = require('../desktop/updates');

// Roadmap S2, the cautious version: a button that asks GitHub for the latest release when pressed. Nothing runs in
// the background, nothing is downloaded or installed by the app, and the browser opens the release page.
const reply = (body, ok = true, status = 200) => async () => ({ ok, status, json: async () => body });

test('updates: versions compare by number, not as text', () => {
  assert.strictEqual(isNewer('0.2.0', '0.1.0'), true);
  assert.strictEqual(isNewer('0.10.0', '0.9.0'), true, '10 is after 9');
  assert.strictEqual(isNewer('1.0.0', '0.99.99'), true);
  assert.strictEqual(isNewer('0.1.0', '0.1.0'), false);
  assert.strictEqual(isNewer('0.1.0', '0.2.0'), false);
  assert.strictEqual(isNewer('v0.2.0', '0.1.0'), true, 'a leading v is fine');
  assert.strictEqual(isNewer('garbage', '0.1.0'), false);
  assert.strictEqual(isNewer('0.2.0-beta', '0.1.0'), true);
});

test('updates: a newer release is reported with its page; the same or an older one is not', async () => {
  const rel = { tag_name: 'v0.2.0', html_url: 'https://github.com/srikarnadella/f1-race-engineer/releases/tag/v0.2.0', draft: false, prerelease: false };
  assert.deepStrictEqual(await checkForUpdate('0.1.0', reply(rel)), { current: '0.1.0', latest: '0.2.0', newer: true, url: rel.html_url });
  const same = await checkForUpdate('0.2.0', reply(rel));
  assert.strictEqual(same.newer, false);
  assert.strictEqual((await checkForUpdate('0.3.0', reply(rel))).newer, false);
});

test('updates: it asks GitHub\'s releases API for this repository only, with no identifying headers', async () => {
  let seen = null;
  await checkForUpdate('0.1.0', async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, json: async () => ({ tag_name: 'v0.1.0', html_url: 'https://github.com/x' }) }; });
  assert.strictEqual(seen.url, RELEASES_API);
  assert.match(RELEASES_API, /^https:\/\/api\.github\.com\/repos\/srikarnadella\/f1-race-engineer\/releases\/latest$/);
  assert.deepStrictEqual(Object.keys(seen.opts.headers || {}).map((k) => k.toLowerCase()).filter((k) => !['accept', 'user-agent'].includes(k)), []);
  assert.doesNotMatch(JSON.stringify(seen.opts.headers || {}), /@|Bearer|token/i);
});

test('updates: a page that is not on github.com is never offered', async () => {
  const bad = { tag_name: 'v9.0.0', html_url: 'https://evil.example/download.exe' };
  const r = await checkForUpdate('0.1.0', reply(bad));
  assert.strictEqual(r.newer, true);
  assert.match(r.url, /^https:\/\/github\.com\/srikarnadella\/f1-race-engineer\/releases/, 'falls back to the releases page');
});

test('updates: no network, a rate limit or an odd reply say so plainly instead of crashing', async () => {
  await assert.rejects(checkForUpdate('0.1.0', async () => { throw new Error('offline'); }), /Couldn.t reach GitHub/);
  await assert.rejects(checkForUpdate('0.1.0', reply({}, false, 403)), /GitHub said no \(403\)/);
  await assert.rejects(checkForUpdate('0.1.0', reply({ nothing: true })), /no release/i);
});
