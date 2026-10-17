// Widget library. Each widget is a self-contained card: mount(el) builds its
// DOM once from a static template and returns update(snapshot), which only
// writes text/classes. Widgets format and colour; they never decide anything
// - the calls, projections and gaps all arrive pre-computed from the server.
//
// Driver names come from game packets, so they are only ever set with
// textContent, never interpolated into HTML.
(function () {
  'use strict';

  // ---------- Formatting ----------
  const COMPOUND = { 16: 'S', 17: 'M', 18: 'H', 7: 'I', 8: 'W' };
  const WEATHER = ['Clear', 'Light cloud', 'Overcast', 'Light rain', 'Heavy rain', 'Storm'];
  const SAFETY_CAR = { 1: 'Safety car', 2: 'Virtual safety car', 3: 'Formation lap' };
  const YELLOW = { 1: 'Safety car', 2: 'VSC' };

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  function fmtLap(ms) {
    if (!isNum(ms) || ms <= 0) return '–';
    const m = Math.floor(ms / 60000);
    return `${m}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
  }
  const secs = (ms, dp = 1) => (isNum(ms) ? (Math.abs(ms) / 1000).toFixed(dp) : '–');
  const signed = (ms, dp = 1) => (isNum(ms) ? `${ms < 0 ? '−' : '+'}${secs(ms, dp)}` : '–');
  const level = (v, watch, act) => (v >= act ? 'is-act' : v >= watch ? 'is-watch' : '');

  function setText(el, text) {
    const t = text == null ? '' : String(text);
    if (el.textContent !== t) el.textContent = t;
  }
  function setTone(el, tone) {
    for (const c of ['is-good', 'is-watch', 'is-act', 'is-muted', 'is-info', 'is-pb']) el.classList.toggle(c, c === tone);
  }
  function setCompound(el, code) {
    const c = COMPOUND[code] || '';
    setText(el, c);
    el.dataset.c = c;
  }
  function compoundBadge(code) {
    const b = document.createElement('span');
    b.className = 'compound';
    setCompound(b, code);
    return b;
  }

  // Builds the static template and collects [data-ref] elements.
  function template(el, html) {
    el.innerHTML = html;
    const refs = {};
    el.querySelectorAll('[data-ref]').forEach((n) => { refs[n.dataset.ref] = n; });
    return refs;
  }

  // Nearest car each side, from the server's signed gaps.
  function neighbours(s) {
    const ahead = s.nearby.filter((n) => n.gapToPlayerMs < 0).sort((a, b) => b.gapToPlayerMs - a.gapToPlayerMs)[0] || null;
    const behind = s.nearby.filter((n) => n.gapToPlayerMs >= 0).sort((a, b) => a.gapToPlayerMs - b.gapToPlayerMs)[0] || null;
    return { ahead, behind };
  }

  // "Closing 0.5s/lap" etc, from the server's gap trend (negative = shrinking).
  function trendText(car, side) {
    const t = car && car.gapTrendMsPerLap;
    if (!isNum(t)) return { text: 'Pace: needs a clean lap', tone: 'is-muted' };
    const rate = `${secs(t)}s/lap`;
    if (Math.abs(t) < 50) return { text: 'Holding the gap', tone: 'is-muted' };
    if (side === 'ahead') return t < 0 ? { text: `Closing ${rate}`, tone: 'is-good' } : { text: `Dropping ${rate}`, tone: 'is-watch' };
    return t < 0 ? { text: `Catching you ${rate}`, tone: 'is-act' } : { text: `Pulling away ${rate}`, tone: 'is-good' };
  }

  function tyreCompare(car, myAge) {
    if (!car || !isNum(car.tyresAgeLaps) || !isNum(myAge)) return '';
    const d = car.tyresAgeLaps - myAge;
    if (d === 0) return 'same age tyres';
    const n = Math.abs(d);
    return `${n} lap${n === 1 ? '' : 's'} ${d > 0 ? 'older' : 'fresher'} tyres`;
  }

  // A wear rate and, once the field has enough laps, its 90% range: "+0.090s (0.071–0.110)".
  const degText = (d) => `+${(d.degMsPerLap / 1000).toFixed(3)}s${d.ciMs ? ` <span class="dim">(${(d.ciMs[0] / 1000).toFixed(3)}–${(d.ciMs[1] / 1000).toFixed(3)})</span>` : ''}`;

  const W = {};

  // ---------- Radio ----------
  W.radio = {
    title: 'Radio',
    description: 'The most important call right now, plus anything else active',
    mount(el) {
      const r = template(el, `
        <div class="w-radio">
          <div class="w-radio__top"><span class="w-radio__cat" data-ref="cat"></span><span class="w-radio__msg" data-ref="msg"></span></div>
          <ul class="w-radio__rest" data-ref="rest"></ul>
        </div>`);
      // Severity tints the whole card rather than a box nested inside it.
      const card = el.closest('.card');
      return (s) => {
        const [top, ...rest] = s.insights || [];
        card.dataset.severity = top ? top.severity : 'none';
        setText(r.cat, top ? top.category : '');
        setText(r.msg, top ? top.message : 'No calls - drive');
        const sig = rest.map((i) => i.id + i.message).join('|');
        if (r.rest.dataset.sig !== sig) {
          r.rest.dataset.sig = sig;
          r.rest.replaceChildren(...rest.slice(0, 4).map((i) => {
            const li = document.createElement('li');
            li.dataset.severity = i.severity;
            li.textContent = i.message;
            return li;
          }));
        }
      };
    },
  };

  // ---------- Strategy call ----------
  W.call = {
    title: 'Call',
    description: 'PUSH / HOLD / BOX / PIT with the reason behind it',
    mount(el) {
      const r = template(el, `<div class="w-call"><div class="w-call__action big" data-ref="action">–</div><div class="w-call__reason" data-ref="reason"></div></div>`);
      return (s) => {
        const st = s.strategy;
        setText(r.action, st ? st.call.action : '–');
        r.action.dataset.action = st ? st.call.action : '';
        setText(r.reason, st ? st.call.reason : 'Waiting for lap data');
      };
    },
  };

  // ---------- Pit rejoin ----------
  W.rejoin = {
    title: 'If you box now',
    description: 'Where you would rejoin, who is around you, measured pit loss',
    mount(el) {
      const r = template(el, `
        <div class="w-rejoin">
          <div class="w-rejoin__head"><span class="big" data-ref="pos">–</span><span class="w-rejoin__lost" data-ref="lost"></span><span class="tag tag--watch" data-ref="traffic" hidden>Traffic</span></div>
          <div class="w-rejoin__cars">
            <div class="w-rejoin__row"><span class="w-rejoin__label">Behind</span><b class="w-rejoin__name" data-ref="aName">–</b><span class="w-rejoin__tyre" data-ref="aTyre"></span><span class="w-rejoin__gap" data-ref="aGap"></span></div>
            <div class="w-rejoin__row"><span class="w-rejoin__label">Ahead of</span><b class="w-rejoin__name" data-ref="bName">–</b><span class="w-rejoin__tyre" data-ref="bTyre"></span><span class="w-rejoin__gap" data-ref="bGap"></span></div>
          </div>
          <div class="w-foot" data-ref="foot"></div>
        </div>`);
      const tyre = (holder, car) => {
        const sig = car ? `${car.tyreCompound}:${car.tyresAgeLaps}` : '';
        if (holder.dataset.sig === sig) return;
        holder.dataset.sig = sig;
        holder.replaceChildren(...(car ? [compoundBadge(car.tyreCompound), ` ${isNum(car.tyresAgeLaps) ? car.tyresAgeLaps : ''}`] : []));
      };
      return (s) => {
        const a = s.analysis;
        const rj = a && a.rejoin;
        const inPit = s.player && s.player.pitStatus;
        setText(r.pos, inPit ? 'In pits' : rj ? `P${rj.position}` : '–');
        setText(r.lost, rj && !inPit ? (rj.positionsLost > 0 ? `−${rj.positionsLost} places` : 'no places lost') : '');
        setTone(r.lost, rj && rj.positionsLost > 0 ? 'is-watch' : 'is-good');
        r.traffic.hidden = !(rj && rj.inTraffic && !inPit);
        setText(r.aName, rj && rj.ahead ? rj.ahead.name : '–');
        setText(r.aGap, rj && rj.ahead ? `+${secs(rj.ahead.gapMs)}s` : '');
        tyre(r.aTyre, rj && rj.ahead);
        setText(r.bName, rj && rj.behind ? rj.behind.name : '–');
        setText(r.bGap, rj && rj.behind ? `${secs(rj.behind.gapMs)}s` : '');
        tyre(r.bTyre, rj && rj.behind);
        const pl = a && a.pitLoss;
        const source = pl && (pl.source === 'measured' ? `measured (${pl.lastMeasuredFrom}${pl.samples > 1 ? ` +${pl.samples - 1}` : ''})` : pl.source);
        setText(r.foot, !pl ? '' : pl.neutralised
          ? `Pit loss ~${secs(pl.ms, 0)}s under ${pl.neutralised} · normally ${secs(pl.normalMs)}s, ${source}`
          : `Pit loss ${secs(pl.ms)}s · ${source}`);
        // A cheap stop is the moment to look at this card - make it say so.
        r.foot.classList.toggle('is-watch', !!(pl && pl.neutralised));
      };
    },
  };

  // ---------- Battle (shared by the Battle card and the Drive screen) ----------
  // Everything about one side of the fight that the HUD doesn't say: where
  // the gap is heading, how likely a pass is (the trained overtake model),
  // and - under the 2026 rules - Overtake mode instead of DRS.
  const LEVEL = { low: 'LOW', medium: 'MED', high: 'HIGH' };
  function battleSide(s, car, which) {
    const yellow = s.session && YELLOW[s.session.safetyCarStatus];
    const a = s.analysis || {};
    const out = { name: car ? car.name : '–', pos: car ? `P${car.position}` : '', gap: car ? `${secs(car.gapToPlayerMs)}s` : '–', gapTone: '', trend: '', trendTone: 'is-muted', chip: '', chipTone: '', extra: '', extraTone: '' };
    if (!car) {
      // Nobody there: say why rather than showing blank dashes.
      const pos = s.player && s.player.position;
      if (which === 'ahead' && pos === 1) return { ...out, name: 'Leading', gap: '' };
      if (which === 'behind' && pos > 1) return { ...out, name: 'Last', gap: '' };
      return out;
    }
    if (car.pitStatus) return { ...out, trend: 'In the pits', trendTone: 'is-info' };
    // Under a safety car the gaps collapse and nobody can overtake, so a
    // closing rate, pass chance or DRS countdown would be misleading.
    if (yellow) return { ...out, trend: `${yellow} - no overtaking`, trendTone: 'is-watch' };
    const close = Math.abs(car.gapToPlayerMs) < 1000;
    out.gapTone = close ? (which === 'ahead' ? 'is-good' : 'is-act') : '';
    const tr = trendText(car, which);
    out.trend = tr.text;
    out.trendTone = tr.tone;
    // ML: chance of a pass in the next few seconds (attack ahead / threat behind).
    const ml = a.battle && (which === 'ahead' ? a.battle.attack : a.battle.defend);
    if (ml) {
      out.chip = `${which === 'ahead' ? 'Pass' : 'Threat'} ${LEVEL[ml.level]} · ${Math.round(ml.p * 100)}%`;
      out.chipTone = ml.level === 'high' ? (which === 'ahead' ? 'is-good' : 'is-act') : ml.level === 'medium' ? 'is-watch' : 'is-muted';
    }
    if (a.regs2026) {
      if (which === 'ahead' && a.overtake && a.overtake.available) [out.extra, out.extraTone] = ['OVERTAKE MODE READY', 'is-good'];
      if (which === 'behind' && car.overtakeAvailable) [out.extra, out.extraTone] = ['Has Overtake mode on you', 'is-act'];
    } else if (close) {
      [out.extra, out.extraTone] = [which === 'ahead' ? 'In DRS range' : 'In your DRS range', which === 'ahead' ? 'is-good' : 'is-act'];
    } else if (isNum(car.lapsToDrs)) {
      out.extra = `DRS range in ~${Math.ceil(car.lapsToDrs)} lap${Math.ceil(car.lapsToDrs) === 1 ? '' : 's'}`;
    }
    out.tyre = tyreCompare(car, s.player && s.player.tyresAgeLaps);
    // Straight-line speed on the last green lap: who has the edge down the straights.
    const me = (s.field || []).find((c) => c.isPlayer);
    if (isNum(car.topSpeedKmh) && me && isNum(me.topSpeedKmh)) {
      const edge = me.topSpeedKmh - car.topSpeedKmh;
      out.speed = `Top speed ${car.topSpeedKmh} km/h · you ${me.topSpeedKmh}`;
      out.speedTone = Math.abs(edge) < 5 ? 'is-muted' : edge > 0 ? 'is-good' : which === 'behind' ? 'is-act' : 'is-watch';
    }
    // Projected battery at the line, theirs against yours.
    const bat = a.battle && a.battle.battery;
    const them = bat && bat[which];
    if (them && isNum(them.atLinePct)) {
      const mine = bat.you && isNum(bat.you.atLinePct) ? bat.you.atLinePct : null;
      const edge = mine == null ? null : mine - them.atLinePct;
      // Until there is a clean last lap to copy, the projection is just the current value.
      const proj = them.basis === 'last lap' ? ` → ~${them.atLinePct}% at line` : '';
      out.ers = `Battery ${them.nowPct}%${proj}${mine != null ? ` · you ${bat.you.basis === 'last lap' ? '~' : ''}${mine}%` : ''}`;
      out.ersTone = edge == null || Math.abs(edge) < 10 ? 'is-muted' : edge > 0 ? 'is-good' : which === 'behind' ? 'is-act' : 'is-watch';
    }
    // Attack forecast: where (and when) the fight is likely to happen. Shown
    // only once the engineer has made the call - it's settled for a few
    // seconds server-side, so the screen and the radio always agree.
    const ids = new Set((s.insights || []).map((i) => i.id));
    const fc = a.battle && (which === 'ahead' ? a.battle.attackForecast : a.battle.defendForecast);
    const called = which === 'ahead' ? ids.has('attack-chance') : ids.has('attack-warning') || (ids.has('under-attack') && (s.insights.find((i) => i.id === 'under-attack').message || '').includes('watch corner'));
    if (fc && fc.where && called) {
      const where = `corner ${fc.where.corner} (${(fc.where.atM / 1000).toFixed(1)} km)`;
      // Worded as a likely spot, not a prediction: it ties the plain "busiest
      // passing corner" rule so far (docs/accuracy.md).
      out.forecast = which === 'ahead' ? `Your likely spot: ${where}` : `Their likely spot: ${where}${fc.when.laps > 0 ? ` · ${fc.when.text}` : ''}`;
    }
    return out;
  }
  function fillSide(r, k, v, car) {
    setText(r[`${k}Name`], v.pos ? `${v.pos} ${v.name}` : v.name);
    setText(r[`${k}Gap`], v.gap);
    setTone(r[`${k}Gap`], v.gapTone);
    setText(r[`${k}Trend`], v.trend);
    setTone(r[`${k}Trend`], v.trendTone);
    setText(r[`${k}Chip`], v.chip);
    setTone(r[`${k}Chip`], v.chipTone);
    r[`${k}Chip`].hidden = !v.chip;
    setText(r[`${k}Extra`], v.extra);
    setTone(r[`${k}Extra`], v.extraTone);
    setText(r[`${k}Ers`], v.ers || '');
    setTone(r[`${k}Ers`], v.ersTone || '');
    r[`${k}Ers`].hidden = !v.ers;
    if (r[`${k}Spd`]) {
      setText(r[`${k}Spd`], v.speed || '');
      setTone(r[`${k}Spd`], v.speedTone || '');
      r[`${k}Spd`].hidden = !v.speed;
    }
    setText(r[`${k}Fc`], v.forecast || '');
    r[`${k}Fc`].hidden = !v.forecast;
    if (r[`${k}Badge`]) {
      setCompound(r[`${k}Badge`], car ? car.tyreCompound : null);
      setText(r[`${k}Tyre`], v.tyre || '');
    }
  }
  const sideHtml = (k, label, withTyre) => `
    <div class="w-battle__side">
      <div class="w-label">${label}</div>
      <div class="w-battle__name" data-ref="${k}Name">–</div>
      <div class="big w-battle__gap" data-ref="${k}Gap">–</div>
      <div class="w-battle__trend" data-ref="${k}Trend"></div>
      <div class="w-battle__chips"><span class="chip" data-ref="${k}Chip" hidden></span><span class="w-battle__extra" data-ref="${k}Extra"></span></div>
      <div class="w-battle__ers" data-ref="${k}Ers" hidden></div>
      ${withTyre ? `<div class="w-battle__ers" data-ref="${k}Spd" hidden></div>` : ''}
      <div class="w-battle__fc w-battle__fc--${k}" data-ref="${k}Fc" hidden></div>
      ${withTyre ? `<div class="w-battle__tyre"><span data-ref="${k}Badge" class="compound"></span> <span data-ref="${k}Tyre"></span></div>` : ''}
    </div>`;

  // ATTACK / DEFEND / CLOSE IN / CLEAR - the settled battle call, as a banner.
  const modeHtml = '<div class="w-drive__mode" data-ref="modeBox" hidden><b data-ref="mode"></b><span data-ref="modeWhy"></span></div>';
  function fillMode(r, s) {
    const bc = s.strategy && s.strategy.battle;
    r.modeBox.hidden = !bc;
    if (!bc) return;
    setText(r.mode, bc.mode === 'ATTACK' ? `ATTACK ${bc.target}` : bc.mode === 'DEFEND' ? `DEFEND vs ${bc.target}` : bc.mode === 'CLOSE IN' ? `CLOSE IN on ${bc.target}` : bc.mode === 'CLEAR' ? 'CLEAR AIR' : 'HOLD THE GAP');
    setText(r.modeWhy, bc.reason);
    r.modeBox.dataset.mode = bc.mode;
  }

  W.battle = {
    title: 'Battle',
    description: 'Car ahead and behind: gap trend, pass / threat chance (ML), projected battery, Overtake mode or DRS, tyre age',
    mount(el) {
      const r = template(el, `<div class="w-battle-wrap">${modeHtml}<div class="w-battle">${sideHtml('a', 'Ahead', true)}${sideHtml('b', 'Behind', true)}</div></div>`);
      return (s) => {
        fillMode(r, s);
        const { ahead, behind } = neighbours(s);
        fillSide(r, 'a', battleSide(s, ahead, 'ahead'), ahead);
        fillSide(r, 'b', battleSide(s, behind, 'behind'), behind);
      };
    },
  };

  // ---------- Qualifying / practice: this lap and where you stand ----------
  const clockText = (s) => (isNum(s) ? `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, Math.round(s)) % 60).padStart(2, '0')}` : '–');
  const LAP_STATUS = { garage: 'In the garage', out: 'Out lap', in: 'In lap', track: 'On track', flying: 'Push lap' };
  function qualiSides(s, q) {
    const lap = { name: LAP_STATUS[q.status] || '', gap: '–', gapTone: 'is-muted', trend: '', trendTone: 'is-muted', chip: '', extra: '' };
    if (q.status === 'flying') {
      if (q.lapInvalid) Object.assign(lap, { gap: 'Deleted', gapTone: 'is-act', trend: "track limits - it won't count", trendTone: 'is-act' });
      else if (q.projected) {
        const tone = q.projected.improves ? 'is-pb' : 'is-watch';
        Object.assign(lap, { gap: `P${q.projected.position}`, gapTone: tone, trend: `${deltaText(s.player.deltaToBestMs)} to your best`, trendTone: tone });
      } else Object.assign(lap, { gap: 'Timed', gapTone: 'is-good', trend: 'first time on the board' });
    } else if (q.toLine) {
      const ok = q.toLine.makesIt;
      Object.assign(lap, { gap: clockText(q.toLine.startsInS), gapTone: ok ? '' : 'is-act', trend: !ok ? 'the flag falls first' : q.toLine.spareS != null ? `to the line · ${clockText(q.toLine.spareS)} to spare` : 'to the line', trendTone: ok ? 'is-muted' : 'is-act' });
    } else if (q.status === 'garage') {
      Object.assign(lap, { gap: clockText(q.timeLeftS), gapTone: '', trend: q.runs === 0 ? 'left · no time for another run' : `left · time for ${q.runs} run${q.runs === 1 ? '' : 's'}` });
    }
    const t = q.traffic && (q.traffic.ahead || q.traffic.behind);
    if (t) Object.assign(lap, { chip: q.traffic.ahead ? `TRAFFIC ${t.gapS.toFixed(1)}s` : 'LET BY', chipTone: 'is-watch', extra: t.name });
    const stand = { name: q.cut ? `Top ${q.cut.position} go through` : 'By best lap', gap: q.position ? `P${q.position}` : '–', gapTone: q.position ? '' : 'is-muted', trend: q.position == null ? 'no time yet' : q.position === 1 ? 'fastest' : `+${secs(q.gapToPoleMs, 3)} to P1`, trendTone: 'is-muted', chip: '', extra: '' };
    if (q.cut && q.cut.marginMs != null) {
      const through = q.cut.marginMs < 0;
      Object.assign(stand, { chip: through ? 'THROUGH' : 'OUT', chipTone: through ? 'is-good' : 'is-act', extra: `${secs(q.cut.marginMs, 3)} ${through ? 'clear of' : 'short of'} P${q.cut.position}` });
    }
    return { lap, stand };
  }
  function qualiTiles(q) {
    const best = [q.bestMs ? fmtLap(q.bestMs) : 'No time', q.position ? `P${q.position}${q.position > 1 ? ` · +${secs(q.gapToPoleMs, 3)} to P1` : ''}` : 'set a lap', q.bestMs ? '' : 'is-muted'];
    let cut = ['–', 'no cut this session', 'is-muted'];
    if (q.cut) {
      cut = q.cut.marginMs == null
        ? ['–', `P${q.cut.position} goes through`, 'is-muted']
        : [`${secs(q.cut.marginMs, 3)} ${q.cut.marginMs < 0 ? 'clear' : 'short'}`, `P${q.cut.position} at ${fmtLap(q.cut.lineMs)}`, q.cut.marginMs < 0 ? 'is-good' : 'is-act'];
    } else if (q.poleMs) {
      cut = [q.position === 1 ? 'You' : `+${secs(q.gapToPoleMs, 3)}`, `P1 ${fmtLap(q.poleMs)}`, q.position === 1 ? 'is-pb' : ''];
    }
    return {
      tyre: ['Time left', q.timeLeftS == null ? 'No clock' : clockText(q.timeLeftS), q.runs != null ? (q.runs === 0 ? 'no time for another run' : `time for ${q.runs} run${q.runs === 1 ? '' : 's'}`) : q.toLine && q.toLine.spareS != null ? `${clockText(q.toLine.spareS)} spare at the line` : q.timeLeftS == null ? 'time trial' : 'start a lap before 0:00', q.timeLeftS <= 120 ? 'is-watch' : ''],
      box: ['Best', ...best],
      wx: [q.cut ? 'Cut' : 'To P1', ...cut],
    };
  }
  // The Car tile: what damage is costing, else the setup tip.
  function carTile(s) {
    const d = s.analysis && s.analysis.damage;
    if (d) {
      const l = d.lossPerLapMs;
      if (l == null) return ['Damage', d.basis === 'no-baseline' ? 'no clean lap to compare' : 'measuring the cost', 'is-watch'];
      if (l < 150) return ['Damage', 'not costing lap time', 'is-muted'];
      const verdict = d.fix ? (d.fix.pays ? (d.fix.stopAnyway ? 'new nose at your stop' : 'box for a new nose') : 'not worth a stop') : d.parts.map((x) => x.label.toLowerCase()).join(', ');
      return [`+${secs(l)}s/lap`, verdict, 'is-act'];
    }
    const tip = s.adjust && s.adjust.suggestions[0];
    return tip ? [tip.action, tip.where, 'is-info'] : ['Balanced', 'no changes needed', 'is-muted'];
  }

  // ---------- Drive: the one screen to leave up while racing ----------
  // Only what the game's HUD and MFD can't tell you, sized for a half-second
  // glance: the call, the fight either side, the engineer's latest radio
  // call, and four projections (tyres, a stop now, weather, a car tweak).
  W.drive = {
    title: 'Drive',
    description: 'The glance screen: the call, the battle either side, the radio, and what\'s coming',
    tall: true,
    mount(el) {
      const tile = (k, label) => `<div class="w-drive__tile" data-ref="${k}Tile"><span class="w-label" data-ref="${k}Label">${label}</span><b data-ref="${k}">–</b><span class="w-drive__sub" data-ref="${k}Sub"></span></div>`;
      const LABELS = { tyre: 'Tyres', box: 'Box now', wx: 'Weather' };
      const r = template(el, `
        <div class="w-drive">
          <div class="w-drive__call" data-ref="callBox"><span class="w-drive__action" data-ref="action">–</span><span class="w-drive__reason" data-ref="reason">Waiting for lap data</span></div>
          ${modeHtml}
          <div class="w-drive__middle">
            <div class="w-drive__battle" data-ref="battleBox">${sideHtml('a', 'Ahead', false)}${sideHtml('b', 'Behind', false)}</div>
            <div class="w-drive__options w-opt" data-ref="optBox" hidden></div>
            <div class="w-drive__battle w-drive__quali" data-ref="qualiBox" hidden>${sideHtml('q', 'This lap', false)}${sideHtml('s', 'Standing', false)}</div>
          </div>
          <div class="w-drive__radio" data-ref="radioBox"><span class="w-drive__radio-tag">RADIO</span><span data-ref="radio">No calls - drive</span></div>
          <div class="w-drive__tiles">${tile('tyre', 'Tyres')}${tile('box', 'Box now')}${tile('wx', 'Weather')}${tile('tip', 'Car')}</div>
        </div>`);
      return (s) => {
        const st = s.strategy;
        const a = s.analysis || {};
        setText(r.action, st ? st.call.action : '–');
        r.callBox.dataset.action = st ? st.call.action : '';
        setText(r.reason, st ? st.call.reason : 'Waiting for lap data');

        const top = (s.insights || [])[0];
        setText(r.radio, top ? top.message : 'No calls - drive');
        r.radioBox.dataset.severity = top ? top.severity : 'none';
        const car = carTile(s);
        setText(r.tip, car[0]);
        setText(r.tipSub, car[1]);
        setTone(r.tip, car[2]);

        // Practice / qualifying: this lap and where you stand, not a battle.
        const q = a.quali;
        r.qualiBox.hidden = !q;
        if (q) {
          r.battleBox.hidden = true;
          r.optBox.hidden = true;
          r.modeBox.hidden = true;
          const sides = qualiSides(s, q);
          fillSide(r, 'q', sides.lap, null);
          fillSide(r, 's', sides.stand, null);
          for (const [k, [label, value, sub, tone]] of Object.entries(qualiTiles(q))) {
            setText(r[`${k}Label`], label);
            setText(r[k], value);
            setText(r[`${k}Sub`], sub);
            setTone(r[k], tone);
          }
          return;
        }
        for (const [k, label] of Object.entries(LABELS)) setText(r[`${k}Label`], label);

        const { ahead, behind } = neighbours(s);
        fillSide(r, 'a', battleSide(s, ahead, 'ahead'), ahead);
        fillSide(r, 'b', battleSide(s, behind, 'behind'), behind);

        fillMode(r, s);

        // Under a safety car / VSC / red flag the fight is on hold: the
        // middle of the screen becomes the strategy options instead.
        const o = a.options;
        r.battleBox.hidden = !!o;
        r.optBox.hidden = !o;
        const osig = o ? JSON.stringify(o.options.map((x) => [x.id, x.position, x.recommended, x.reachesFlag, Math.round(x.paceDeltaS * 10)])) : '';
        if (o && r.optBox.dataset.sig !== osig) {
          r.optBox.dataset.sig = osig;
          r.optBox.innerHTML = optionsHtml(o);
        }

        // Tyres: the projection, not the wear % the MFD already shows.
        const cliff = st && st.tyreLapsToCliff;
        const pay = a.tyreModel && a.tyreModel.payback;
        let tyre = ['Measuring', '', 'is-muted'];
        if (isNum(cliff)) tyre = cliff > 20 ? ['20+ laps', 'to the cliff', 'is-good'] : cliff < 0.5 ? ['At the cliff', 'lap time is going', 'is-act'] : [`${cliff.toFixed(1)} laps`, 'to the cliff', cliff <= 1 ? 'is-act' : cliff <= 3 ? 'is-watch' : 'is-good'];
        if (pay && pay.worthIt && !a.pitTiming) tyre[1] = `new set repays a stop in ~${Math.round(pay.paybackLaps)} laps`;
        setText(r.tyre, tyre[0]);
        setText(r.tyreSub, tyre[1]);
        setTone(r.tyre, tyre[2]);

        const rj = a.rejoin;
        const inPit = s.player && s.player.pitStatus;
        setText(r.box, inPit ? 'In pits' : rj ? `P${rj.position}` : '–');
        // The pit-timing pick, when there is one, says more than traffic / clear air.
        const ptBest = a.pitTiming && a.pitTiming.options.find((o) => o.best);
        const ptText = ptBest ? ` · best: ${ptBest.inLaps == null ? 'stay out' : ptBest.inLaps === 0 ? 'this lap' : `lap ${s.player.currentLapNum + ptBest.inLaps}`}` : null;
        setText(r.boxSub, inPit || !rj ? '' : `${rj.positionsLost > 0 ? `−${rj.positionsLost}` : 'no loss'}${ptText || (rj.inTraffic ? ' · traffic' : ' · clear air')}${a.pitLoss && a.pitLoss.neutralised ? ` · cheap (${a.pitLoss.neutralised})` : ''}`);
        setTone(r.box, rj && rj.inTraffic ? 'is-watch' : '');

        const wx = a.weather;
        let w = ['–', '', 'is-muted'];
        if (wx) {
          const nc = wx.nextChange;
          if (wx.trackState === 'rain-coming') w = [`Rain ~${Math.max(1, Math.round(nc.inLaps))} laps`, `${nc.rainPct}% chance`, Math.round(nc.inLaps) <= 3 ? 'is-act' : 'is-watch'];
          else if (wx.trackState === 'raining') w = [nc && !nc.afterFlag ? `Stops ~${Math.max(1, Math.round(nc.inLaps))} laps` : 'Wet to the flag', 'raining', 'is-info'];
          else if (wx.trackState === 'drying') w = ['Drying', wx.crossover && wx.crossover.wetGainMs != null ? `${wx.crossover.wetGainMs > 0 ? 'inters' : 'slicks'} faster` : 'watch the crossover', 'is-watch'];
          else w = ['Dry', nc && nc.to === 'rain' ? 'to the flag' : 'no rain forecast', 'is-good'];
        }
        setText(r.wx, w[0]);
        setText(r.wxSub, w[1]);
        setTone(r.wx, w[2]);
      };
    },
  };

  // ---------- Lap delta: vs your best and your previous lap, live mini-sectors ----------
  const deltaText = (ms) => (isNum(ms) ? `${ms <= 0 ? '−' : '+'}${(Math.abs(ms) / 1000).toFixed(3)}` : '–');
  W.laptime = {
    title: 'Lap delta',
    description: 'Live delta to your best lap and your previous lap, and this lap\'s mini-sectors (purple = best, green = quicker than last lap, yellow = slower)',
    mount(el) {
      const r = template(el, `
        <div class="w-lt">
          <div class="w-lt__deltas">
            <div><span class="w-label">To best</span><b class="w-lt__big" data-ref="best">–</b><span class="w-lt__ref" data-ref="bestRef"></span></div>
            <div><span class="w-label">To last lap</span><b class="w-lt__big" data-ref="last">–</b><span class="w-lt__ref" data-ref="lastRef"></span></div>
          </div>
          <div class="w-lt__strip" data-ref="strip"></div>
        </div>`);
      r.strip.innerHTML = Array.from({ length: 25 }, () => '<span></span>').join('');
      const cells = [...r.strip.children];
      return (s) => {
        const p = s.player;
        setText(r.best, deltaText(p.deltaToBestMs));
        setTone(r.best, isNum(p.deltaToBestMs) ? (p.deltaToBestMs <= 0 ? 'is-pb' : 'is-act') : 'is-muted');
        setText(r.bestRef, isNum(p.bestLapTimeInMS) ? `best ${fmtLap(p.bestLapTimeInMS)}` : 'needs a clean lap');
        setText(r.last, deltaText(p.deltaToLastMs));
        setTone(r.last, isNum(p.deltaToLastMs) ? (p.deltaToLastMs <= 0 ? 'is-good' : 'is-watch') : 'is-muted');
        setText(r.lastRef, isNum(p.previousLapTimeInMS) ? `last ${fmtLap(p.previousLapTimeInMS)}` : '');
        const ms = p.liveMiniSectors || [];
        cells.forEach((c, k) => {
          const st = ms[k] ? ms[k].state : null;
          const cls = st ? `is-${st}` : '';
          if (c.className !== cls) c.className = cls;
          c.title = ms[k] && isNum(ms[k].vsLastMs) ? `${ms[k].vsLastMs > 0 ? '+' : ''}${(ms[k].vsLastMs / 1000).toFixed(3)}s vs last lap` : '';
        });
      };
    },
  };

  // ---------- Strategy options under SC / VSC / red flag ----------
  function optionsHtml(o) {
    const cards = o.options.map((x) => `
      <div class="w-opt__card${x.recommended ? ' is-best' : ''}">
        <div class="w-opt__title">${x.recommended ? '<span class="w-opt__pick">BEST</span>' : ''}${esc(x.title)}</div>
        <div class="w-opt__pos">${x.position != null ? `P${x.position}` : '–'}<span>${x.positionsLost ? ` −${x.positionsLost}` : ''}</span></div>
        <div class="w-opt__line">${badge(x.compound)} ${esc(x.tyre)}</div>
        <div class="w-opt__line ${x.reachesFlag ? 'is-good' : 'is-watch'}">${x.reachesFlag ? 'Lasts to the flag' : `${x.lifeLaps} laps of life, ${o.lapsLeft} to go`}</div>
        ${Math.abs(x.paceDeltaS) >= 0.1 ? `<div class="w-opt__line">${Math.abs(x.paceDeltaS).toFixed(1)}s/lap ${x.paceDeltaS < 0 ? 'faster' : 'slower'} than now</div>` : ''}
      </div>`).join('');
    return `<div class="w-opt__head"><b>${esc(o.situation)}</b> · ${o.lapsLeft} laps left${o.freeStop ? ' · tyre change is free' : ''}</div><div class="w-opt__cards">${cards}</div>`;
  }
  // ---------- Pit timing: which lap to box on ----------
  // The bridge races every stop lap out to the flag; this lays out the
  // first few and the best, with where each rejoins and finishes.
  const whenText = (o) => (o.inLaps == null ? 'Stay out' : o.inLaps === 0 ? 'Box this lap' : o.inLaps === 1 ? 'Box next lap' : `Box in ${o.inLaps} laps`);
  function pitTimingHtml(pt, s) {
    const lap = s.player.currentLapNum;
    const best = pt.options.find((o) => o.best);
    const rows = pt.options.map((o) => `<tr class="${o.best ? 'is-best' : ''}">
        <td class="strong">${o.inLaps == null ? 'Stay out' : o.inLaps === 0 ? 'This lap' : o.inLaps === 1 ? 'Next lap' : `In ${o.inLaps}`} <span class="dim">${o.inLaps == null ? '' : `L${lap + o.inLaps}`}</span></td>
        <td class="tyre">${badge(o.compound)}</td>
        <td class="num">P${o.rejoinPosition}${o.inTraffic ? ' <span class="pit-tag">TRAFFIC</span>' : ''}</td>
        <td class="num strong">P${o.finishPosition}</td>
        <td class="num ${o.best ? 'is-good' : 'dim'}">${o.best ? 'BEST' : `+${o.lossS.toFixed(1)}s`}</td></tr>`).join('');
    const pl = s.analysis.pitLoss;
    // Only when the pick moves within the tyre model's range: a firm pick needs no caveat.
    const w = pt.wear && !pt.wear.holds ? pt.wear : null;
    const wearNote = w ? `<div class="w-pt__wear is-watch">Lap ${lap + w.fromInLaps}${w.toInLaps == null ? ' or later' : w.toInLaps === w.fromInLaps ? '' : `–${lap + w.toInLaps}`}, depending on tyre wear</div>` : '';
    return `<div class="w-pt">
      <div class="w-pt__head"><span class="w-pt__when">${whenText(best)}</span><span class="w-pt__sub">${best.inLaps == null ? `finish ~P${best.finishPosition}` : `lap ${lap + best.inLaps} · ${esc(best.compoundName)}s · finish ~P${best.finishPosition}`}</span></div>
      ${wearNote}
      <table class="tbl w-pt__tbl"><thead><tr><th>Stop</th><th>Tyre</th><th class="num">Rejoin</th><th class="num">Finish</th><th class="num">Cost</th></tr></thead><tbody>${rows}</tbody></table>
      ${pt.stops && pt.stops.length ? `<div class="w-pt__stops"><span class="w-label">Expected stops</span>${pt.stops.map((x) => `<span>${esc(x.name)} <span class="dim">P${x.position}</span> ${x.inLaps === 0 ? 'this lap' : x.inLaps === 1 ? 'next lap' : `in ${x.inLaps}`}</span>`).join('')}</div>` : ''}
      <div class="w-foot">Each stop lap raced to the flag against the field and its expected stops · pit loss ${pl ? secs(pl.ms) : '–'}s</div></div>`;
  }
  // Before the start: the race plan, until pit timing has the field's laps to go on.
  function racePlanHtml(rp) {
    const name = (c) => COMPOUND_NAME[c] || c;
    const stints = (p) => p.stints.map((x) => `${name(x.compound)} ${x.laps}`).join(' → ');
    const src = Object.entries(rp.degSource).map(([c, v]) => `${name(c).toLowerCase()} ${v}`).join(' · ');
    // The plan raced over with each wear rate and the pit loss drawn as widely as they're uncertain.
    const odds = rp.odds ? (rp.best.stops === 1 ? rp.odds.oneStopPct : rp.odds.twoStopPct) : null;
    return `<div class="w-pt">
      <div class="w-pt__head"><span class="w-pt__when">${rp.best.stops} stop${rp.best.stops === 1 ? '' : 's'}</span><span class="w-pt__sub">${stints(rp.best)} · box end of lap ${rp.best.boxLaps.join(' and ')}</span></div>
      ${odds != null ? `<div class="w-pt__wear ${odds >= 80 ? 'is-good' : 'is-watch'}">wins ${odds}% of ${rp.odds.samples.toLocaleString('en-US')} simulated races</div>` : ''}
      ${rp.other ? `<div class="w-pt__stops"><span class="w-label">Instead</span><span>${rp.other.stops} stop${rp.other.stops === 1 ? '' : 's'}: ${stints(rp.other)} <span class="dim">~${Math.round(rp.other.slowerMs / 1000)}s slower</span></span></div>` : ''}
      <div class="w-foot">The race plan from your tyre sets, the pit loss and each compound's wear (${src}). Pit timing takes over once the field has laps on the board.</div></div>`;
  }
  const ptSig = (pt) => JSON.stringify([pt.options.map((o) => [o.id, o.compound, o.rejoinPosition, o.inTraffic, o.finishPosition, o.lossS]), pt.stops, pt.wear]);

  W.pittiming = {
    title: 'Pit timing',
    description: 'Box this lap, next lap or later: every stop lap raced to the flag - rejoin and finish position, time cost against the best',
    mount(el) {
      el.innerHTML = '<div class="w-pt__wrap"></div>';
      const box = el.firstElementChild;
      return (s) => {
        const pt = s.analysis && s.analysis.pitTiming;
        const rp = !pt && s.analysis && s.analysis.racePlan;
        const sig = pt ? ptSig(pt) + s.player.currentLapNum : rp ? JSON.stringify(rp) : '';
        if (box.dataset.sig === sig) return;
        box.dataset.sig = sig;
        box.innerHTML = pt ? pitTimingHtml(pt, s) : rp ? racePlanHtml(rp) : '<div class="w-deb__empty dim">Needs a few green-flag laps of tyre data from the field - and a dry track.</div>';
      };
    },
  };

  W.options = {
    title: 'Strategy options',
    description: 'Under a safety car, VSC or red flag: stay out vs box for each tyre you have. Under green: which lap to box on (pit timing), or the cars around you',
    mount(el) {
      // Green flag: pit timing once there's tyre data, the cars around you until then.
      el.innerHTML = '<div class="w-opt" hidden></div><div class="w-opt__pt" hidden></div><div class="w-opt__near"></div>';
      const [box, ptBox, near] = el.children;
      const updateNear = W.nearby.mount(near);
      const updatePt = W.pittiming.mount(ptBox);
      const title = el.closest('.card') && el.closest('.card').querySelector('.card__title');
      return (s) => {
        const o = s.analysis && s.analysis.options;
        const pt = !o && s.analysis && s.analysis.pitTiming;
        box.hidden = !o;
        ptBox.hidden = !pt;
        near.hidden = !!(o || pt);
        if (title) setText(title, o ? 'Strategy options' : pt ? 'Pit timing' : 'Around you');
        if (pt) return updatePt(s);
        if (!o) return updateNear(s);
        const sig = JSON.stringify(o.options.map((x) => [x.id, x.position, x.recommended, x.reachesFlag, Math.round(x.paceDeltaS * 10)]));
        if (box.dataset.sig === sig) return;
        box.dataset.sig = sig;
        box.innerHTML = optionsHtml(o);
      };
    },
  };

  // ---------- Tyre strategy (ML) ----------
  // Not the wear % (that's on the MFD): the projection - laps to the cliff,
  // the field-wide degradation the model has learned, and whether fresh
  // tyres would pay for a stop with the laps that are left.
  const COMPOUND_NAME = { 16: 'Soft', 17: 'Medium', 18: 'Hard', 7: 'Inter', 8: 'Wet' };
  W.tyrecall = {
    title: 'Tyre strategy',
    description: 'Laps to the cliff, field-learned degradation per compound (ML), and whether a stop pays back',
    mount(el) {
      const r = template(el, `
        <div class="w-tc">
          <div class="w-tc__head"><span class="compound compound--lg" data-ref="badge"></span><span class="mid" data-ref="cliff">–</span></div>
          <div class="w-sub" data-ref="pay"></div>
          <table class="tbl w-tc__deg" data-ref="deg"></table>
          <div class="w-foot" data-ref="foot">Degradation learned live from every car's laps, fuel-corrected</div>
        </div>`);
      return (s) => {
        const st = s.strategy;
        const tm = s.analysis && s.analysis.tyreModel;
        setCompound(r.badge, s.player.tyreCompound);
        const cliff = st && st.tyreLapsToCliff;
        let text = 'Measuring wear';
        let tone = 'is-muted';
        if (isNum(cliff)) [text, tone] = cliff > 20 ? ['20+ laps to the cliff', 'is-good'] : cliff < 0.5 ? ['At the cliff', 'is-act'] : [`${cliff.toFixed(1)} laps to the cliff`, cliff <= 1 ? 'is-act' : cliff <= 3 ? 'is-watch' : 'is-good'];
        setText(r.cliff, text);
        setTone(r.cliff, tone);
        const pay = tm && tm.payback;
        // The pit-timing pick, when there is one: it has the fresh set's real pace and the field.
        const pt = s.analysis.pitTiming;
        const ptBest = pt && pt.options.find((o) => o.best);
        setText(r.pay, ptBest ? `Best stop: ${ptBest.inLaps == null ? 'stay out' : `lap ${s.player.currentLapNum + ptBest.inLaps}, onto ${ptBest.compoundName.toLowerCase()}s`} (pit timing)` : pay ? `A new set gains ~${(pay.gainPerLapMs / 1000).toFixed(2)}s a lap - repays a stop in ~${pay.paybackLaps} laps${pay.worthIt === false ? ' (not before the flag)' : ''}` : 'Stop pay-back: needs a few laps of field data');
        const rows = tm ? Object.entries(tm.compounds) : [];
        const sig = JSON.stringify(rows);
        if (r.deg.dataset.sig !== sig) {
          r.deg.dataset.sig = sig;
          r.deg.innerHTML = rows.length
            ? `<tr><th>Compound</th><th class="num">Loss / lap of age</th><th class="num">Laps · cars</th></tr>${rows.map(([c, d]) => `<tr><td>${COMPOUND_NAME[c] || c}</td><td class="num strong">${degText(d)}</td><td class="num dim">${d.laps} · ${d.cars}</td></tr>`).join('')}`
            : '<tr><td class="dim">Learning from the field - needs 3 cars with 3 clean laps on a compound</td></tr>';
        }
      };
    },
  };

  // ---------- Pace ----------
  W.pace = {
    title: 'Pace',
    description: 'Your clean-lap pace against the cars either side',
    mount(el) {
      const row = (k, label) => `<tr><td class="dim">${label}</td><td data-ref="${k}Name"></td><td class="num" data-ref="${k}Pace">–</td><td class="num" data-ref="${k}Diff"></td></tr>`;
      const r = template(el, `
        <div class="w-pace">
          <table class="tbl">${row('a', 'Ahead')}${row('m', 'You')}${row('b', 'Behind')}</table>
          <div class="w-foot">Average of the last 3 laps outside the pits and safety car</div>
        </div>`);
      const fill = (k, name, pace, myPace) => {
        setText(r[`${k}Name`], name || '–');
        setText(r[`${k}Pace`], fmtLap(pace));
        const diff = k !== 'm' && isNum(pace) && isNum(myPace) ? pace - myPace : null;
        setText(r[`${k}Diff`], isNum(diff) ? signed(diff, 2) : '');
        setTone(r[`${k}Diff`], isNum(diff) ? (diff > 0 ? 'is-good' : 'is-act') : '');
      };
      return (s) => {
        const { ahead, behind } = neighbours(s);
        const my = s.player.paceMs;
        fill('a', ahead && ahead.name, ahead && ahead.paceMs, my);
        fill('m', s.player.name, my, my);
        fill('b', behind && behind.name, behind && behind.paceMs, my);
      };
    },
  };

  // ---------- Tables: nearby + full timing tower ----------
  function tableWidget({ rows, columns, scrollToPlayer }) {
    return (el) => {
      el.innerHTML = '<div class="w-table"><table class="tbl tbl--board"><tbody></tbody></table></div>';
      const wrap = el.firstElementChild;
      const tbody = el.querySelector('tbody');
      return (s) => {
        const list = rows(s);
        const sig = JSON.stringify(list.map((c) => columns.map((col) => col.key(c, s))));
        if (tbody.dataset.sig === sig) return;
        tbody.dataset.sig = sig;
        tbody.replaceChildren(...list.map((c) => {
          const tr = document.createElement('tr');
          if (c.isPlayer) tr.className = 'is-player';
          for (const col of columns) {
            const td = document.createElement('td');
            td.className = col.cls || '';
            col.render(td, c, s);
            tr.appendChild(td);
          }
          return tr;
        }));
        if (scrollToPlayer) {
          const me = tbody.querySelector('.is-player');
          if (me && (me.offsetTop < wrap.scrollTop || me.offsetTop + me.offsetHeight > wrap.scrollTop + wrap.clientHeight)) {
            wrap.scrollTop = me.offsetTop - wrap.clientHeight / 2;
          }
        }
      };
    };
  }
  const COL = {
    pos: { cls: 'pos', key: (c) => c.position, render: (td, c) => setText(td, `P${c.position}`) },
    name: {
      cls: 'name',
      key: (c) => `${c.name}${c.pitStatus}`,
      render: (td, c) => {
        td.textContent = c.name;
        if (c.pitStatus) {
          const pit = document.createElement('span');
          pit.className = 'pit-tag';
          pit.textContent = 'PIT';
          td.appendChild(pit);
        }
      },
    },
    gap: { cls: 'num strong', key: (c) => Math.round(c.gapToPlayerMs / 100), render: (td, c) => setText(td, c.isPlayer ? '' : signed(c.gapToPlayerMs)) },
    interval: { cls: 'num dim', key: (c) => Math.round((c.intervalMs || 0) / 100), render: (td, c) => setText(td, isNum(c.intervalMs) ? `+${secs(c.intervalMs)}` : 'Leader') },
    trend: {
      cls: 'num',
      key: (c) => (isNum(c.gapTrendMsPerLap) ? Math.round(c.gapTrendMsPerLap / 50) : null),
      render: (td, c) => {
        const t = c.gapTrendMsPerLap;
        if (c.isPlayer || !isNum(t) || Math.abs(t) < 50) return setText(td, '');
        setText(td, `${t < 0 ? '▼' : '▲'}${secs(t)}`);
        td.title = t < 0 ? 'gap shrinking per lap' : 'gap growing per lap';
        // Behind you and closing = threat; ahead of you and closing = opportunity.
        setTone(td, t < 0 ? (c.gapToPlayerMs > 0 ? 'is-act' : 'is-good') : 'is-muted');
      },
    },
    tyre: {
      cls: 'tyre',
      key: (c) => `${c.tyreCompound}:${c.tyresAgeLaps}`,
      render: (td, c) => td.replaceChildren(compoundBadge(c.tyreCompound), ` ${isNum(c.tyresAgeLaps) ? c.tyresAgeLaps : ''}`),
    },
    stops: { cls: 'num dim', key: (c) => c.numPitStops, render: (td, c) => setText(td, isNum(c.numPitStops) ? `${c.numPitStops} stop${c.numPitStops === 1 ? '' : 's'}` : '') },
    last: { cls: 'num dim', key: (c) => c.lastLapTimeInMS, render: (td, c) => setText(td, fmtLap(c.lastLapTimeInMS)) },
  };

  W.nearby = {
    title: 'Around you',
    description: 'Two cars each side: gap, gap trend per lap, tyres, last lap',
    mount: tableWidget({
      rows: (s) => (s.field || []).filter((c, i, all) => {
        const me = all.findIndex((x) => x.isPlayer);
        return Math.abs(i - me) <= 2;
      }),
      columns: [COL.pos, COL.name, COL.gap, COL.trend, COL.tyre],
    }),
  };


  // ---------- Debrief: post-session recap ----------
  // The live session plus the last few finished ones (the bridge keeps them
  // after the game moves on). Rebuilt only when the data changes - it
  // arrives once a second - and every game-sourced string is escaped.
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const badge = (code) => (COMPOUND[code] ? `<span class="compound" data-c="${COMPOUND[code]}">${COMPOUND[code]}</span>` : '');
  const sec = (ms) => (isNum(ms) && ms > 0 ? (ms / 1000).toFixed(3) : '–');
  const plus = (ms) => (isNum(ms) ? `${ms >= 0 ? '+' : '−'}${(Math.abs(ms) / 1000).toFixed(3)}` : '–');

  function lapChart(laps, bestMs) {
    if (!laps.length || !bestMs) return '';
    const top = bestMs * 1.07; // slower than 7% off best is off the chart (pit / SC laps)
    const floor = bestMs * 0.985;
    const w = 100 / laps.length;
    const bars = laps.map((l, i) => {
      const capped = l.timeMs > top;
      const h = Math.max(4, Math.min(100, ((Math.min(l.timeMs, top) - floor) / (top - floor)) * 100));
      const cls = l.timeMs === bestMs ? 'is-best' : l.pit ? 'is-pit' : l.neutralised ? 'is-sc' : l.invalid ? 'is-invalid' : '';
      return `<g class="${cls}"><title>Lap ${l.lap}: ${fmtLap(l.timeMs)}${l.pit ? ' (pit)' : l.neutralised ? ' (SC/VSC)' : l.invalid ? ' (invalid)' : ''}</title>`
        + `<rect x="${i * w + w * 0.15}" y="${100 - h}" width="${w * 0.7}" height="${h}" rx="0.6"></rect>${capped ? `<rect class="cap" x="${i * w + w * 0.15}" y="0" width="${w * 0.7}" height="2"></rect>` : ''}</g>`;
    }).join('');
    return `<svg class="w-deb__svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Lap times">${bars}</svg>`
      + `<div class="w-deb__axis">${laps.map((l) => `<span>${l.lap}</span>`).join('')}</div>`;
  }

  // Your best sectors against the fastest anyone set (every car's Session History).
  function sectorTile(d) {
    const fb = d.fieldBestSectors || [];
    if (!fb.some(Boolean)) return '';
    const mine = d.bestSectors || [];
    const rows = [0, 1, 2].map((i) => {
      const f = fb[i];
      if (!f) return `<span>S${i + 1} –</span>`;
      // Within rounding of the fastest (sector times come from two packets), or set by you: fastest.
      const gap = f.name === 'You' ? 0 : isNum(mine[i]) ? (mine[i] - f.ms <= 2 ? 0 : mine[i] - f.ms) : null;
      return `<span>S${i + 1} <b class="${gap != null && gap <= 0 ? 'pb' : ''}">${gap == null ? '–' : gap <= 0 ? 'fastest' : plus(gap)}</b>${gap > 0 ? ` <i class="dim">${esc(f.name)}</i>` : ''}</span>`;
    }).join('');
    return `<div class="w-deb__tile w-deb__tile--sectors"><span class="w-label">Sectors vs fastest</span><div class="w-deb__sec">${rows}</div></div>`;
  }

  // Position at the start of every lap, every car (Lap Positions packet).
  function positionChart(pc) {
    if (!pc || !pc.cars.length) return '';
    const laps = pc.cars[0].positions.length;
    const W = 1000;
    const H = 100;
    const x = (k) => (laps > 1 ? (k / (laps - 1)) * W : 0);
    const y = (p) => ((p - 1) / Math.max(1, pc.maxPos - 1)) * H;
    const line = (c) => {
      const pts = c.positions.map((p, k) => (p ? `${x(k).toFixed(1)},${y(p).toFixed(1)}` : null)).filter(Boolean).join(' ');
      return `<polyline class="${c.isPlayer ? 'me' : 'them'}" points="${pts}" vector-effect="non-scaling-stroke"><title>${esc(c.name)}</title></polyline>`;
    };
    // The player's line last, so it's drawn on top.
    const lines = [...pc.cars.filter((c) => !c.isPlayer), ...pc.cars.filter((c) => c.isPlayer)].map(line).join('');
    return `<div class="w-deb__chart"><div class="w-label">Positions, lap by lap <span class="dim">you in green · P1 at the top</span></div><svg class="w-deb__pos" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Position chart">${lines}</svg></div>`;
  }

  function debriefHtml(d) {
    const tile = (label, value, sub = '', tone = '') => `<div class="w-deb__tile"><span class="w-label">${label}</span><b class="${tone}">${value}</b><span class="dim">${sub}</span></div>`;
    const gained = d.positionsGained;
    const result = d.isRace
      ? tile(d.official ? 'Result · official' : 'Result', d.finish ? `P${d.finish}` : '–', `${d.grid ? `from P${d.grid}${gained ? ` · ${gained > 0 ? '+' : '−'}${Math.abs(gained)}` : ''}` : ''}${d.points ? ` · ${d.points} pts` : ''}`, gained > 0 ? 'is-good' : gained < 0 ? 'is-act' : '')
      : tile('Position', d.finish ? `P${d.finish}` : '–');
    const best = d.bestLap ? tile('Best lap', fmtLap(d.bestLap.ms), `lap ${d.bestLap.lap}${d.fieldBestMs ? ` · ${plus(d.bestLap.ms - d.fieldBestMs)} to fastest` : ''}`, 'pb') : tile('Best lap', '–', 'no clean lap');
    const tiles = [
      result,
      best,
      tile('Theoretical best', d.theoreticalBestMs ? fmtLap(d.theoreticalBestMs) : '–', d.theoreticalBestMs && d.bestLap ? `${plus(d.theoreticalBestMs - d.bestLap.ms)} left on the table` : 'best sectors combined'),
      tile('Race pace', d.medianPaceMs ? fmtLap(d.medianPaceMs) : '–', `median of ${d.cleanLaps} clean lap${d.cleanLaps === 1 ? '' : 's'}`),
      tile('Consistency', d.consistencyMs != null ? `±${(d.consistencyMs / 1000).toFixed(2)}s` : '–', 'spread of clean laps', d.consistencyMs != null ? (d.consistencyMs < 400 ? 'is-good' : d.consistencyMs > 1000 ? 'is-watch' : '') : ''),
      tile('Stops', d.pitStops != null ? d.pitStops : '–', d.stints.map((s) => `${COMPOUND_NAME[s.compound] || '?'} ${s.laps} lap${s.laps === 1 ? '' : 's'}`).join(' → ')),
      tile('Penalties', d.penalties.length, d.penalties.map((p) => esc(p.what)).join(', ') || 'clean', d.penalties.length ? 'is-watch' : 'is-good'),
      tile('Fastest lap', d.fastestLap && d.fastestLap.ms ? fmtLap(d.fastestLap.ms) : '–', d.fastestLap ? esc(d.fastestLap.name) : ''),
      sectorTile(d),
    ].join('');

    const bestS = d.bestSectors || [];
    const lapRows = d.laps.map((l) => {
      const flags = [l.pit ? 'PIT' : '', l.neutralised ? 'SC' : '', l.invalid ? 'INV' : ''].filter(Boolean).map((f) => `<span class="w-deb__flag">${f}</span>`).join('');
      const s = (k, i) => `<td class="num ${l[k] && l[k] === bestS[i] ? 'pb' : ''}">${sec(l[k])}</td>`;
      return `<tr class="${l.timeMs === (d.bestLap && d.bestLap.ms) ? 'is-best' : ''}"><td>${l.lap}</td><td class="num strong">${fmtLap(l.timeMs)}${flags}</td>`
        + `<td class="num dim">${d.bestLap ? plus(l.timeMs - d.bestLap.ms) : ''}</td>${s('s1', 0)}${s('s2', 1)}${s('s3', 2)}`
        + `<td class="num">P${esc(l.position)}</td><td class="tyre">${badge(l.compound)} ${esc(l.tyreAge)}</td><td class="num">${l.wearAvg != null ? `${Math.round(l.wearAvg)}%` : '–'}</td>`
        + `<td class="num">${l.fuelKg != null ? l.fuelKg.toFixed(1) : '–'}</td><td class="num">${l.batteryPct != null ? `${l.batteryPct}%` : '–'}</td></tr>`;
    }).join('');
    const fieldRows = d.field.map((f) => `<tr class="${f.isPlayer ? 'is-player' : ''}"><td class="pos">P${f.position}</td><td class="name">${esc(f.name)}</td>`
      + `<td class="num ${f.bestMs && f.bestMs === d.fieldBestMs ? 'pb' : ''}">${fmtLap(f.bestMs)}</td><td class="tyre">${f.compounds.map(badge).join('')}</td><td class="num dim">${f.stops}</td></tr>`).join('');

    return `
      <div class="w-deb__head"><h2>${esc(d.sessionName)}${d.track ? ` · ${esc(d.track)}` : ''}</h2><span class="dim">${d.laps.length} lap${d.laps.length === 1 ? '' : 's'} recorded${d.live ? ' · in progress' : ' · finished'}</span></div>
      <div class="w-deb__tiles">${tiles}</div>
      <div class="w-deb__chart"><div class="w-label">Lap times <span class="w-deb__legend"><i class="pb"></i>best <i class="lg-pit"></i>pit <i class="lg-sc"></i>SC/VSC <i class="lg-inv"></i>invalid</span></div>${lapChart(d.laps, d.bestLap && d.bestLap.ms)}</div>
      ${positionChart(d.positionChart)}
      <div class="w-deb__cols">
        <div class="w-deb__laps"><div class="w-label">Laps</div><table class="tbl"><thead><tr><th>Lap</th><th class="num">Time</th><th class="num">Δ best</th><th class="num">S1</th><th class="num">S2</th><th class="num">S3</th><th class="num">Pos</th><th>Tyre</th><th class="num">Wear</th><th class="num">Fuel</th><th class="num">ERS</th></tr></thead><tbody>${lapRows}</tbody></table></div>
        <div class="w-deb__field"><div class="w-label">Field</div><table class="tbl"><thead><tr><th></th><th>Driver</th><th class="num">Best</th><th>Tyres</th><th class="num">Stops</th></tr></thead><tbody>${fieldRows}</tbody></table></div>
      </div>`;
  }

  // ---------- Debrief charts (plain SVG, no library) ----------
  // A line chart over lap distance. Points are thinned to <= 600 so a
  // 1,200-point trace stays light; strokes don't scale with the stretch.
  function lineChart(series, { yMin, yMax, height = 110, zero = false, markers = [], endD }) {
    const W = 1000;
    const H = 100;
    const span = yMax - yMin || 1;
    const lines = series.map(({ d, values, cls }) => {
      const step = Math.max(1, Math.ceil(values.length / 600));
      const pts = [];
      for (let i = 0; i < values.length; i += step) pts.push(`${((d[i] / endD) * W).toFixed(1)},${(H - ((values[i] - yMin) / span) * H).toFixed(1)}`);
      return `<polyline class="${cls}" points="${pts.join(' ')}" vector-effect="non-scaling-stroke"/>`;
    }).join('');
    const z = zero && yMin < 0 && yMax > 0 ? `<line class="zero" x1="0" x2="${W}" y1="${H - ((0 - yMin) / span) * H}" y2="${H - ((0 - yMin) / span) * H}" vector-effect="non-scaling-stroke"/>` : '';
    const m = markers.map((x) => `<line class="mark" x1="${(x / endD) * W}" x2="${(x / endD) * W}" y1="0" y2="${H}" vector-effect="non-scaling-stroke"/>`).join('');
    return `<svg class="w-cmp__svg" style="height:${height}px" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${m}${z}${lines}</svg>`;
  }
  const cornerAxis = (corners, endD) => `<div class="w-cmp__axis">${corners.map((c) => `<span style="left:${(c.atM / endD) * 100}%">C${c.corner}</span>`).join('')}</div>`;
  const deltaCell = (v) => `<span class="w-cmp__ms ${v > 0.02 ? 'is-loss' : v < -0.02 ? 'is-gain' : ''}" title="${v > 0 ? '+' : ''}${v.toFixed(3)}s"></span>`;
  const signedS = (v, dp = 2) => (isNum(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(dp)}s` : '–');
  const m2 = (v, unit) => (isNum(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)} ${unit}` : '–');

  function compareHtml(c) {
    if (c.error) return `<div class="w-deb__empty dim">${esc(c.error)}</div>`;
    const t = c.trace;
    const endD = t.d[t.d.length - 1];
    const dMin = Math.min(...t.delta);
    const dMax = Math.max(...t.delta);
    const pad = Math.max(0.1, (dMax - dMin) * 0.1);
    const opts = (sel) => c.laps.map((l) => `<option value="${l.lap}"${l.lap === sel ? ' selected' : ''}>Lap ${l.lap} · ${fmtLap(l.timeMs)}</option>`).join('');
    // The vs list also offers the fastest rivals' best laps.
    const rivalOpts = (c.rivals || []).length
      ? `<optgroup label="Best laps in the field">${c.rivals.map((r) => `<option value="${r.id}"${r.id === c.lapA.id ? ' selected' : ''}>${esc(r.name)} · ${fmtLap(r.timeMs)}</option>`).join('')}</optgroup>`
      : '';
    // Against a rival their lap is the reference (A) and yours is B; the pickers stay "your lap" / "vs".
    const vsRival = !!c.lapA.rival;
    const mine = vsRival ? c.lapB : c.lapA;
    const nameA = vsRival ? esc(c.lapA.rival) : `lap ${c.lapA.lapNum}`;
    const nameB = `lap ${c.lapB.lapNum}`;
    const spread = new Map((c.consistency || []).map((x) => [x.corner, x]));
    const rows = c.corners.map((k) => {
      const sp = spread.get(k.corner);
      return `<tr><td class="strong">C${k.corner}</td><td class="num dim">${(k.atM / 1000).toFixed(2)} km</td>`
        + `<td class="num strong ${k.timeS > 0.03 ? 'is-act' : k.timeS < -0.03 ? 'is-good' : ''}">${signedS(k.timeS)}</td>`
        + `<td class="num">${m2(k.brakePointM, 'm')}</td><td class="num">${m2(k.apexKmh, 'km/h')}</td><td class="num">${m2(k.exitKmh, 'km/h')}</td>`
        + `<td class="num dim">${sp && sp.brakePointSdM != null ? `±${sp.brakePointSdM} m` : '–'}</td></tr>`;
    }).join('');
    return `
      <div class="w-cmp__bar">
        <label>${vsRival ? 'Your lap' : 'Reference'} <select data-pick="a">${opts(mine.lapNum)}</select></label>
        <label>vs <select data-pick="b">${opts(vsRival ? null : c.lapB.lapNum)}${rivalOpts}</select></label>
        <b class="w-cmp__total ${c.totalS > 0 ? 'is-act' : 'is-good'}">${signedS(c.totalS, 3)}</b>
      </div>
      <ul class="w-cmp__headline">${c.headline.length ? c.headline.map((h) => `<li>${esc(h)}</li>`).join('') : '<li class="dim">Nothing stands out - the two laps are close everywhere.</li>'}</ul>
      <div class="w-cmp__chart"><div class="w-label">Time gap (${nameB} vs ${nameA}) <span class="dim">up = losing</span></div>
        ${lineChart([{ d: t.d, values: t.delta, cls: 'delta' }], { yMin: dMin - pad, yMax: dMax + pad, zero: true, markers: c.corners.map((k) => k.atM), endD, height: 90 })}</div>
      <div class="w-cmp__chart"><div class="w-label">Speed <span class="w-cmp__key"><i class="a"></i>${nameA} <i class="b"></i>${nameB}</span></div>
        ${lineChart([{ d: t.d, values: t.a.speed, cls: 'a' }, { d: t.d, values: t.b.speed, cls: 'b' }], { yMin: 0, yMax: 350, markers: c.corners.map((k) => k.atM), endD, height: 130 })}</div>
      <div class="w-cmp__chart"><div class="w-label">Throttle</div>
        ${lineChart([{ d: t.d, values: t.a.throttle, cls: 'a thr' }, { d: t.d, values: t.b.throttle, cls: 'b thr' }], { yMin: 0, yMax: 1.05, endD, height: 54 })}</div>
      <div class="w-cmp__chart"><div class="w-label">Brake</div>
        ${lineChart([{ d: t.d, values: t.a.brake, cls: 'a brk' }, { d: t.d, values: t.b.brake, cls: 'b brk' }], { yMin: 0, yMax: 1.05, markers: c.corners.map((k) => k.atM), endD, height: 54 })}
        ${cornerAxis(c.corners, endD)}</div>
      <div class="w-cmp__chart"><div class="w-label">Mini-sectors <span class="dim">red = time lost, green = gained</span></div><div class="w-cmp__strip">${c.miniSectors.map((m) => deltaCell(m.deltaS)).join('')}</div></div>
      <div class="w-label">Corner by corner <span class="dim">(brake point + = later, spread = how much it varies lap to lap)</span></div>
      <table class="tbl w-cmp__table"><thead><tr><th>Corner</th><th class="num">At</th><th class="num">Time</th><th class="num">Brake point</th><th class="num">Apex</th><th class="num">Exit</th><th class="num">Spread</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function rivalsHtml(r) {
    if (r.error) return `<div class="w-deb__empty dim">${esc(r.error)}</div>`;
    const tile = (label, value, sub = '', tone = '') => `<div class="w-deb__tile"><span class="w-label">${label}</span><b class="${tone}">${value}</b><span class="dim">${sub}</span></div>`;
    const vals = r.sectors.map((s) => (s.vsRivalS != null ? s.vsRivalS : s.vsFieldBestS));
    const max = Math.max(0.1, ...vals.map(Math.abs));
    const bars = vals.map((v, i) => {
      const h = (Math.abs(v) / max) * 50;
      return `<rect class="${v > 0 ? 'loss' : 'gain'}" x="${i * 40 + 6}" y="${v > 0 ? 50 - h : 50}" width="28" height="${Math.max(0.5, h)}"><title>Mini-sector ${i + 1}: ${v > 0 ? '+' : ''}${v.toFixed(3)}s</title></rect>`;
    }).join('');
    return `
      <div class="w-deb__tiles">
        ${tile('Benchmark', r.rival ? esc(r.rival.name) : '–', r.rival ? `best ${fmtLap(r.rival.bestLapMs)}` : '')}
        ${tile('Your best', fmtLap(r.yourBestLapMs), r.gapToRivalS != null ? `${signedS(r.gapToRivalS, 3)} to ${r.rival ? esc(r.rival.name) : 'them'}` : '', r.gapToRivalS > 0 ? 'is-act' : 'is-good')}
        ${tile('Your ideal lap', fmtLap(r.yourIdealLapMs), 'your best mini-sectors combined', 'pb')}
        ${tile('Field ideal', fmtLap(r.fieldIdealLapMs), 'best of every car, every slice')}
      </div>
      <div class="w-cmp__chart"><div class="w-label">Your best vs ${r.rival ? esc(r.rival.name) : 'the field best'}, by mini-sector <span class="dim">up = you lose time</span></div>
        <svg class="w-riv__svg" viewBox="0 0 ${vals.length * 40} 100" preserveAspectRatio="none"><line class="zero" x1="0" x2="${vals.length * 40}" y1="50" y2="50" vector-effect="non-scaling-stroke"/>${bars}</svg>
        <div class="w-riv__axis"><span>Start</span><span>Lap distance →</span><span>Finish</span></div></div>
      <div class="w-label">Where the time goes</div>
      <ul class="w-cmp__headline">${r.biggestLosses.length ? r.biggestLosses.map((l) => `<li>${esc(l.text)}</li>`).join('') : '<li class="dim">You match them everywhere.</li>'}</ul>
      <div class="w-foot">Every car is timed through ${r.miniSectors} equal slices of the lap from the game's lap data. For brake points against a rival, pick their best lap in Lap compare.</div>`;
  }

  const FEATURE_LABEL = {
    logGap: 'Gap to the car ahead (log)', within05: 'Within half a second', paceDeltaS: 'Clean-lap pace advantage', tyreAgeDelta: 'Fresher tyres',
    softerTyre: 'Softer compound', ersDelta: 'More battery', overtakeMode: 'Overtake mode available', closingSPerS: 'Closing right now', lapOne: 'Lap one',
  };
  // Does the model beat the obvious guess? Said plainly, from the held-out scores.
  function verdictHtml(ev) {
    const gain = ev.model.brierSkill - ev.gapOnlyBaseline.brierSkill;
    const text = gain > 0.01
      ? 'Beats the gap-only baseline on held-out races - the extra features add real signal.'
      : 'Doesn\'t beat a gap-only model yet: on the races recorded so far, the gap carries nearly all the signal. The other features are kept because 2026 Overtake mode and battery should matter more with more races - this updates itself on every retrain.';
    return `<p class="w-mdl__verdict ${gain > 0.01 ? 'is-good' : 'is-watch'}">${text}</p>`;
  }

  // When it says 20%, does a pass follow about 20% of the time? Bars = observed, ticks = predicted.
  function calibrationHtml(cal) {
    const rows = (cal || []).filter((c) => c.n >= 20);
    if (!rows.length) return '';
    const max = Math.max(...rows.map((c) => Math.max(c.predicted, c.observed)), 0.05);
    const bars = rows.map((c) => `<div class="w-mdl__cal"><span class="dim">${c.bucket}</span><span class="w-mdl__calbar"><i style="width:${(c.observed / max) * 100}%"></i><b style="left:${(c.predicted / max) * 100}%"></b></span><span>${Math.round(c.observed * 100)}% <i class="dim">vs ${Math.round(c.predicted * 100)}%</i></span><span class="dim">${c.n.toLocaleString()}</span></div>`).join('');
    return `<div class="w-label">Calibration, held out <span class="dim">bar = how often a pass followed · tick = what the model said · samples</span></div><div class="w-mdl__cals">${bars}</div>`;
  }

  function modelsHtml(m) {
    const o = m.overtake;
    const tyre = m.tyre;
    let html = '';
    if (o) {
      const ev = o.evaluation;
      const maxW = Math.max(...o.weights.map((w) => Math.abs(w.weight)), 0.01);
      // Features that never varied in the training races carry no weight - hide them.
      const weights = [...o.weights].filter((w) => Math.abs(w.weight) >= 0.005).sort((x, y) => Math.abs(y.weight) - Math.abs(x.weight)).map((w) => `<div class="w-mdl__w"><span>${FEATURE_LABEL[w.feature] || esc(w.feature)}</span>`
        + `<span class="w-mdl__bar"><i class="${w.weight >= 0 ? 'pos' : 'neg'}" style="width:${(Math.abs(w.weight) / maxW) * 100}%"></i></span><b>${w.weight >= 0 ? '+' : '−'}${Math.abs(w.weight).toFixed(2)}</b></div>`).join('');
      html += `<div class="w-mdl__card"><h3>Overtake probability</h3><p class="dim">${esc(o.question)} Logistic regression, trained on ${o.trainedOn.races} recorded races: ${o.trainedOn.samples.toLocaleString()} one-second battle samples, ${o.trainedOn.passes.toLocaleString()} followed by a pass. Drives the pass / threat chips and "pass likely" calls.</p>`
        + (ev ? `<div class="w-deb__tiles"><div class="w-deb__tile"><span class="w-label">Held-out AUC</span><b>${ev.model.auc.toFixed(3)}</b><span class="dim">gap-only baseline ${ev.gapOnlyBaseline.auc.toFixed(3)}</span></div><div class="w-deb__tile"><span class="w-label">Brier skill</span><b>${ev.model.brierSkill.toFixed(3)}</b><span class="dim">baseline ${ev.gapOnlyBaseline.brierSkill.toFixed(3)}</span></div><div class="w-deb__tile"><span class="w-label">Evaluation</span><b>Leave one race out</b><span class="dim">each race scored by a model that never saw it</span></div></div>` : '')
        + (ev ? verdictHtml(ev) + calibrationHtml(ev.model.calibration) : '')
        + `<div class="w-label">What drives a pass <span class="w-cmp__key"><i class="pos"></i>more likely <i class="neg"></i>less likely</span></div><div class="w-mdl__weights">${weights}</div></div>`;
    } else {
      html += '<div class="w-mdl__card"><h3>Overtake probability</h3><p class="dim">No model yet - record races with npm run capture, then npm run train:overtake.</p></div>';
    }
    const rows = tyre ? Object.entries(tyre.compounds) : [];
    html += `<div class="w-mdl__card"><h3>Tyre degradation (live)</h3><p class="dim">Fitted during the session from every car's clean laps: each car against its own average, fuel-corrected (${tyre ? `${tyre.fuelMsPerLap} ms/lap` : '~30 ms per kg'}), outlier laps trimmed. Feeds the cliff projection and stop pay-back.</p>`
      + (rows.length ? `<table class="tbl"><thead><tr><th>Compound</th><th class="num">Loss per lap of age</th><th class="num">Laps</th><th class="num">Cars</th></tr></thead><tbody>${rows.map(([c, d]) => `<tr><td>${COMPOUND_NAME[c] || c}</td><td class="num strong">${degText(d)}</td><td class="num">${d.laps}</td><td class="num">${d.cars}</td></tr>`).join('')}</tbody></table>` : '<p class="dim">Waiting for enough laps in this session.</p>')
      + '</div>';
    return html;
  }

  W.debrief = {
    title: 'Debrief',
    description: 'After the session: recap, lap-vs-lap telemetry, where you lose time to rivals, and the models',
    tall: true,
    mount(el) {
      el.innerHTML = `<div class="w-deb">
        <div class="w-deb__nav"><div class="w-deb__views"></div><select class="w-deb__session" aria-label="Session"></select></div>
        <div class="w-deb__body"><div class="w-deb__empty dim">No completed laps yet - the debrief fills in lap by lap, and stays here after the session ends.</div></div></div>`;
      const viewsEl = el.querySelector('.w-deb__views');
      const sessionEl = el.querySelector('.w-deb__session');
      const body = el.querySelector('.w-deb__body');
      const VIEWS = [['summary', 'Summary'], ['compare', 'Lap compare'], ['rivals', 'Rivals'], ['models', 'Models']];
      let view = 'summary';
      let selected = null;
      let pick = { a: null, b: null };
      let sig = '';
      let lastData = null;
      let fetchKey = '';

      viewsEl.replaceChildren(...VIEWS.map(([id, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'w-deb__tab';
        b.dataset.view = id;
        b.textContent = label;
        b.addEventListener('click', () => {
          view = id;
          sig = '';
          draw();
        });
        return b;
      }));
      sessionEl.addEventListener('change', () => {
        selected = sessionEl.value;
        pick = { a: null, b: null };
        sig = '';
        draw();
      });
      body.addEventListener('change', (e) => {
        const which = e.target.dataset && e.target.dataset.pick;
        if (!which) return;
        // A lap number, or a rival's best lap ('r<carIndex>').
        pick[which] = /^r\d+$/.test(e.target.value) ? e.target.value : Number(e.target.value);
        sig = '';
        draw();
      });

      async function load(url, key, render) {
        fetchKey = key;
        body.innerHTML = '<div class="w-deb__empty dim">Loading…</div>';
        try {
          const res = await fetch(url);
          const data = await res.json();
          if (fetchKey === key) body.innerHTML = render(data);
        } catch (_) {
          if (fetchKey === key) body.innerHTML = '<div class="w-deb__empty dim">Couldn\'t reach the bridge.</div>';
        }
      }

      function draw() {
        for (const b of viewsEl.children) b.classList.toggle('is-active', b.dataset.view === view);
        const sessions = (lastData && lastData.sessions) || [];
        const d = sessions.find((x) => x.id === selected) || sessions[0];
        const opts = sessions.map((x) => `${x.id}|${x.live ? 'Now: ' : ''}${x.sessionName}${x.track ? ` · ${x.track}` : ''}`).join('\n');
        if (sessionEl.dataset.sig !== opts) {
          sessionEl.dataset.sig = opts;
          sessionEl.replaceChildren(...sessions.map((x) => {
            const o = document.createElement('option');
            o.value = x.id;
            o.textContent = `${x.live ? 'Now: ' : ''}${x.sessionName}${x.track ? ` · ${x.track}` : ''}`;
            return o;
          }));
        }
        if (d) sessionEl.value = d.id;
        sessionEl.hidden = sessions.length < 2 || view === 'models';
        if (view === 'models') return load('/api/models', `models|${d ? d.laps.length : 0}`, modelsHtml);
        if (!d) {
          body.innerHTML = '<div class="w-deb__empty dim">No completed laps yet - the debrief fills in lap by lap, and stays here after the session ends.</div>';
          return;
        }
        if (view === 'summary') {
          fetchKey = '';
          body.innerHTML = debriefHtml(d);
        } else if (view === 'compare') {
          const q = `session=${encodeURIComponent(d.id)}${pick.a ? `&a=${pick.a}` : ''}${pick.b ? `&b=${pick.b}` : ''}`;
          load(`/api/debrief/compare?${q}`, `cmp|${q}|${d.comparable.length}`, compareHtml);
        } else if (view === 'rivals') {
          load(`/api/debrief/rivals?session=${encodeURIComponent(d.id)}`, `riv|${d.id}|${d.laps.length}`, rivalsHtml);
        }
      }

      return (s) => {
        if (!s.debrief) return;
        lastData = s.debrief;
        // Redraw on new laps only - a fetched comparison isn't re-requested 10x a second.
        const next = JSON.stringify(s.debrief.sessions.map((x) => [x.id, x.laps.length, x.finish, x.field.length, x.penalties.length])) + selected + view;
        if (next === sig) return;
        sig = next;
        draw();
      };
    },
  };

  // ---------- Adjust: live bias / diff / ERS suggestions ----------
  // Current settings across the top, then what to change, where, and why.
  // The server decides every suggestion; this only lays them out.
  const KIND_LABEL = { bias: 'Bias', diff: 'Diff', ers: 'ERS' };
  W.adjust = {
    title: 'Adjust',
    description: 'What to change now - brake bias, diff and ERS, by corner (current values are on the MFD)',
    tall: true,
    mount(el) {
      const r = template(el, `
        <div class="w-adj">
          <ul class="w-adj__list" data-ref="list"></ul>
          <div class="w-adj__empty" data-ref="empty">Nothing to change - the car looks balanced</div>
          <div class="w-foot">Corners are braking zones counted from the start line</div>
        </div>`);
      return (s) => {
        // Current bias / diff / ERS mode / battery are on the MFD and HUD;
        // this card is only the changes to make (each says from -> to).
        const a = s.adjust;

        const list = a ? a.suggestions : [];
        r.empty.hidden = !a || list.length > 0;
        const sig = list.map((x) => `${x.id}|${x.action}|${x.where}|${x.why}`).join('\n');
        if (r.list.dataset.sig === sig) return;
        r.list.dataset.sig = sig;
        r.list.replaceChildren(...list.slice(0, 4).map((x) => {
          const li = document.createElement('li');
          li.className = 'w-adj__row';
          li.dataset.kind = x.kind;
          const tag = document.createElement('span');
          tag.className = 'w-adj__kind';
          tag.textContent = KIND_LABEL[x.kind] || x.kind;
          const action = document.createElement('b');
          action.className = 'w-adj__action';
          action.textContent = x.action;
          const detail = document.createElement('span');
          detail.className = 'w-adj__detail';
          const where = document.createElement('span');
          where.className = 'w-adj__where';
          where.textContent = x.where;
          const why = document.createElement('span');
          why.className = 'w-adj__why';
          why.textContent = x.why;
          detail.append(where, why);
          li.append(tag, action, detail);
          return li;
        }));
      };
    },
  };

  // ---------- Weather ----------
  // The MFD lists forecast slots in minutes. This answers in laps: when does
  // the rain come, when does it stop, is the track drying - and once it's
  // mixed, which tyre is actually faster out there right now.
  const lapsTxt = (n) => {
    const l = Math.max(1, Math.round(n));
    return `~${l} lap${l === 1 ? '' : 's'}`;
  };
  function weatherHeadline(wx) {
    const nc = wx.nextChange;
    const coming = nc && !nc.afterFlag;
    switch (wx.trackState) {
      case 'raining':
        return coming ? [`Rain stops in ${lapsTxt(nc.inLaps)}`, 'is-info'] : ['Rain to the flag', 'is-info'];
      case 'drying':
        return ['Track drying', 'is-watch'];
      case 'rain-coming':
        return [`Rain in ${lapsTxt(nc.inLaps)}`, Math.round(nc.inLaps) <= 3 ? 'is-act' : 'is-watch'];
      default:
        return [nc && nc.to === 'rain' ? 'Dry to the flag' : wx.timeline.length ? 'Dry - no rain forecast' : 'Dry', 'is-good'];
    }
  }
  function crossoverText(wx) {
    const c = wx.crossover;
    if (c.wetGainMs != null) {
      const s = (Math.abs(c.wetGainMs) / 1000).toFixed(1);
      return c.wetGainMs > 0 ? [`Inters ${s}s/lap faster than slicks`, wx.playerOnSlicks ? 'is-act' : 'is-good'] : [`Slicks ${s}s/lap faster than inters`, wx.playerOnWets ? 'is-act' : 'is-good'];
    }
    if (c.wetCars && !c.slickCars) return [`Everyone on inters/wets (${c.wetCars})`, 'is-muted'];
    if (wx.trackState !== 'dry' && wx.trackState !== 'rain-coming') return ['Waiting for lap times on both tyres', 'is-muted'];
    return ['', ''];
  }

  W.weather = {
    title: 'Weather',
    description: 'When the rain comes and stops, in laps; track drying; inters vs slicks pace',
    mount(el) {
      const r = template(el, `
        <div class="w-wx">
          <div class="w-wx__head"><span class="mid" data-ref="head">–</span><span class="tag tag--muted" data-ref="acc" hidden>Approx</span></div>
          <div class="w-wx__strip" data-ref="strip"></div>
          <div class="w-wx__cross" data-ref="cross"></div>
        </div>`);
      return (s) => {
        const wx = s.analysis && s.analysis.weather;
        if (!wx) {
          setText(r.head, 'No weather data');
          setTone(r.head, 'is-muted');
          return;
        }
        const [head, tone] = weatherHeadline(wx);
        setText(r.head, head);
        setTone(r.head, tone);
        r.acc.hidden = wx.accuracy !== 'approximate';
        // Current conditions and temperatures are on the HUD/MFD - this card
        // is only the forecast, in laps, and the tyre crossover.
        const [cross, crossTone] = crossoverText(wx);
        setText(r.cross, cross);
        setTone(r.cross, crossTone);

        // One column per forecast slot: bar height = rain chance, colour = weather.
        const sig = wx.timeline.map((t) => `${t.offsetMin}:${t.weather}:${t.rainPct}:${t.afterFlag}:${Math.round(t.laps)}`).join('|');
        if (r.strip.dataset.sig === sig) return;
        r.strip.dataset.sig = sig;
        r.strip.replaceChildren(...wx.timeline.map((t) => {
          const col = document.createElement('div');
          col.className = `w-wx__slot${t.afterFlag ? ' is-after' : ''}`;
          col.dataset.w = t.weather;
          col.title = `${WEATHER[t.weather]} · ${t.rainPct}% rain${t.afterFlag ? ' · after the flag' : ''}`;
          const pct = document.createElement('span');
          pct.className = 'w-wx__pct';
          pct.textContent = `${t.rainPct}%`;
          const bar = document.createElement('div');
          bar.className = 'w-wx__bar';
          const fill = document.createElement('div');
          fill.style.height = `${Math.max(4, t.rainPct)}%`;
          bar.appendChild(fill);
          const when = document.createElement('span');
          when.className = 'w-wx__when';
          when.textContent = t.offsetMin === 0 ? 'Now' : t.afterFlag ? `+${t.offsetMin}m` :`L+${Math.max(1, Math.round(t.laps))}`;
          col.append(pct, bar, when);
          return col;
        }));
      };
    },
  };

  window.RaceWidgets = { widgets: W, setText, setTone, lapsTxt };
})();
