// The app's own settings (<userData>/settings.json): the ports, whether other
// devices may connect (over https, with the app's own certificate). The dashboard's own
// preferences (voice mode, layout...) stay in each device's browser storage.
const fs = require('fs');

// easyOnGame: run below normal priority and redraw the window at 4 a second, so the game comes first.
const DEFAULTS = Object.freeze({ httpPort: 8080, udpPort: 20777, share: true, easyOnGame: true });
// The file's format, written beside the settings. Unknown settings (a newer Undercut's) are ignored by applySettings.
const SETTINGS_VERSION = 1;
const port = (v) => Number.isInteger(v) && v >= 1024 && v <= 65535;

// A change from the window, checked field by field: anything malformed is ignored.
function applySettings(current, patch) {
  const next = { ...current };
  if (!patch || typeof patch !== 'object') return next;
  for (const k of ['httpPort', 'udpPort']) if (port(patch[k])) next[k] = patch[k];
  for (const k of ['share', 'easyOnGame']) if (typeof patch[k] === 'boolean') next[k] = patch[k];
  if (next.httpPort === next.udpPort) next.httpPort = current.httpPort; // one port can't be both
  return next;
}

function loadSettings(file) {
  try {
    return applySettings(DEFAULTS, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { ...DEFAULTS };
  }
}

// Write then rename, so a crash mid-write leaves the previous settings, not half a file.
function saveSettings(file, s) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ version: SETTINGS_VERSION, ...s }, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

module.exports = { SETTINGS_VERSION, DEFAULTS, applySettings, loadSettings, saveSettings };
