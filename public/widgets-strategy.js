// The Strategy and Weather screens' widgets: rejoin, pit timing, the tyre call, the adjustments and the forecast.
// Registers into window.RaceWidgets.widgets (widgets.js, which loads first, has the shared helpers).
(function () {
  'use strict';
  const { widgets: W, setText, setTone, setCompound, compoundBadge, template, secs, isNum, esc, badge, degText, lapsTxt, COMPOUND_NAME, WEATHER } = window.RaceWidgets;

  // The places a stop that ran short or long would give (analysis rejoin.range: 80%, from the scatter of the
  // measured stops): one pip per place, the predicted one filled. Hidden when there is only one.
  function rangePips(el, rj) {
    const rg = rj && rj.range;
    const places = rg && rg.worst > rg.best ? Array.from({ length: Math.min(8, rg.worst - rg.best + 1) }, (_, k) => rg.best + k) : [];
    el.hidden = !places.length;
    const sig = places.length ? `${rj.position}:${places.join()}` : '';
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.title = 'Where a stop that runs shorter or longer than usual would put you (80% of stops)';
    const span = (cls, text) => {
      const n = document.createElement('span');
      n.className = cls;
      n.textContent = text;
      return n;
    };
    el.replaceChildren(...(places.length ? [span('w-rejoin__range-label', 'If the stop varies')] : []), ...places.map((p) => span(`w-rejoin__pip${p === rj.position ? ' is-mid' : ''}`, `P${p}`)));
  }

  // ---------- Pit rejoin ----------
  W.rejoin = {
    title: 'If you box now',
    description: 'Where you would rejoin, who is around you, measured pit loss',
    mount(el) {
      const r = template(el, `
        <div class="w-rejoin">
          <div class="w-rejoin__head"><span class="big" data-ref="pos">–</span><span class="w-rejoin__lost" data-ref="lost"></span><span class="tag tag--watch" data-ref="traffic" hidden>Traffic</span></div>
          <div class="w-rejoin__range" data-ref="range" hidden></div>
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
        rangePips(r.range, rj && !inPit ? rj : null);
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
        <td class="num">P${o.rejoinPosition}${o.inTraffic ? ' <span class="pit-tag">Traffic</span>' : ''}</td>
        <td class="num strong">P${o.finishPosition}</td>
        <td class="num ${o.best ? 'is-good' : 'dim'}">${o.best ? 'Best' : `+${o.lossS.toFixed(1)}s`}</td></tr>`).join('');
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
        let text = st && st.tyresReachFlag ? 'Lasts to the flag' : 'Measuring wear';
        let tone = st && st.tyresReachFlag ? 'is-good' : 'is-muted';
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
})();
