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

  // ---------- Lap vs lap: two laps on one distance axis ----------
  // The bridge compares A (the reference) with B (the lap it explains): + means B lost time. Here
  // "your lap" is always the one explained and "against" the reference, another lap or a rival's best.
  const REF = '#2a8fd4'; // reference lap; this pair passes the dataviz checks on the dark ground
  const MINE = '#d9740a'; // your lap
  const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
  const steerTxt = (v) => (v == null ? '–' : Math.abs(v) < 0.02 ? 'straight' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'left' : 'right'}`);
  const signedS = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(3)} s`;

  function lapVsLap(d) {
    const root = h('div', { class: 'lvl' }, h('p', { class: 'ana__empty' }, 'Loading the two laps…'));
    let c = null;
    let range = null; // [fromM, toM] while zoomed into a corner
    let cursor = null; // index on the distance grid under the pointer
    let charts = [];
    let readout = null;

    async function load(query) {
      try {
        const res = await fetch(`/api/debrief/compare?session=${encodeURIComponent(d.id)}${query}`);
        c = await res.json();
      } catch (_) {
        c = { error: 'Couldn\'t reach the bridge.' };
      }
      range = null;
      cursor = null;
      render();
    }

    function picked() {
      const mine = root.querySelector('.lvl__pick[data-pick="mine"]').value;
      const ref = root.querySelector('.lvl__pick[data-pick="ref"]').value;
      // Against a rival the bridge takes your lap as a; against another lap, a is the reference.
      load(/^r\d+$/.test(ref) ? `&a=${mine}&b=${ref}` : `&a=${ref}&b=${mine}`);
    }

    function chart(label, series, { min, max, zero = false, height = 90, note = null }) {
      const W = 1000;
      const t = c.trace;
      const [k0, k1] = window_();
      const x = (k) => ((k - k0) / Math.max(1, k1 - k0)) * W;
      const y = (v) => height - 6 - ((Math.max(min, Math.min(max, v)) - min) / (max - min || 1)) * (height - 12);
      const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label, 'data-from': t.d[k0], 'data-to': t.d[k1] });
      if (zero) svg.append(s('line', { class: 'lvl__zero', x1: 0, x2: W, y1: y(0), y2: y(0) }));
      for (const sr of series) {
        const pts = [];
        for (let k = k0; k <= k1; k++) pts.push(`${x(k).toFixed(1)},${y(sr.values[k]).toFixed(1)}`);
        svg.append(s('polyline', { class: 'lvl__line', points: pts.join(' '), stroke: sr.color, 'vector-effect': 'non-scaling-stroke' }));
      }
      const cross = s('line', { class: 'lvl__cross', y1: 0, y2: height, visibility: 'hidden', 'vector-effect': 'non-scaling-stroke' });
      svg.append(cross);
      const pick = (e) => {
        const box = svg.getBoundingClientRect();
        if (!box.width) return;
        setCursor(Math.round(k0 + ((e.clientX - box.left) / box.width) * (k1 - k0)));
      };
      svg.addEventListener('pointermove', pick);
      svg.addEventListener('pointerleave', () => setCursor(null));
      charts.push({ cross, x, k0, k1 });
      return h('div', { class: 'lvl__chart' }, h('div', { class: 'lvl__chart-head' }, h('span', { class: 'lvl__chart-name' }, label), note ? h('small', {}, note) : null), svg);
    }

    // The grid indices on screen: the whole lap, or one corner with 50 m either side.
    function window_() {
      const t = c.trace;
      if (!range) return [0, t.d.length - 1];
      const k0 = Math.max(0, t.d.findIndex((m) => m >= range[0]));
      let k1 = t.d.length - 1;
      while (k1 > k0 && t.d[k1] > range[1]) k1--;
      return [k0, k1];
    }

    function setCursor(k) {
      cursor = k;
      for (const ch of charts) {
        const on = k != null && k >= ch.k0 && k <= ch.k1;
        ch.cross.setAttribute('visibility', on ? 'visible' : 'hidden');
        if (on) for (const a of ['x1', 'x2']) ch.cross.setAttribute(a, String(ch.x(k)));
      }
      if (!readout) return;
      const t = c.trace;
      if (k == null) {
        readout.textContent = 'Point at any chart to read both laps at that spot.';
        return;
      }
      const both = (ch, f) => `${f(t.b[ch][k])} / ${f(t.a[ch][k])}`;
      readout.textContent = [`${(t.d[k] / 1000).toFixed(2)} km`, `gap ${signedS(t.delta[k])}`, `speed ${both('speed', (v) => `${Math.round(v)}`)} km/h`, `throttle ${both('throttle', pct)}`, `brake ${both('brake', pct)}`, `gear ${both('gear', String)}`, `steering ${both('steer', steerTxt)}`].join(' · ');
    }

    function render() {
      charts = [];
      if (!c || c.error) {
        root.replaceChildren(h('p', { class: 'ana__empty' }, (c && c.error) || 'Nothing to compare yet.'));
        return;
      }
      const vsRival = !!c.lapA.rival;
      const refName = vsRival ? `${c.lapA.rival}'s best` : `lap ${c.lapA.lapNum}`;
      const mineName = `Lap ${c.lapB.lapNum}`;
      const lapOpt = (l, sel) => h('option', { value: l.lap, selected: l.lap === sel }, `Lap ${l.lap} · ${fmtLap(l.timeMs)}${l.neutralised ? ' · SC' : ''}`);
      const mineSel = h('select', { class: 'lvl__pick', 'data-pick': 'mine', 'aria-label': 'Your lap', onchange: picked }, c.laps.map((l) => lapOpt(l, c.lapB.lapNum)));
      const refSel = h('select', { class: 'lvl__pick', 'data-pick': 'ref', 'aria-label': 'Against', onchange: picked },
        c.laps.map((l) => lapOpt(l, vsRival ? null : c.lapA.lapNum)),
        (c.rivals || []).length ? h('optgroup', { label: 'Best laps in the field' }, c.rivals.map((r) => h('option', { value: r.id, selected: r.id === c.lapA.id }, `${r.name} · ${fmtLap(r.timeMs)}`))) : null);
      const total = c.totalS;
      const verdict = h('p', { class: 'lvl__verdict' }, `${mineName} was ${Math.abs(total).toFixed(3)} s ${total > 0 ? 'slower' : 'faster'} than ${refName}`);
      const legend = h('p', { class: 'lvl__legend' },
        h('span', {}, h('i', { style: `background: ${MINE}` }), `${mineName} (yours)`),
        h('span', {}, h('i', { style: `background: ${REF}` }), `${refName.charAt(0).toUpperCase()}${refName.slice(1)}`));

      const t = c.trace;
      const both = (ch) => [{ values: t.a[ch], color: REF }, { values: t.b[ch], color: MINE }];
      const [k0, k1] = window_();
      const gaps = t.delta.slice(k0, k1 + 1);
      const gMin = Math.min(0, ...gaps);
      const gMax = Math.max(0, ...gaps);
      const gPad = Math.max(0.05, (gMax - gMin) * 0.1);
      const top = Math.max(...t.a.speed.slice(k0, k1 + 1), ...t.b.speed.slice(k0, k1 + 1));
      const stack = h('div', { class: 'lvl__charts' },
        chart('Time gap', [{ values: t.delta, color: 'var(--text)' }], { min: gMin - gPad, max: gMax + gPad, zero: true, height: 120, note: 'up = your lap behind' }),
        chart('Speed', both('speed'), { min: 0, max: Math.max(100, top * 1.05), height: 170 }),
        chart('Throttle', both('throttle'), { min: 0, max: 1, height: 70 }),
        chart('Brake', both('brake'), { min: 0, max: 1, height: 70 }),
        chart('Gear', both('gear'), { min: 0, max: 8, height: 80 }),
        chart('Steering', both('steer'), { min: -1, max: 1, zero: true, height: 80 }));
      readout = h('p', { class: 'lvl__readout', 'aria-live': 'off' });

      // Where the time went: corners by time lost, then anything lost away from a corner.
      const corners = [...c.corners].sort((a, b) => b.timeS - a.timeS);
      const detail = (k) => (k.summary.includes(' - ') ? k.summary.slice(k.summary.indexOf(' - ') + 3) : '');
      const list = h('ol', { class: 'lvl__corners' }, corners.map((k) => h('li', {},
        h('button', { type: 'button', class: 'lvl__corner', onclick: () => { range = [Math.max(0, k.fromM - 50), Math.min(t.d[t.d.length - 1], k.toM + 50)]; render(); } },
          h('b', {}, `Corner ${k.corner}`), h('span', { class: 'lvl__at' }, `${(k.atM / 1000).toFixed(1)} km`),
          h('span', { class: k.timeS > 0.03 ? 'lvl__lost' : k.timeS < -0.03 ? 'lvl__gained' : 'lvl__even' }, k.timeS > 0.03 ? `lost ${k.timeS.toFixed(2)} s` : k.timeS < -0.03 ? `gained ${(-k.timeS).toFixed(2)} s` : 'even'),
          h('span', { class: 'lvl__why' }, detail(k))))));
      const offCorner = c.headline.filter((x) => !/^Corner /.test(x));

      root.replaceChildren(
        h('div', { class: 'lvl__bar' }, h('label', {}, 'Your lap', mineSel), h('label', {}, 'against', refSel)),
        verdict,
        h('div', { class: 'lvl__tools' }, legend, h('button', { type: 'button', class: 'lvl__whole', hidden: !range, onclick: () => { range = null; render(); } }, 'Whole lap')),
        stack,
        readout,
        h('section', {}, h('h3', {}, 'Where the time went'), corners.length ? list : h('p', { class: 'ana__empty' }, 'No braking zones to compare on these laps.'),
          offCorner.length ? h('ul', { class: 'lvl__notes' }, offCorner.map((x) => h('li', {}, x))) : null));
      setCursor(cursor);
    }

    load('');
    return root;
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
      let lapView = null; // { id, node }: kept across redraws, so a new lap doesn't refetch the comparison
      const VIEWS = [['overview', 'Overview'], ['laps', 'Lap vs lap'], ['debrief', 'Full debrief']];

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
        } else if (view === 'laps') {
          if (!lapView || lapView.id !== d.id) lapView = { id: d.id, node: lapVsLap(d) };
          if (!body.contains(lapView.node)) body.replaceChildren(lapView.node);
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
