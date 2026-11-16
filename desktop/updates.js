// "Check for updates": asks GitHub for this repository's latest release when the button is pressed, and says
// whether it is newer. Nothing runs in the background and the app downloads and installs nothing; the release
// page opens in the browser. The one request carries no token, name or machine id.
const REPO = 'srikarnadella/f1-race-engineer';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

const parts = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

// Is `a` a later version than `b`? Numbers only (a pre-release suffix is ignored); anything unreadable is "no".
function isNewer(a, b) {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// fetchImpl: fetch (a fake in tests). Returns { current, latest, newer, url }.
async function checkForUpdate(current, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(RELEASES_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Undercut' } });
  } catch {
    throw new Error('Couldn\'t reach GitHub. Check the internet connection and try again.');
  }
  if (!res.ok) throw new Error(`GitHub said no (${res.status}). Try again later.`);
  const rel = await res.json();
  const latest = rel && typeof rel.tag_name === 'string' ? rel.tag_name.replace(/^v/, '') : null;
  if (!latest || !parts(latest)) throw new Error('GitHub has no release to compare with.');
  // Only a page on this repository is ever offered to open.
  const url = typeof rel.html_url === 'string' && rel.html_url.startsWith(`https://github.com/${REPO}/`) ? rel.html_url : RELEASES_PAGE;
  return { current, latest, newer: isNewer(latest, current), url };
}

module.exports = { RELEASES_API, isNewer, checkForUpdate };
