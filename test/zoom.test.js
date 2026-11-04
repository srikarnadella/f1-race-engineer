const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The desktop app scales its content to the window (desktop/preload.js): the screens are laid out at
// 1440 x 900, and a bigger or smaller window zooms the whole page, as a browser's zoom does, so the
// content fills it instead of sitting in a 1440-wide column. Run here against a fake window.
function preload({ width, height, zoom = 1 }) {
  const calls = [];
  const listeners = {};
  let z = zoom;
  const win = {
    // A window's CSS size shrinks as the zoom grows: what the page sees is the real size over the zoom.
    get innerWidth() { return width / z; },
    get innerHeight() { return height / z; },
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const electron = {
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { invoke: async () => {}, on: () => {}, removeListener: () => {} },
    webFrame: { getZoomFactor: () => z, setZoomFactor: (f) => { calls.push(f); z = f; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.js'), 'utf8'), { require: (m) => (m === 'electron' ? electron : require(m)), window: win });
  return { calls, resize: (w, h) => { width = w; height = h; listeners.resize(); }, zoom: () => z };
}

test('zoom: the 1440 x 900 design fills a bigger window, scaled by the smaller of width and height', () => {
  assert.strictEqual(preload({ width: 1440, height: 900 }).zoom(), 1);
  assert.strictEqual(preload({ width: 1920, height: 1080 }).zoom(), 1.2, 'height is the limit: 1080 / 900');
  assert.strictEqual(preload({ width: 2560, height: 1440 }).zoom(), 1.6);
});

test('zoom: a small window shrinks the page, but never below 80%, and a huge one stops at 175%', () => {
  assert.strictEqual(preload({ width: 1300, height: 1000 }).zoom(), 0.9028, 'width is the limit: 1300 / 1440');
  assert.strictEqual(preload({ width: 1100, height: 760 }).zoom(), 0.8, '1100 / 1440 is under the floor');
  assert.strictEqual(preload({ width: 900, height: 600 }).zoom(), 0.8);
  assert.strictEqual(preload({ width: 3840, height: 2160 }).zoom(), 1.75);
});

test('zoom: resizing the window rescales, from its real size whatever the zoom is now', () => {
  const p = preload({ width: 1440, height: 900 });
  p.resize(1920, 1080);
  assert.strictEqual(p.zoom(), 1.2);
  p.resize(1440, 900);
  assert.strictEqual(p.zoom(), 1, 'back down, not stuck at the zoomed size');
});
