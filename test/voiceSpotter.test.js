const test = require('node:test');
const assert = require('node:assert');
const { open, raceSnapshots } = require('./helpers/dashboard');

// Roadmap X3: the spotter speaks "car left" / "car right" the moment a side fills, "clear" when both have emptied,
// ahead of routine chatter, and can be switched off in Settings.
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function openVoice(t, { storage = {} } = {}) {
  const said = [];
  const app = open(t, {
    storage,
    before: (w) => {
      w.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      w.speechSynthesis = { speaking: false, paused: false, speak(u) { said.push(u.text); setTimeout(() => u.onend && u.onend(), 0); }, cancel() {}, pause() {}, resume() {}, getVoices: () => [] };
    },
  });
  app.connect();
  const base = raceSnapshots().find((s) => s.player);
  app.send({ ...base, spotter: { left: false, right: false } });
  app.$('voice').click();
  await wait();
  said.length = 0; // the radio check
  const send = async (spotter) => { app.send({ ...base, spotter }); await wait(); };
  return { app, said, send };
}

test('spotter voice: a side filling is said at once, each side once, and "clear" when both are empty', async (t) => {
  const { app, said, send } = await openVoice(t);
  await send({ left: false, right: true });
  assert.deepStrictEqual(said, ['Car right']);
  await send({ left: false, right: true });
  assert.strictEqual(said.length, 1, 'not repeated while it stays');
  await send({ left: true, right: true });
  assert.deepStrictEqual(said.slice(1), ['Car left']);
  await send({ left: true, right: false });
  assert.deepStrictEqual(said.slice(2), ['Clear right'], 'the other side is still taken');
  await send({ left: false, right: false });
  assert.deepStrictEqual(said.slice(3), ['Clear']);
  assert.deepStrictEqual(app.errors, []);
});

test('spotter voice: two cars arriving together are one call', async (t) => {
  const { said, send } = await openVoice(t);
  await send({ left: true, right: true });
  assert.deepStrictEqual(said, ['Cars both sides']);
});

test('spotter voice: switched off in Settings it says nothing, and the choice is remembered', async (t) => {
  const { app, said, send } = await openVoice(t);
  app.$('settings').click();
  assert.strictEqual(app.$('set-spotter').checked, true, 'on by default');
  app.$('set-spotter').checked = false;
  app.$('set-spotter').dispatchEvent(new app.window.Event('change'));
  await send({ left: true, right: false });
  assert.deepStrictEqual(said, []);
  assert.strictEqual(JSON.parse(app.window.localStorage.getItem('raceEngineer.spotter')), false);
});

test('spotter voice: it is silent with the voice off, and a page that opens mid-call does not announce what is already there', async (t) => {
  const said = [];
  const app = open(t, { before: (w) => {
    w.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    w.speechSynthesis = { speaking: false, paused: false, speak(u) { said.push(u.text); }, cancel() {}, pause() {}, resume() {}, getVoices: () => [] };
  } });
  app.connect();
  const base = raceSnapshots().find((s) => s.player);
  app.send({ ...base, spotter: { left: true, right: false } }); // already there when the page opens
  app.send({ ...base, spotter: { left: false, right: false } });
  await wait();
  assert.deepStrictEqual(said, [], 'voice is off by default');
});
