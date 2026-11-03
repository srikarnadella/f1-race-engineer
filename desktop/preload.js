// What the app window may ask of the PC - and nothing else: no file paths,
// no "run this". Phones on the Wi-Fi load the same dashboard without it, so
// recording, deleting and settings stay on the PC (window.undercut is only
// defined here).
const { contextBridge, ipcRenderer } = require('electron');

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
  },
  // on('status' | 'speech', fn) -> unsubscribe
  on: (channel, fn) => {
    if (!EVENTS.has(channel)) return () => {};
    const handler = (_e, msg) => fn(msg);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
