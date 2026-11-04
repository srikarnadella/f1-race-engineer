// The app's own settings (<userData>/settings.json): the ports, whether other
// devices may connect, and https for voice on phones. The dashboard's own
// preferences (voice mode, layout...) stay in each device's browser storage.
const fs = require('fs');

// easyOnGame: run below normal priority and redraw the window at 4 a second, so the game comes first.
const DEFAULTS = Object.freeze({ httpPort: 8080, udpPort: 20777, share: true, phoneVoice: false, easyOnGame: true });
const port = (v) => Number.isInteger(v) && v >= 1024 && v <= 65535;

// A change from the window, checked field by field: anything malformed is ignored.
function applySettings(current, patch) {
  const next = { ...current };
  if (!patch || typeof patch !== 'object') return next;
  for (const k of ['httpPort', 'udpPort']) if (port(patch[k])) next[k] = patch[k];
  for (const k of ['share', 'phoneVoice', 'easyOnGame']) if (typeof patch[k] === 'boolean') next[k] = patch[k];
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

const saveSettings = (file, s) => fs.writeFileSync(file, JSON.stringify(s, null, 2));

module.exports = { DEFAULTS, applySettings, loadSettings, saveSettings };
