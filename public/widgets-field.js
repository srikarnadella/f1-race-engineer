// The race-order widgets: the pace chart and the cars nearby.
// Registers into window.RaceWidgets.widgets (widgets.js, which loads first, has the shared helpers).
(function () {
  'use strict';
  const { widgets: W, eraTag, setText, setTone, compoundBadge, template, neighbours, secs, signed, fmtLap, isNum } = window.RaceWidgets;

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
  /** @param {{ rows: (s: any) => any[], columns: any[], scrollToPlayer?: boolean }} spec */

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
      // The rules a car is on only join the key (and so redraw the row) in a mixed field.
      key: (c, s) => `${c.name}${c.pitStatus}${s.rules && s.rules.mixed ? c.regs2026 : ''}`,
      render: (td, c, s) => {
        td.textContent = c.name;
        const era = eraTag(c, s);
        if (era) td.appendChild(era);
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
})();
