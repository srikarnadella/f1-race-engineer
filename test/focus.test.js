const test = require('node:test');
const assert = require('node:assert');
const { createFocus, wanted, HOLD_MS, RELEASE_MS } = require('../src/state/focus');

const battle = { strategy: { call: { action: 'PUSH', reason: 'Tyres and fuel OK' }, battle: { mode: 'DEFEND', target: 'NORRIS' } } };
const calm = { strategy: { call: { action: 'PUSH', reason: 'Tyres and fuel OK' }, battle: { mode: 'CLEAR' } } };
const boxing = { strategy: { call: { action: 'BOX', reason: 'Tyres at the cliff - box this lap' }, battle: { mode: 'DEFEND', target: 'NORRIS' } } };

test('focus: priority - debrief > SC options > box > weather > battle > drive', () => {
  assert.strictEqual(wanted({ ...boxing, sessionOver: true }).screen, 'debrief');
  assert.strictEqual(wanted({ ...battle, analysis: { options: { situation: 'VSC' } } }).screen, 'strategy');
  assert.strictEqual(wanted(boxing).screen, 'strategy');
  // A qualifying in-lap is a BOX call too, but Drive is the screen for it.
  assert.strictEqual(wanted({ ...boxing, analysis: { quali: { name: 'Q1' } } }).screen, 'drive');
  const rain = { trackState: 'rain-coming', nextChange: { inLaps: 3.4 } };
  assert.deepStrictEqual(wanted({ ...battle, analysis: { weather: rain } }), { screen: 'weather', reason: 'Rain in ~3 laps' });
  assert.strictEqual(wanted({ ...battle, analysis: { weather: { ...rain, nextChange: { inLaps: 9 } } } }).screen, 'battle');
  assert.deepStrictEqual(wanted(battle), { screen: 'battle', reason: 'DEFEND vs NORRIS' });
  assert.strictEqual(wanted(calm).screen, 'drive');
  assert.strictEqual(wanted({}).screen, 'drive');
});

test('focus: escalates at once, holds, and only returns once the trigger has settled', () => {
  let t = 100000;
  const focus = createFocus(() => t);
  assert.strictEqual(focus(battle).screen, 'battle'); // escalation: immediate
  t += 1000;
  assert.strictEqual(focus(calm).screen, 'battle'); // a one-tick gap doesn't flap it back
  t += 1000;
  assert.strictEqual(focus(battle).screen, 'battle');
  t += HOLD_MS;
  assert.strictEqual(focus(battle).screen, 'battle');
  t += 100;
  assert.strictEqual(focus(calm).screen, 'battle'); // held long enough, but the fight only just ended
  t += RELEASE_MS;
  assert.strictEqual(focus(calm).screen, 'drive');
  // A box call jumps straight over the hold of a battle.
  assert.strictEqual(focus(battle).screen, 'battle');
  t += 500;
  assert.strictEqual(focus(boxing).screen, 'strategy');
});
