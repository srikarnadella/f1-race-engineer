// The widget library is split by screen (roadmap Q8). widgets.js comes first (the shared helpers and the
// registry); the others register into it. Anything that loads the widgets loads this list, in this order.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WIDGET_FILES = ['widgets.js', 'widgets-drive.js', 'widgets-strategy.js', 'widgets-field.js', 'widgets-quali.js', 'widgets-setup.js', 'widgets-map.js'];
const PUBLIC = path.join(__dirname, '..', '..', 'public');

// Compiled with their file names, so coverage counts each as public/<name>.
const widgetScripts = () => WIDGET_FILES.map((f) => new vm.Script(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), { filename: path.join(PUBLIC, f) }));

module.exports = { WIDGET_FILES, widgetScripts };
