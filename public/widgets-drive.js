// The Drive and Battle screens' widgets: the driving card, the battle card, the lap-time card and the pit options.
// Registers into window.RaceWidgets.widgets (widgets.js, which loads first, has the shared helpers).
(function () {
  'use strict';
  const { widgets: W, units, setText, setTone, setCompound, template, neighbours, trendText, tyreCompare, secs, fmtLap, isNum, esc, badge, YELLOW } = window.RaceWidgets;

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
      // With the range the model's noisy inputs allow (analysis/passRange): "28% (18-41%)".
      const r = ml.range;
      const pct = r && r.lo !== r.hi ? `${Math.round(ml.p * 100)}% (${Math.round(r.lo * 100)}-${Math.round(r.hi * 100)}%)` : `${Math.round(ml.p * 100)}%`;
      out.chip = `${which === 'ahead' ? 'Pass' : 'Threat'} ${LEVEL[ml.level]} · ${pct}`;
      out.chipTone = ml.level === 'high' ? (which === 'ahead' ? 'is-good' : 'is-act') : ml.level === 'medium' ? 'is-watch' : 'is-muted';
    }
    // Whoever attacks decides which rule set matters: you when the car is ahead, the rival when it is behind (an online
    // lobby can mix the 2025 cars, with DRS, and the 2026 cars, with Overtake mode). Not mixed, or unknown: your own rules.
    const attacker2026 = which === 'behind' && s.rules && s.rules.mixed && car.regs2026 != null ? car.regs2026 : a.regs2026;
    if (attacker2026) {
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
      out.speed = `Top speed ${units.speed(car.topSpeedKmh)} · you ${units.speed(me.topSpeedKmh).replace(/ (km\/h|mph)$/, '')}`;
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

  function fillSide(r, k, v, car, s) {
    // In an online mix of the 2025 and 2026 cars the name carries which rules that car is on.
    const era = car && s && s.rules && s.rules.mixed && car.regs2026 != null ? ` '${car.regs2026 ? 26 : 25}` : '';
    setText(r[`${k}Name`], (v.pos ? `${v.pos} ${v.name}` : v.name) + era);
    setText(r[`${k}Gap`], v.gap);
    setTone(r[`${k}Gap`], v.gapTone);
    // No gap (no car there): a small grey dash, not the big digits' size, where a dash reads as a white bar.
    r[`${k}Gap`].classList.toggle('is-empty', !v.gap || v.gap === '–');
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
      <div class="w-label" data-ref="${k}Label">${label}</div>
      <div class="w-battle__name" data-ref="${k}Name">–</div>
      <div class="big w-battle__gap is-empty" data-ref="${k}Gap">–</div>
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
        // Practice / qualifying: this lap and where you stand, as on Drive - not a car "0.0s behind" in the garage.
        const q = s.analysis && s.analysis.quali;
        setText(r.aLabel, q ? 'This lap' : 'Ahead');
        setText(r.bLabel, q ? 'Standing' : 'Behind');
        if (q) {
          r.modeBox.hidden = true;
          const sides = qualiSides(s, q);
          fillSide(r, 'a', sides.lap, null);
          fillSide(r, 'b', sides.stand, null);
          return;
        }
        fillMode(r, s);
        const { ahead, behind } = neighbours(s);
        fillSide(r, 'a', battleSide(s, ahead, 'ahead'), ahead, s);
        fillSide(r, 'b', battleSide(s, behind, 'behind'), behind, s);
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
    if (t) Object.assign(lap, { chip: q.traffic.ahead ? `Traffic ${t.gapS.toFixed(1)}s` : 'Let by', chipTone: 'is-watch', extra: t.name });
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
          <div class="w-drive__radio" data-ref="radioBox"><span class="w-drive__radio-tag">Radio</span><span data-ref="radio">No calls - drive</span></div>
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
        fillSide(r, 'a', battleSide(s, ahead, 'ahead'), ahead, s);
        fillSide(r, 'b', battleSide(s, behind, 'behind'), behind, s);

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
        let tyre = st && st.tyresReachFlag ? ['To the flag', 'no cliff before the end', 'is-good'] : ['Measuring', '', 'is-muted'];
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
        <div class="w-opt__title">${x.recommended ? '<span class="w-opt__pick">Best</span>' : ''}${esc(x.title)}</div>
        <div class="w-opt__pos">${x.position != null ? `P${x.position}` : '–'}<span>${x.positionsLost ? ` −${x.positionsLost}` : ''}</span></div>
        <div class="w-opt__line">${badge(x.compound)} ${esc(x.tyre)}</div>
        <div class="w-opt__line ${x.reachesFlag ? 'is-good' : 'is-watch'}">${x.reachesFlag ? 'Lasts to the flag' : `${x.lifeLaps} laps of life, ${o.lapsLeft} to go`}</div>
        ${Math.abs(x.paceDeltaS) >= 0.1 ? `<div class="w-opt__line">${Math.abs(x.paceDeltaS).toFixed(1)}s/lap ${x.paceDeltaS < 0 ? 'faster' : 'slower'} than now</div>` : ''}
      </div>`).join('');
    return `<div class="w-opt__head"><b>${esc(o.situation)}</b> · ${o.lapsLeft} laps left${o.freeStop ? ' · tyre change is free' : ''}</div><div class="w-opt__cards">${cards}</div>`;
  }

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
})();
