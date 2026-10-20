// Ask the engineer: a question, spoken or tapped, answered from the latest
// snapshot in one sentence. Nothing is decided here - the gaps, projections
// and the pit-timing pick all arrive computed from the bridge; this only
// picks the right numbers and says them. Runs in the browser (window.RaceAsk)
// and in Node for the tests.
(/** @param {any} root */ function (root) {
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

  // Qualifying / practice: the road around you, not the order.
  const quali = (s) => (s.analysis && s.analysis.quali) || null;
  const s3 = (ms) => (Math.abs(ms) / 1000).toFixed(3);
  function qualiStanding(q) {
    const left = isNum(q.timeLeftS) ? `, ${Math.floor(q.timeLeftS / 60)} minutes ${q.timeLeftS % 60} left` : '';
    if (q.position == null) return `${q.name}: no time yet${left}.`;
    const where = q.cut && isNum(q.cut.marginMs)
      ? `, ${s3(q.cut.marginMs)} ${q.cut.marginMs < 0 ? 'clear of the cut' : `short of P${q.cut.position} - you're out`}`
      : q.position === 1 ? ', fastest' : `, ${s3(q.gapToPoleMs)} off P1`;
    return `${q.name}: P${q.position}${where}${left}.`;
  }
  function qualiRoad(q, side) {
    const t = q.traffic && q.traffic[side];
    if (t) return side === 'ahead' ? `${t.name} on ${t.status === 'out' ? 'an out lap' : 'a slow lap'}, ${t.gapS.toFixed(1)}s up the road.` : `${t.name} on a push lap ${t.gapS.toFixed(1)}s behind - let them by.`;
    return side === 'ahead' ? 'Clear road ahead.' : 'Nobody close behind on a push lap.';
  }

  function gapAnswer(s, side) {
    if (quali(s)) return qualiRoad(quali(s), side);
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
    if (quali(s)) return `No pit strategy outside a race. ${qualiStanding(quali(s))}`;
    if (s.player && s.player.pitStatus) return 'You are in the pit lane.';
    if (a.options) return a.options.headline;
    const rp = a.racePlan;
    if (rp) {
      const NAME = { 16: 'softs', 17: 'mediums', 18: 'hards' };
      const p = rp.best;
      return `The plan is ${p.stops} stop${p.stops === 1 ? '' : 's'}: ${p.stints.map((x) => `${NAME[x.compound]} for ${x.laps}`).join(', then ')}, boxing at the end of lap ${p.boxLaps.join(' and ')}.${rp.other ? ` ${rp.other.stops} stop${rp.other.stops === 1 ? '' : 's'} is about ${Math.round(rp.other.slowerMs / 1000)} seconds slower.` : ''}`;
    }
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
    if (!isNum(c)) return st.tyresReachFlag ? `${tyre}, they last to the flag.` : `${tyre}. Still measuring the wear rate.`;
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
    const save = s.strategy.fuelSavePct;
    return m < 0 ? `Fuel is ${Math.abs(m).toFixed(1)} laps short - save about ${save || 1} percent a lap, lift and coast.` : `Fuel is fine, ${m.toFixed(1)} laps of margin.`;
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
    if (quali(s)) return qualiStanding(quali(s));
    const left = s.strategy && s.strategy.lapsRemaining;
    return isNum(left) ? `P${s.player.position}, ${Math.ceil(left)} laps to go.` : `P${s.player.position}, lap ${s.player.currentLapNum}.`;
  }

  function callAnswer(s) {
    const st = s.strategy;
    const bc = st && st.battle;
    if (!st) return 'Waiting for lap data.';
    return `${st.call.action[0]}${st.call.action.slice(1).toLowerCase()} - ${st.call.reason}.${bc && bc.mode !== 'CLEAR' ? ` ${bc.reason}.` : ''}`;
  }

  function damageAnswer(s) {
    const d = s.analysis && s.analysis.damage;
    if (!d) return 'No damage.';
    const what = d.parts.map((x) => `${x.label.toLowerCase()} ${x.pct}%`).join(', ');
    if (d.lossPerLapMs == null) return `Damage: ${what}. ${d.basis === 'no-baseline' ? 'No clean lap from before it to compare with.' : 'Still measuring what it costs.'}`;
    if (d.lossPerLapMs < 150) return `Damage: ${what}, but it isn't costing lap time.`;
    const flag = isNum(d.toFlagMs) ? `, about ${Math.round(d.toFlagMs / 1000)}s to the flag` : '';
    const fix = d.fix ? (d.fix.pays ? (d.fix.stopAnyway ? ' Change the nose at your stop.' : ` A new nose costs about ${Math.round(d.fix.costMs / 1000)}s - box for it.`) : ` A new nose costs about ${Math.round(d.fix.costMs / 1000)}s - not worth a stop.`) : '';
    return `${what}: costing ${s1(d.lossPerLapMs)}s a lap${flag}.${fix}`;
  }

  function penaltyAnswer(s) {
    const p = s.analysis && s.analysis.penalties;
    if (!p) return 'No penalties, no track-limit warnings.';
    const out = [];
    if (p.stopGos) out.push('A stop-go to serve - box, no tyre change.');
    else if (p.driveThroughs) out.push('A drive-through to serve - box.');
    if (p.timeS) {
      out.push(p.servedAt === 'stop'
        ? `${p.timeS} second penalty, served at your stop.`
        : p.flag ? `${p.timeS} second penalty at the flag - ${p.flag.name} is ${s1(p.flag.gapMs)} seconds behind, ${p.flag.covered ? 'covered' : 'not covered'}.` : `${p.timeS} second penalty at the flag.`);
    }
    const tl = p.trackLimits;
    if (tl.count) out.push(`${tl.count} track-limit warning${tl.count === 1 ? '' : 's'}${tl.last && tl.last.corner != null ? `, the last at turn ${tl.last.corner}` : ''}.`);
    return out.join(' ');
  }

  // Most specific first: "gap behind" must not be read as a pit question,
  // nor "front wing" as the gap in front.
  const QUESTIONS = [
    { id: 'damage', label: 'Damage?', match: /\b(damage[ds]?|wing|nose|broken|floor|diffuser)\b/, answer: damageAnswer },
    { id: 'penalty', label: 'Penalties?', match: /\b(penalt(y|ies)|track limits|warnings?|stop.go|drive.through)\b/, answer: penaltyAnswer },
    { id: 'behind', label: 'Gap behind?', match: /\b(behind|back|mirrors?)\b/, answer: (s) => gapAnswer(s, 'behind') },
    { id: 'ahead', label: 'Gap ahead?', match: /\b(ahead|in front|front|gap)\b/, answer: (s) => gapAnswer(s, 'ahead') },
    { id: 'box', label: 'When do I box?', match: /\b(box|pit|stop|window|undercut)\b/, answer: boxAnswer },
    { id: 'battery', label: 'Battery?', match: /\b(battery|ers|energy|deploy|overtake)\b/, answer: batteryAnswer },
    { id: 'tyres', label: 'Tyres?', match: /\b(tyres?|tires?|wear|cliff|rubber)\b/, answer: tyreAnswer },
    { id: 'weather', label: 'Rain?', match: /\b(rain|weather|wet|dry|forecast)\b/, answer: weatherAnswer },
    { id: 'fuel', label: 'Fuel?', match: /\b(fuel|gas|petrol)\b/, answer: fuelAnswer },
    { id: 'laps', label: 'Laps left?', match: /\b(laps?|left|to go|position|where am i|cut|through|pole)\b/, answer: lapsAnswer },
    { id: 'call', label: 'The call?', match: /\b(call|plan|what (do|should) i do|strategy)\b/, answer: callAnswer },
  ];
  const HELP = 'Try: gap behind, when do I box, tyres, damage, rain, fuel, battery, or what\'s the call.';

  // ---------- Custom commands: your phrase, the things you want reported ----------
  const lapTime = (ms) => (isNum(ms) && ms > 0 ? `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(1).padStart(4, '0')}` : null);
  function lastLapAnswer(s) {
    const last = lapTime(s.player.lastLapTimeInMS);
    if (!last) return 'No lap time yet.';
    const best = s.player.bestLapTimeInMS;
    const off = isNum(best) && best > 0 ? s.player.lastLapTimeInMS - best : null;
    return `Last lap ${last}${off == null ? '' : off <= 0 ? ', your best' : `, ${s1(off)}s off your best`}.`;
  }
  const bestLapAnswer = (s) => (lapTime(s.player.bestLapTimeInMS) ? `Best lap ${lapTime(s.player.bestLapTimeInMS)}.` : 'No clean lap yet.');
  function paceAnswer(s) {
    const mine = lapTime(s.player.paceMs);
    if (!mine) return 'Pace needs a few clean laps.';
    const side = (c, where) => (c && isNum(c.paceMs) ? `, ${c.name} ${where} ${lapTime(c.paceMs)}` : '');
    return `Your pace ${mine}${side(neighbour(s, 'ahead'), 'ahead')}${side(neighbour(s, 'behind'), 'behind')}.`;
  }
  function rejoinAnswer(s) {
    const rj = s.analysis && s.analysis.rejoin;
    return rj ? `Box now and you rejoin P${rj.position}${rj.inTraffic ? ' in traffic' : ' in clean air'}.` : 'No rejoin estimate right now.';
  }
  function pitLossAnswer(s) {
    const pl = s.analysis && s.analysis.pitLoss;
    return pl ? `A stop costs ${s1(pl.ms)}s${pl.neutralised ? ` under the ${pl.neutralised}` : ''}.` : 'No pit loss yet.';
  }
  function carAnswer(s) {
    const tip = s.adjust && s.adjust.suggestions[0];
    return tip ? `Car: ${tip.action}, ${tip.where}.` : 'Car is balanced, no changes.';
  }
  // Everything a custom command can report, in the order it's read out.
  const REPORTS = [
    ...QUESTIONS.map((q) => ({ id: q.id, label: q.label.replace(/\?$/, ''), answer: q.answer })),
    { id: 'lastlap', label: 'Last lap', answer: lastLapAnswer },
    { id: 'bestlap', label: 'Best lap', answer: bestLapAnswer },
    { id: 'pace', label: 'Pace vs cars either side', answer: paceAnswer },
    { id: 'rejoin', label: 'Rejoin if I box now', answer: rejoinAnswer },
    { id: 'pitloss', label: 'Pit loss', answer: pitLossAnswer },
    { id: 'car', label: 'Car setting tip', answer: carAnswer },
  ];
  const REPORT = Object.fromEntries(REPORTS.map((r) => [r.id, r]));

  const words = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').trim().replace(/\s+/g, ' ');
  // A saved command, cleaned up - or null if it can't work. The phrase can't
  // be the wake word, and needs at least one thing to report.
  function cleanCommand(c) {
    const phrase = words(c && c.phrase).slice(0, 40);
    const reports = [...new Set((c && Array.isArray(c.reports) ? c.reports : []).filter((id) => REPORT[id]))];
    if (phrase.length < 2 || /\bengineers?\b/.test(phrase) || !reports.length) return null;
    return { phrase, reports };
  }
  // "status" matches "status", "status please" and "give me a status" - the
  // phrase's words together, anywhere in what was said.
  const said = (t, phrase) => ` ${words(t)} `.includes(` ${phrase} `);

  // text: what the recogniser heard (or a tapped question's id). custom: your
  // commands, checked first - you made them on purpose. Returns the reply.
  function ask(text, s, custom = []) {
    const t = String(text || '').toLowerCase();
    const mine = custom.find((c) => said(t, c.phrase));
    if (mine) {
      if (!s || !s.player) return { id: 'custom', reply: 'No telemetry yet - get on track first.' };
      return { id: 'custom', reply: mine.reports.map((id) => REPORT[id].answer(s)).join(' ') };
    }
    const q = QUESTIONS.find((x) => x.id === t) || QUESTIONS.find((x) => x.match.test(t));
    if (!q) return { id: null, reply: `Didn't catch that. ${HELP}` };
    if (!s || !s.player) return { id: q.id, reply: 'No telemetry yet - get on track first.' };
    return { id: q.id, reply: q.answer(s) };
  }

  // Hands-free: only what follows the wake word counts. "Engineer, gap
  // behind?" -> 'gap behind?'; "Engineer" alone -> '' (ask what they need);
  // no wake word -> null (talk to someone else, the game, the radio...).
  const WAKE = /\b(?:hey |ok |okay )?engineers?\b[\s,.:;!?-]*/i;
  function afterWake(text) {
    const t = String(text || '');
    const m = t.match(WAKE);
    return m ? t.slice(m.index + m[0].length).trim() : null;
  }

  const api = { ask, afterWake, cleanCommand, QUESTIONS, REPORTS, HELP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RaceAsk = api;
})(typeof window !== 'undefined' ? window : this);
