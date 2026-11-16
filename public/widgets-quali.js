// The Qualifying screens' widgets: Lap (the push lap, with where it would put you), Order (every car by best lap,
// with the knockout line) and Plan (the clock, runs left, who is on a push lap, the track). The dashboard swaps its
// race screens for these while the session is a qualifying or shootout session (public/app.js). They only format
// what `analysis.quali` carries (src/analysis/qualifying.js); nothing is decided here.
// Registers into window.RaceWidgets.widgets (widgets.js, which loads first, has the shared helpers).
(function () {
  'use strict';
  const { widgets: W, units, eraTag, setText, setTone, template, secs, fmtLap, isNum, compoundBadge } = window.RaceWidgets;

  const clockText = (s) => (isNum(s) ? `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, Math.round(s)) % 60).padStart(2, '0')}` : '–');
  const deltaText = (ms) => (isNum(ms) ? `${ms <= 0 ? '−' : '+'}${(Math.abs(ms) / 1000).toFixed(3)}` : '–');
  const STATE = { garage: 'In the garage', out: 'Out lap', in: 'In lap', track: 'On track', flying: 'Push lap' };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // What the hero number says: [value, sub line, tone].
  function hero(q, s) {
    if (q.status === 'flying') {
      if (q.lapInvalid) return ['Deleted', "track limits: it won't count", 'is-act'];
      if (q.lapGone) return ['Lap gone', 'too far down on your best: back off and reset', 'is-act'];
      if (q.projected) {
        const tone = q.projected.improves ? 'is-pb' : 'is-watch';
        return [deltaText(s.player.deltaToBestMs), `would be P${q.projected.position}${q.projected.improves ? ' · a new best' : ''}`, tone];
      }
      return ['First lap', 'sets your first time', 'is-good'];
    }
    if (q.toLine) {
      const t = q.toLine;
      return [clockText(t.startsInS), !t.makesIt ? 'the flag falls first: this lap will not count' : t.spareS != null ? `to the line · ${clockText(t.spareS)} to spare` : 'to the line', t.makesIt ? '' : 'is-act'];
    }
    if (q.status === 'garage') {
      return [clockText(q.timeLeftS), q.runs == null ? 'in the garage' : q.runs === 0 ? 'left · no time for another run' : `left · time for ${plural(q.runs, 'run')}`, ''];
    }
    return [STATE[q.status] || '–', isNum(q.bestMs) ? `best ${fmtLap(q.bestMs)}` : 'no time yet', 'is-muted'];
  }

  // ---------- Lap: the screen to leave up on a qualifying lap ----------
  W.qlap = {
    title: 'Qualifying lap',
    description: 'The lap you are on: the delta to your best and the place it would give, the time to the line, and the knockout line',
    tall: true,
    mount(el) {
      const r = template(el, `
        <div class="w-ql">
          <div class="w-ql__head"><b data-ref="session">–</b><span data-ref="clock"></span></div>
          <div class="w-ql__state" data-ref="state"></div>
          <div class="w-ql__hero" data-ref="hero">–</div>
          <div class="w-ql__sub" data-ref="sub"></div>
          <div class="w-ql__tiles">
            <div class="w-ql__tile"><span class="w-label">Best</span><b data-ref="best">–</b><span data-ref="bestSub"></span></div>
            <div class="w-ql__tile"><span class="w-label" data-ref="cutLabel">To P1</span><b data-ref="cut">–</b><span data-ref="cutSub"></span></div>
          </div>
          <div class="w-ql__chip" data-ref="chip" hidden></div>
        </div>`);
      return (s) => {
        const q = s.analysis && s.analysis.quali;
        if (!q) {
          setText(r.session, 'Not a qualifying session');
          for (const k of ['clock', 'state', 'sub', 'bestSub', 'cutSub']) setText(r[k], '');
          setText(r.hero, '–');
          setTone(r.hero, 'is-muted');
          setText(r.best, '–');
          setText(r.cut, '–');
          r.chip.hidden = true;
          return;
        }
        setText(r.session, q.name);
        setText(r.clock, q.timeLeftS == null ? '' : `${clockText(q.timeLeftS)} left`);
        setText(r.state, STATE[q.status] || '');
        const [value, sub, tone] = hero(q, s);
        setText(r.hero, value);
        setTone(r.hero, tone);
        setText(r.sub, sub);
        setText(r.best, isNum(q.bestMs) ? fmtLap(q.bestMs) : 'No time');
        setText(r.bestSub, q.position ? `P${q.position}` : 'set a lap');
        if (q.cut && q.cut.marginMs != null) {
          const through = q.cut.marginMs < 0;
          setText(r.cutLabel, `Cut · P${q.cut.position}`);
          setText(r.cut, `${secs(q.cut.marginMs, 3)} ${through ? 'clear' : 'short'}`);
          setTone(r.cut, through ? 'is-good' : 'is-act');
          setText(r.cutSub, through ? 'through' : 'out at the moment');
        } else if (q.cut) {
          setText(r.cutLabel, `Cut · P${q.cut.position}`);
          setText(r.cut, '–');
          setTone(r.cut, 'is-muted');
          setText(r.cutSub, 'not enough times yet');
        } else {
          setText(r.cutLabel, 'To P1');
          setText(r.cut, q.position === 1 ? 'You' : isNum(q.gapToPoleMs) ? `+${secs(q.gapToPoleMs, 3)}` : '–');
          setTone(r.cut, q.position === 1 ? 'is-pb' : '');
          setText(r.cutSub, isNum(q.poleMs) ? `P1 ${fmtLap(q.poleMs)}` : '');
        }
        const t = q.traffic && (q.traffic.ahead || q.traffic.behind);
        r.chip.hidden = !t;
        if (t) {
          setText(r.chip, q.traffic.ahead ? `Traffic: ${t.name} ${t.gapS.toFixed(1)} s ahead` : `${t.name} on a push lap behind: let them by`);
          setTone(r.chip, 'is-watch');
        }
      };
    },
  };

  // The name, with a '25 or '26 tag when the field mixes the rules.
  function nameWithEra(e, s) {
    const span = document.createElement('span');
    span.textContent = e.name;
    const era = eraTag(e, s);
    if (era) span.appendChild(era);
    return span;
  }

  // ---------- Order: every car by best lap ----------
  W.qorder = {
    title: 'Qualifying order',
    description: 'Every car by best lap, the gap to P1, who is on a push lap, and the cars below the knockout line',
    tall: true,
    mount(el) {
      el.innerHTML = '<div class="w-table"><table class="tbl tbl--board w-qo"><tbody></tbody></table></div>';
      const wrap = el.firstElementChild;
      const tbody = el.querySelector('tbody');
      return (s) => {
        const q = s.analysis && s.analysis.quali;
        const rows = q ? q.order : [];
        const sig = JSON.stringify([rows, s.rules && s.rules.mixed]);
        if (tbody.dataset.sig === sig) return;
        tbody.dataset.sig = sig;
        const cut = rows.findIndex((e) => e.cutLine);
        tbody.replaceChildren(...rows.map((e, i) => {
          const tr = document.createElement('tr');
          tr.className = [e.isPlayer ? 'is-player' : '', cut >= 0 && i > cut ? 'is-below' : '', e.cutLine ? 'is-cut' : ''].filter(Boolean).join(' ');
          const cell = (cls, content) => {
            const td = document.createElement('td');
            td.className = cls;
            if (content instanceof Node) td.appendChild(content);
            else td.textContent = content;
            return td;
          };
          const state = document.createElement('span');
          state.className = `w-qo__state is-${e.status}`;
          state.textContent = e.status === 'flying' ? 'PUSH' : e.status === 'out' ? 'OUT' : e.status === 'in' ? 'IN' : e.status === 'garage' ? 'GARAGE' : '';
          const tyre = document.createElement('span');
          tyre.append(compoundBadge(e.compound));
          tr.append(
            cell('pos', e.position ? `P${e.position}` : '–'),
            cell('name', nameWithEra(e, s)),
            cell('num strong', isNum(e.bestMs) ? fmtLap(e.bestMs) : 'No time'),
            cell('num dim', isNum(e.gapMs) && e.gapMs > 0 ? `+${secs(e.gapMs, 3)}` : ''),
            cell('', state),
            cell('tyre', tyre),
          );
          return tr;
        }));
        const me = tbody.querySelector('.is-player');
        if (me && (me.offsetTop < wrap.scrollTop || me.offsetTop + me.offsetHeight > wrap.scrollTop + wrap.clientHeight)) {
          wrap.scrollTop = me.offsetTop - wrap.clientHeight / 2;
        }
      };
    },
  };

  // ---------- Plan: the clock and the session around you ----------
  W.qplan = {
    title: 'Session plan',
    description: 'Time left, runs left, how many cars are on a push lap, the track temperature and your tyres',
    mount(el) {
      const tile = (k, label) => `<div class="w-qp__tile"><span class="w-label">${label}</span><b data-ref="${k}">–</b><span data-ref="${k}Sub"></span></div>`;
      const r = template(el, `
        <div class="w-qp">
          <p class="w-qp__line" data-ref="line"></p>
          <div class="w-qp__tiles">${tile('left', 'Time left')}${tile('runs', 'Runs')}${tile('push', 'On a push lap')}${tile('track', 'Track')}</div>
          <div class="w-qp__tyre"><span class="w-label">Tyres</span><span data-ref="tyre"></span></div>
        </div>`);
      return (s) => {
        const q = s.analysis && s.analysis.quali;
        const p = s.player;
        if (!q) {
          setText(r.line, 'Not a qualifying session.');
          return;
        }
        let line = '';
        if (q.status === 'garage' && q.runs === 0) line = 'No time for another run: the order stands.';
        else if (q.status === 'garage' && q.runs != null) line = `Time for ${plural(q.runs, 'run')} from here.`;
        else if (q.toLine && !q.toLine.makesIt) line = 'The flag falls before you reach the line: this lap will not count.';
        else if (q.traffic && q.traffic.behind) line = `${q.traffic.behind.name} is on a push lap behind you: let them by.`;
        setText(r.line, line);
        setText(r.left, q.timeLeftS == null ? 'No clock' : clockText(q.timeLeftS));
        setText(r.leftSub, q.name);
        setText(r.runs, q.runs == null ? '–' : String(q.runs));
        setText(r.runsSub, q.runs == null ? 'counted in the garage' : q.runs === 1 ? 'run left' : 'runs left');
        setText(r.push, String(q.pushing));
        setText(r.pushSub, `of ${q.order.length} cars`);
        const sess = s.session || {};
        setText(r.track, units.temp(sess.trackTemperature));
        setText(r.trackSub, isNum(sess.airTemperature) ? `air ${units.temp(sess.airTemperature)}` : '');
        r.tyre.replaceChildren(compoundBadge(p && p.tyreCompound), ` ${p && isNum(p.tyresAgeLaps) ? plural(p.tyresAgeLaps, 'lap') : ''}`);
      };
    },
  };
})();
