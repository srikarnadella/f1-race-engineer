const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { WIDGET_FILES, widgetScripts } = require('./helpers/widgetScripts');

// Roadmap Q8: the widget library is split across files; they must load in the order the page loads them, and
// the registry must come out the same as when it was one file.
test('widget files: the page loads exactly the files the tests do, in order', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const loaded = [...html.matchAll(/<script src="(widgets[\w-]*\.js)"><\/script>/g)].map((m) => m[1]);
  assert.deepStrictEqual(loaded, WIDGET_FILES);
});

test('widget files: every widget the files register is in the picker order, and the order lists no widget that is missing', () => {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  for (const s of widgetScripts()) s.runInContext(dom.getInternalVMContext());
  const { widgets, order } = dom.window.RaceWidgets;
  assert.deepStrictEqual([...order].sort(), Object.keys(widgets).sort());
  assert.deepStrictEqual(Array.from(order), ['radio', 'call', 'rejoin', 'battle', 'drive', 'laptime', 'pittiming', 'options', 'tyrecall', 'pace', 'nearby', 'adjust', 'weather', 'qlap', 'qorder', 'qplan', 'setup', 'brief', 'tyresets', 'map']);
  for (const id of order) assert.strictEqual(typeof widgets[id].mount, 'function', id);
});
