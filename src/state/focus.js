// Which screen matters right now - for the dashboard's auto-switch (a
// setting the driver turns on). Decided here, not in the browser, so every
// device agrees, a replay always switches the same way, and it's testable.
//
// Priority, highest first: the session is over -> Debrief; safety car / VSC /
// red flag or a pit call -> Strategy; weather on its way -> Weather; a fight
// either side -> Battle; otherwise Drive.

const RAIN_FOCUS_LAPS = 5;
// A screen stays up at least this long (unless something more urgent comes
// along), and the trigger must be gone this long before going back to Drive:
// a battle hovering at 1s, or a call flickering, mustn't flap the screen.
const HOLD_MS = 8000;
const RELEASE_MS = 5000;
const RANK = { drive: 0, battle: 1, weather: 2, strategy: 3, debrief: 4 };

function wanted({ strategy, analysis, sessionOver }) {
  if (sessionOver) return { screen: 'debrief', reason: 'Session over' };
  const a = analysis || {};
  // Practice / qualifying: Drive has the lap view; the race screens have nothing to say
  // (and the in-lap call is BOX, which would otherwise flip to Strategy every run).
  if (a.quali) return { screen: 'drive', reason: '' };
  if (a.options) return { screen: 'strategy', reason: a.options.situation };
  const call = strategy && strategy.call;
  if (call && call.action === 'BOX') return { screen: 'strategy', reason: call.reason };
  if (call && /undercut/i.test(call.reason)) return { screen: 'strategy', reason: 'Undercut window' };
  const wx = a.weather;
  if (wx) {
    const nc = wx.nextChange;
    if (wx.trackState === 'rain-coming' && nc && nc.inLaps <= RAIN_FOCUS_LAPS) return { screen: 'weather', reason: `Rain in ~${Math.max(1, Math.round(nc.inLaps))} laps` };
    if (wx.trackState === 'drying' || (wx.crossover && wx.crossover.wetGainMs != null)) return { screen: 'weather', reason: wx.trackState === 'drying' ? 'Track drying' : 'Tyre crossover' };
  }
  const bc = strategy && strategy.battle;
  if (bc && ['ATTACK', 'DEFEND', 'CLOSE IN'].includes(bc.mode)) return { screen: 'battle', reason: `${bc.mode}${bc.target ? ` ${bc.mode === 'DEFEND' ? 'vs' : 'on'} ${bc.target}` : ''}` };
  return { screen: 'drive', reason: null };
}

function createFocus(now = Date.now) {
  let current = { screen: 'drive', reason: null };
  let since = 0;
  let lastWanted = 0; // last time the current screen's trigger still held

  return function focus(inputs) {
    const t = now();
    const w = wanted(inputs);
    if (w.screen === current.screen) {
      current = w; // same screen, fresher reason
      lastWanted = t;
    } else {
      const escalate = RANK[w.screen] > RANK[current.screen];
      const held = t - since >= HOLD_MS;
      const released = t - lastWanted >= RELEASE_MS;
      if (escalate || (held && released)) {
        current = w;
        since = t;
        lastWanted = t;
      }
    }
    return { ...current, sinceMs: since };
  };
}

module.exports = { createFocus, wanted, HOLD_MS, RELEASE_MS };
