const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Roadmap S1. The release workflow builds the Windows installer when a version tag is pushed and attaches it to the
// release. These pin the parts that matter, since the workflow itself only runs on GitHub.
const root = path.join(__dirname, '..');
const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('release workflow: runs on a pushed version tag, on Windows, and can write the release', () => {
  assert.match(wf, /on:\s*\n\s+push:\s*\n\s+tags:\s*\n\s+- 'v\*'/);
  assert.match(wf, /runs-on: windows-latest/);
  assert.match(wf, /contents: write/);
});

test('release workflow: it refuses a tag that is not the package version, runs the tests, builds and uploads the installer', () => {
  assert.match(wf, /GITHUB_REF_NAME/);
  assert.match(wf, /package\.json/);
  assert.match(wf, /npm test/);
  assert.match(wf, /npm run app:build/);
  assert.match(wf, /gh release (create|upload)/);
  // The tests must pass before anything is built or published.
  assert.ok(wf.indexOf('npm test') < wf.indexOf('npm run app:build'));
  assert.ok(wf.indexOf('npm run app:build') < wf.indexOf('gh release'));
});

test('release workflow: the installer it uploads is the one the site and README link to (by name pattern)', () => {
  const pattern = pkg.build.nsis.artifactName; // Undercut-Setup-${version}.${ext}
  assert.strictEqual(pattern, 'Undercut-Setup-${version}.${ext}');
  assert.match(wf, /Undercut-Setup-\$\{?version\}?\.exe|Undercut-Setup-\$version\.exe|dist\/Undercut-Setup-/);
  // A copy under a name with no version, so releases/latest/download/Undercut-Setup.exe never changes.
  assert.match(wf, /Undercut-Setup\.exe/);
});
