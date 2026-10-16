const test = require('node:test');
const assert = require('node:assert');
const { ask } = require('../public/ask');

const snap = {
  player: { position: 4, currentLapNum: 12, pitStatus: 0, tyresAgeLaps: 11, tyreCompound: 17 },
  nearby: [
    { name: 'NORRIS', position: 3, gapToPlayerMs: -1240, gapTrendMsPerLap: -300 },
    { name: 'SAINZ', position: 5, gapToPlayerMs: 800, gapTrendMsPerLap: -200 },
    { name: 'ALONSO', position: 6, gapToPlayerMs: 4000, gapTrendMsPerLap: 0 },
  ],
  strategy: { lapsRemaining: 14.3, tyreLapsToCliff: 6.2, fuelMarginLaps: 0.8, call: { action: 'PUSH', reason: 'Tyres and fuel OK' } },
  analysis: {
    pitTiming: { options: [{ id: 'box-0', inLaps: 0 }, { id: 'box-3', inLaps: 3, best: true, compoundName: 'Hard', rejoinPosition: 7, inTraffic: false, finishPosition: 4 }] },
    weather: { trackState: 'rain-coming', nextChange: { inLaps: 4.6, rainPct: 70 } },
    battle: { battery: { you: { nowPct: 60, atLinePct: 52, basis: 'last lap' }, behind: { nowPct: 90, atLinePct: 85, basis: 'last lap' } } },
  },
};

test('ask: the question is understood however it is phrased', () => {
  const id = (t) => ask(t, snap).id;
  assert.strictEqual(id("what's the gap to the car behind"), 'behind');
  assert.strictEqual(id('gap ahead'), 'ahead');
  assert.strictEqual(id('when should I box'), 'box');
  assert.strictEqual(id('how are my tyres'), 'tyres');
  assert.strictEqual(id('is it going to rain'), 'weather');
  assert.strictEqual(id('how many laps left'), 'laps');
  assert.strictEqual(id('tyres'), 'tyres'); // a tapped button sends its id
  assert.strictEqual(id('play some music'), null);
});

test('ask: answers come from the snapshot, one sentence each', () => {
  const reply = (t) => ask(t, snap).reply;
  assert.strictEqual(reply('behind'), 'SAINZ, P5, 0.8s behind, catching you 0.2s a lap.');
  assert.strictEqual(reply('ahead'), "NORRIS, P3, 1.2s ahead, you're closing 0.3s a lap.");
  assert.strictEqual(reply('box'), 'Box in 3 laps, on lap 15, onto hards. Rejoin P7, finish about P4.');
  assert.strictEqual(reply('tyres'), '11 laps old mediums, about 6 laps to the cliff.');
  assert.strictEqual(reply('weather'), 'Rain in about 5 laps, 70% chance.');
  assert.strictEqual(reply('fuel'), 'Fuel is fine, 0.8 laps of margin.');
  assert.strictEqual(reply('battery'), "You're on 60%, about 52% at the line. SAINZ behind 90%, about 85% at the line.");
  assert.strictEqual(reply('laps'), 'P4, 15 laps to go.');
  assert.match(ask('box', { nearby: [] }).reply, /No telemetry/);
});

test('ask: hands-free only acts on what follows the wake word', () => {
  const { afterWake } = require('../public/ask');
  assert.strictEqual(afterWake('Engineer, gap behind?'), 'gap behind?');
  assert.strictEqual(afterWake('hey engineer when do I box'), 'when do I box');
  assert.strictEqual(afterWake('Engineer'), ''); // "go ahead", then the next phrase is the question
  assert.strictEqual(afterWake('what is the gap'), null); // not for us
  assert.strictEqual(afterWake('the engineering on this car'), null);
});
