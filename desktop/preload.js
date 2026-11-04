/* global window */
// What the app window may ask of the PC - and nothing else: no file paths,
// no "run this". Phones on the Wi-Fi load the same dashboard without it, so
// recording, deleting and settings stay on the PC (window.undercut is only
// defined here).
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// The content scales to the window: the screens are laid out for 1440 x 900, and any other window
// zooms the whole page by the smaller of its width and height ratios, as a browser's zoom does (so
// viewport units stay true), between 80% and 175%. Measured from the window's real size, which is
// the page's size times the zoom already set.
const DESIGN = [1440, 900];
const ZOOM_RANGE = [0.8, 1.75];
function fitToWindow() {
  const now = webFrame.getZoomFactor();
  const fit = Math.min((window.innerWidth * now) / DESIGN[0], (window.innerHeight * now) / DESIGN[1]);
  const zoom = Math.round(Math.max(ZOOM_RANGE[0], Math.min(ZOOM_RANGE[1], fit)) * 10000) / 10000;
  if (Math.abs(zoom - now) > 0.001) webFrame.setZoomFactor(zoom);
}
window.addEventListener('resize', fitToWindow);
fitToWindow();

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const EVENTS = new Set(['status', 'speech', 'llm']);

contextBridge.exposeInMainWorld('undercut', {
  status: call('status'),
  setSettings: call('settings'),
  record: call('record'),
  stopRecording: call('stopRecording'),
  replay: call('replay'),
  live: call('live'),
  captures: call('captures'),
  diskUse: call('diskUse'),
  analyze: call('analyze'),
  deleteCapture: call('deleteCapture'),
  deleteSession: call('deleteSession'),
  showCapture: call('showCapture'),
  openReport: call('openReport'),
  openDataFolder: call('openDataFolder'),
  openInBrowser: call('openInBrowser'),
  speech: { start: call('speech:start'), stop: call('speech:stop') },
  llm: {
    status: call('llm:status'), models: call('llm:models'), catalog: call('llm:catalog'), ask: call('llm:ask'), stop: call('llm:stop'),
    pull: call('llm:pull'), cancelPull: call('llm:cancelPull'), remove: call('llm:delete'),
    downloads: call('llm:downloads'), clearDownloads: call('llm:clearDownloads'),
    sessions: call('llm:sessions'), results: call('llm:results'), chart: call('llm:chart'),
  },
  // on('status' | 'speech', fn) -> unsubscribe
  on: (channel, fn) => {
    if (!EVENTS.has(channel)) return () => {};
    const handler = (_e, msg) => fn(msg);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
