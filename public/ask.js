// Ask the engineer: a question, spoken or tapped, answered from the latest
// snapshot in one sentence. Nothing is decided here - the gaps, projections
// and the pit-timing pick all arrive computed from the bridge; this only
// picks the right numbers and says them. Runs in the browser (window.RaceAsk)
// and in Node for the tests.
(function (root) {
  'use strict';

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const s1 = (ms) => (Math.abs(ms) / 1000).toFixed(1);
  const lapsTxt = (n) => {
    const l = Math.max(1, Math.round(n));
    return `${l} lap${l === 1 ? '' : 's'}`;
  };
  const COMPOUND = { 16: 'softs', 17: 'mediums', 18: 'hards', 7: 'inters', 8: 'wets' };

  function neighbour(s, side) {
    const cars = (s.nearby || []).filter((c) => (side === 'ahead' ? c.gapToPlayerMs < 0 : c.gapToPlayerMs >= 0));
    cars.sort((a, b) => Math.abs(a.gapToPlayerMs) - Math.abs(b.gapToPlayerMs));
    return cars[0] || null;
  }

  function gapAnswer(s, side) {
    const c = neighbour(s, side);
    if (!c) return side === 'ahead' ? 'Nobody ahead - you are leading.' : 'Nobody behind you.';
    const t = c.gapTrendMsPerLap;
    let trend = '';
    if (isNum(t) && Math.abs(t) >= 50) {
      trend = side === 'ahead'
        ? (t < 0 ? `, you're closing ${s1(t)}s a lap` : `, pulling away ${s1(t)}s a lap`)
        : (t < 0 ? `, catching you ${s1(t)}s a lap` : `, you're pulling away ${s1(t)}s a lap`);
    }
    return `${c.name}, P${c.position}, ${s1(c.gapToPlayerMs)}s ${side}${trend}.`;
  }

  function boxAnswer(s) {
    const a = s.analysis || {};
    if (s.player && s.player.pitStatus) return 'You are in the pit lane.';
    if (a.options) return a.options.headline;
    const pt = a.pitTiming;
    if (pt) {
      const best = pt.options.find((o) => o.best);
      if (best.inLaps == null) return `Stay out - no stop beats it. Finish about P${best.finishPosition}.`;
      const when = best.inLaps === 0 ? 'Box this lap' : best.inLaps === 1 ? 'Box next lap' : `Box in ${best.inLaps} laps, on lap ${s.player.currentLapNum + best.inLaps}`;
      return `${when}, onto ${best.compoundName.toLowerCase()}s. Rejoin P${best.rejoinPosition}${best.inTraffic ? ' in traffic' : ''}, finish about P${best.finishPosition}.`;
    }
    const rj = a.rejoin;
    if (rj) return `Box now and you rejoin P${rj.position}${rj.inTraffic ? ' in traffic' : ' in clean air'}. Timing needs a few more laps of tyre data.`;
    return 'Not enough data for a pit call yet.';
  }

  function tyreAnswer(s) {
    const st = s.strategy || {};
    const tyre = `${s.player.tyresAgeLaps} laps old ${COMPOUND[s.player.tyreCompound] || 'tyres'}`;
    const c = st.tyreLapsToCliff;
    if (!isNum(c)) return `${tyre}. Still measuring the wear rate.`;
    if (c < 0.5) return `${tyre}, at the cliff.`;
    return c > 20 ? `${tyre}, 20 plus laps to the cliff.` : `${tyre}, about ${lapsTxt(c)} to the cliff.`;
  }

  function weatherAnswer(s) {
    const wx = s.analysis && s.analysis.weather;
    if (!wx) return 'No weather data yet.';
    const nc = wx.nextChange;
    if (wx.trackState === 'rain-coming') return `Rain in about ${lapsTxt(nc.inLaps)}, ${nc.rainPct}% chance.`;
    if (wx.trackState === 'raining') return nc && !nc.afterFlag ? `Raining, stops in about ${lapsTxt(nc.inLaps)}.` : 'Raining to the flag.';
    if (wx.trackState === 'drying') return 'Track is drying - watch the crossover.';
    return 'Dry, no rain before the flag.';
  }

  function fuelAnswer(s) {
    const m = s.strategy && s.strategy.fuelMarginLaps;
    if (!isNum(m)) return 'Fuel: not enough laps to say yet.';
    return m < 0 ? `Fuel is ${Math.abs(m).toFixed(1)} laps short - lift and coast.` : `Fuel is fine, ${m.toFixed(1)} laps of margin.`;
  }

  function batteryAnswer(s) {
    const b = s.analysis && s.analysis.battle && s.analysis.battle.battery;
    if (!b || !b.you) return 'No battery data.';
    const at = (x) => (x.basis === 'last lap' ? `${x.nowPct}%, about ${x.atLinePct}% at the line` : `${x.nowPct}%`);
    const parts = [`You're on ${at(b.you)}`];
    const ahead = neighbour(s, 'ahead');
    const behind = neighbour(s, 'behind');
    if (b.ahead && ahead) parts.push(`${ahead.name} ahead ${at(b.ahead)}`);
    if (b.behind && behind) parts.push(`${behind.name} behind ${at(b.behind)}`);
    return `${parts.join('. ')}.`;
  }

  function lapsAnswer(s) {
    const left = s.strategy && s.strategy.lapsRemaining;
    return isNum(left) ? `P${s.player.position}, ${Math.ceil(left)} laps to go.` : `P${s.player.position}, lap ${s.player.currentLapNum}.`;
  }

  function callAnswer(s) {
    const st = s.strategy;
    const bc = st && st.battle;
    if (!st) return 'Waiting for lap data.';
    return `${st.call.action[0]}${st.call.action.slice(1).toLowerCase()} - ${st.call.reason}.${bc && bc.mode !== 'CLEAR' ? ` ${bc.reason}.` : ''}`;
  }

  // Most specific first: "gap behind" must not be read as a pit question.
  const QUESTIONS = [
    { id: 'behind', label: 'Gap behind?', match: /\b(behind|back|mirrors?)\b/, answer: (s) => gapAnswer(s, 'behind') },
    { id: 'ahead', label: 'Gap ahead?', match: /\b(ahead|in front|front|gap)\b/, answer: (s) => gapAnswer(s, 'ahead') },
    { id: 'box', label: 'When do I box?', match: /\b(box|pit|stop|window|undercut)\b/, answer: boxAnswer },
    { id: 'battery', label: 'Battery?', match: /\b(battery|ers|energy|deploy|overtake)\b/, answer: batteryAnswer },
    { id: 'tyres', label: 'Tyres?', match: /\b(tyres?|tires?|wear|cliff|rubber)\b/, answer: tyreAnswer },
    { id: 'weather', label: 'Rain?', match: /\b(rain|weather|wet|dry|forecast)\b/, answer: weatherAnswer },
    { id: 'fuel', label: 'Fuel?', match: /\b(fuel|gas|petrol)\b/, answer: fuelAnswer },
    { id: 'laps', label: 'Laps left?', match: /\b(laps?|left|to go|position|where am i)\b/, answer: lapsAnswer },
    { id: 'call', label: 'The call?', match: /\b(call|plan|what (do|should) i do|strategy)\b/, answer: callAnswer },
  ];
  const HELP = 'Try: gap behind, when do I box, tyres, rain, fuel, battery, or what\'s the call.';

  // text: what the recogniser heard (or a tapped question's id). Returns the reply.
  function ask(text, s) {
    const t = String(text || '').toLowerCase();
    const q = QUESTIONS.find((x) => x.id === t) || QUESTIONS.find((x) => x.match.test(t));
    if (!q) return { id: null, reply: `Didn't catch that. ${HELP}` };
    if (!s || !s.player) return { id: q.id, reply: 'No telemetry yet - get on track first.' };
    return { id: q.id, reply: q.answer(s) };
  }

  const api = { ask, QUESTIONS, HELP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RaceAsk = api;
})(typeof window !== 'undefined' ? window : this);
