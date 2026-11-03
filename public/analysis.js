// Race analysis: the desktop app's place for saved sessions in depth (roadmap R1-R5). Every
// number is one the engine already saved: the session summaries the Debrief gets each second
// (src/engine/debrief.js summarize). Only in the app window (desktop.js defines the place).
(function () {
  'use strict';

  const desk = window.RaceDesktop;
  if (!desk || !desk.placeFrame) return;
  const { widgets, fmtLap, plus, COMPOUND_NAME } = window.RaceWidgets;

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  const SVG = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    for (const kid of kids) el.append(kid);
    return el;
  }
  const tyre = (code) => COMPOUND_NAME[code] || 'Unknown tyre';
  const name = (d) => [d.track, d.sessionName].filter(Boolean).join(' · ');
  const day = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const lapsRange = (a, b) => (a === b ? `Lap ${a}` : `Laps ${a}–${b}`);

  // ---------- Key moments, in lap order ----------
  function moments(d) {
    const out = [];
    const first = d.laps[0];
    if (d.isRace && d.grid) out.push({ lap: 1, at: 'Lap 1', text: `Started P${d.grid}${first && first.position ? `, P${first.position} after lap 1` : ''}` });
    for (const p of d.penalties || []) if (p.lap != null) out.push({ lap: p.lap, at: `Lap ${p.lap}`, text: p.what });
    // A stop flags the in-lap and often the out-lap too: one stop per run of pit laps, from the
    // tyre it came in on to the tyre it left on.
    d.laps.forEach((l, i) => {
      if (!l.pit || (i > 0 && d.laps[i - 1].pit)) return;
      let j = i;
      while (d.laps[j + 1] && d.laps[j + 1].pit) j++;
      const after = j > i ? d.laps[j] : d.laps[i + 1];
      out.push({ lap: l.lap, at: `Lap ${l.lap}`, text: `Pit stop: ${tyre(l.compound)}${after && after.compound !== l.compound ? ` → ${tyre(after.compound)}` : ', same tyre'}` });
    });
    // Neutralised laps in runs: one moment per safety car or VSC period.
    /** @type {{ from: number, to: number } | null} */
    let run = null;
    for (const l of [...d.laps, { lap: Infinity, neutralised: false }]) {
      if (l.neutralised) run = run ? { ...run, to: l.lap } : { from: l.lap, to: l.lap };
      else if (run) {
        out.push({ lap: run.from, at: lapsRange(run.from, run.to), text: 'Safety car or VSC' });
        run = null;
      }
    }
    if (d.bestLap) out.push({ lap: d.bestLap.lap, at: `Lap ${d.bestLap.lap}`, text: `Best lap ${fmtLap(d.bestLap.ms)}` });
    const last = d.laps[d.laps.length - 1];
    if (d.isRace && d.finish && last && !d.live) out.push({ lap: last.lap + 0.5, at: `Lap ${last.lap}`, text: `Finished P${d.finish}` });
    return out.sort((a, b) => a.lap - b.lap);
  }

  // ---------- Positions, lap by lap: you highlighted, the field behind ----------
  function positionChart(pc) {
    const laps = pc.cars[0].positions.length;
    const W = 1000;
    const H = 320;
    const pad = { l: 44, r: 12, t: 10, b: 28 };
    const x = (k) => pad.l + (laps > 1 ? (k / (laps - 1)) * (W - pad.l - pad.r) : 0);
    const y = (p) => pad.t + ((p - 1) / Math.max(1, pc.maxPos - 1)) * (H - pad.t - pad.b);
    const me = pc.cars.find((c) => c.isPlayer);
    const svg = s('svg', { class: 'ana__pos', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Positions lap by lap${me ? `: you from P${me.positions.find(Boolean)} to P${[...me.positions].reverse().find(Boolean)}` : ''}` });
    for (const p of [1, Math.ceil(pc.maxPos / 2), pc.maxPos]) {
      svg.append(s('line', { class: 'ana__grid', x1: pad.l, x2: W - pad.r, y1: y(p), y2: y(p) }), s('text', { class: 'ana__tick', x: pad.l - 8, y: y(p) + 4, 'text-anchor': 'end' }, `P${p}`));
    }
    const step = Math.max(1, Math.ceil(laps / 10));
    for (let k = 0; k < laps; k += step) svg.append(s('text', { class: 'ana__tick', x: x(k), y: H - 8, 'text-anchor': 'middle' }, String(pc.lapStart + k)));
    const line = (c) => s('polyline', { class: c.isPlayer ? 'ana__me' : 'ana__them', points: c.positions.map((p, k) => (p ? `${x(k).toFixed(1)},${y(p).toFixed(1)}` : null)).filter(Boolean).join(' ') });
    for (const c of pc.cars) if (!c.isPlayer) svg.append(line(c));
    if (me) svg.append(line(me));
    // Hover: a crosshair on the nearest lap and where you were.
    const cross = s('line', { class: 'ana__cross', y1: pad.t, y2: H - pad.b, visibility: 'hidden' });
    const dot = s('circle', { class: 'ana__dot', r: 6, visibility: 'hidden' });
    svg.append(cross, dot);
    const tip = h('div', { class: 'ana__tip', hidden: true });
    const wrap = h('div', { class: 'ana__chart' }, svg, tip);
    svg.addEventListener('pointermove', (e) => {
      const box = svg.getBoundingClientRect();
      if (!box.width) return;
      const vx = ((e.clientX - box.left) / box.width) * W;
      const k = Math.max(0, Math.min(laps - 1, Math.round(((vx - pad.l) / (W - pad.l - pad.r)) * (laps - 1))));
      const p = me && me.positions[k];
      for (const [el, a] of [[cross, { x1: x(k), x2: x(k) }], [dot, { cx: x(k), cy: p ? y(p) : -20 }]]) for (const [n, v] of Object.entries(a)) el.setAttribute(n, String(v));
      cross.setAttribute('visibility', 'visible');
      dot.setAttribute('visibility', p ? 'visible' : 'hidden');
      tip.textContent = `${k === 0 ? 'Start' : `Lap ${pc.lapStart + k}`}${p ? ` · P${p}` : ''}`;
      tip.style.left = `${(x(k) / W) * 100}%`;
      tip.hidden = false;
    });
    svg.addEventListener('pointerleave', () => {
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    });
    return wrap;
  }

  // ---------- The overview of one session ----------
  function overview(d) {
    const stat = (label, value, sub) => h('div', { class: 'ana__stat' }, h('span', { class: 'ana__stat-label' }, label), h('b', {}, value), sub ? h('span', { class: 'ana__stat-sub' }, sub) : null);
    const g = d.positionsGained;
    const result = h('div', { class: 'ana__result' },
      h('b', { class: 'ana__pos-big' }, d.finish ? `P${d.finish}` : '–'),
      d.isRace && d.grid ? h('span', {}, `from P${d.grid}${g ? ` · ${g > 0 ? '+' : '−'}${Math.abs(g)}` : ''}${d.points ? ` · ${d.points} pts` : ''}`) : h('span', {}, d.isRace ? '' : 'Final position'));
    const stats = h('div', { class: 'ana__stats' },
      stat('Best lap', d.bestLap ? fmtLap(d.bestLap.ms) : '–', d.bestLap ? `lap ${d.bestLap.lap}${d.fieldBestMs ? ` · ${plus(d.bestLap.ms - d.fieldBestMs)} to the fastest` : ''}` : 'no clean lap'),
      stat('Theoretical best', d.theoreticalBestMs ? fmtLap(d.theoreticalBestMs) : '–', d.theoreticalBestMs && d.bestLap ? `your best sectors joined up: ${plus(d.theoreticalBestMs - d.bestLap.ms)}` : null),
      d.isRace ? stat('Race pace', d.medianPaceMs ? fmtLap(d.medianPaceMs) : '–', `median of ${d.cleanLaps} clean laps`) : stat('Timed laps', String(d.cleanLaps), 'clean, valid laps'),
      stat('Consistency', d.consistencyMs != null ? `±${(d.consistencyMs / 1000).toFixed(2)} s` : '–', 'spread of clean laps'),
      d.isRace ? stat('Stops', d.pitStops != null ? String(d.pitStops) : '–', null) : null,
      stat('Penalties', String((d.penalties || []).length), (d.penalties || []).map((p) => p.what).join(', ') || 'clean'));
    const stints = h('div', { class: 'ana__stints', role: 'list', 'aria-label': 'Stints' }, d.stints.map((st) => h('div', {
      class: 'ana__stint', role: 'listitem', 'data-c': (COMPOUND_NAME[st.compound] || '').toLowerCase(), style: `flex-grow: ${st.laps}`,
    }, h('b', {}, tyre(st.compound)), h('span', {}, `${lapsRange(st.fromLap, st.toLap)} · ${st.laps} lap${st.laps === 1 ? '' : 's'}`))));
    const list = moments(d);
    return h('div', { class: 'ana__overview' },
      h('div', { class: 'ana__top' }, result, stats),
      h('section', {}, h('h3', {}, 'Stints'), stints),
      d.positionChart && d.positionChart.cars.length ? h('section', {}, h('h3', {}, 'Positions, lap by lap'), positionChart(d.positionChart)) : null,
      list.length ? h('section', {}, h('h3', {}, 'Key moments'), h('ol', { class: 'ana__moments' }, list.map((m) => h('li', { class: 'ana__moment' }, h('b', {}, m.at), h('span', {}, m.text))))) : null);
  }

  widgets.analysis = {
    title: 'Race analysis',
    description: 'Every saved session in depth',
    tall: true,
    mount(el) {
      const frame = desk.placeFrame(el, 'Race analysis');
      const list = h('nav', { class: 'ana__list', 'aria-label': 'Saved sessions' });
      const title = h('h2', { class: 'ana__title' });
      const meta = h('p', { class: 'ana__meta' });
      const views = h('div', { class: 'ana__views', role: 'tablist' });
      const body = h('div', { class: 'ana__body' });
      frame.replaceChildren(h('div', { class: 'ana' }, list, h('section', { class: 'ana__main' }, h('header', { class: 'ana__head' }, h('div', {}, title, meta), views), body)));

      let sessions = [];
      let selected = null;
      let view = 'overview';
      let last = null;
      let sig = '';
      let debriefUpdate = null;
      const VIEWS = [['overview', 'Overview'], ['debrief', 'Full debrief']];

      function draw() {
        const d = sessions.find((x) => x.id === selected) || sessions[0] || null;
        selected = d ? d.id : null;
        list.replaceChildren(...sessions.map((x) => h('button', {
          type: 'button', class: 'ana__session', 'aria-current': x.id === selected ? 'true' : 'false',
          onclick: () => { selected = x.id; sig = ''; draw(); },
        }, h('span', { class: 'ana__session-name' }, name(x)), h('span', { class: 'ana__session-meta' }, [x.live ? 'Now' : day(x.startedAt), x.finish ? `P${x.finish}` : null].filter(Boolean).join(' · ')))));
        views.replaceChildren(...VIEWS.map(([id, label]) => h('button', {
          type: 'button', role: 'tab', class: 'ana__view', 'aria-selected': String(id === view),
          onclick: () => { view = id; sig = ''; draw(); },
        }, label)));
        views.hidden = !d;
        if (!d) {
          title.textContent = '';
          meta.textContent = '';
          body.replaceChildren(h('p', { class: 'ana__empty' }, 'No saved sessions yet. Each session is saved here when it ends: drive one with the game\'s telemetry on, or watch the demo race.'));
          return;
        }
        title.textContent = name(d);
        meta.textContent = `${d.live ? 'In progress' : day(d.startedAt)} · ${d.laps.length} lap${d.laps.length === 1 ? '' : 's'} recorded`;
        debriefUpdate = null;
        if (view === 'overview') {
          body.replaceChildren(overview(d));
        } else {
          // The Debrief's own views (lap compare, rivals, calls), on this session, until R2-R4 replace them here.
          const host = h('div', { class: 'ana__debrief' });
          body.replaceChildren(host);
          window.RaceDebrief.openSession(d.id);
          debriefUpdate = widgets.debrief.mount(host);
          if (last) debriefUpdate(last);
        }
      }

      return (snap) => {
        if (!snap.debrief) return;
        last = snap;
        sessions = snap.debrief.sessions || [];
        // Redraw only when the saved sessions change; the Debrief inside keeps itself current.
        const next = JSON.stringify(sessions.map((x) => [x.id, x.laps.length, x.finish, x.live]));
        if (next !== sig) {
          sig = next;
          draw();
        } else if (debriefUpdate) {
          debriefUpdate(snap);
        }
      };
    },
  };
})();
