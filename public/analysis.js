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

  // ---------- Pace: the session lap by lap ----------
  // What a lap was: the start, a pit lap, under the safety car, invalid, your best, or a clean lap.
  function lapKind(d, l) {
    if (l.pit) return 'pit';
    if (l.neutralised) return 'sc';
    if (l.invalid) return 'invalid';
    if (d.bestLap && l.lap === d.bestLap.lap) return 'best';
    if (d.isRace && l.lap === 1) return 'start';
    return 'clean';
  }
  const median = (xs) => { const s2 = [...xs].sort((a, b) => a - b); const m = s2.length >> 1; return s2.length % 2 ? s2[m] : (s2[m - 1] + s2[m]) / 2; };
  // Least-squares slope of y on x; null with fewer than two distinct x.
  function slope(xs, ys) {
    const n = xs.length;
    if (n < 2) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    return sxx ? xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx : null;
  }
  /** @type {[string, string, (l: any) => string][]} */
  const COLS = [
    ['lap', 'Lap', (l) => String(l.lap)], ['timeMs', 'Time', (l) => fmtLap(l.timeMs)],
    ['s1', 'S1', (l) => (l.s1 ? (l.s1 / 1000).toFixed(3) : '–')], ['s2', 'S2', (l) => (l.s2 ? (l.s2 / 1000).toFixed(3) : '–')], ['s3', 'S3', (l) => (l.s3 ? (l.s3 / 1000).toFixed(3) : '–')],
    ['position', 'Pos', (l) => (l.position ? `P${l.position}` : '–')], ['compound', 'Tyre', (l) => tyre(l.compound)], ['tyreAge', 'Age', (l) => (l.tyreAge != null ? String(l.tyreAge) : '–')],
    ['wearAvg', 'Wear', (l) => (l.wearAvg != null ? `${Math.round(l.wearAvg)}%` : '–')], ['fuelKg', 'Fuel', (l) => (l.fuelKg != null ? `${l.fuelKg.toFixed(1)} kg` : '–')], ['batteryPct', 'ERS', (l) => (l.batteryPct != null ? `${l.batteryPct}%` : '–')],
  ];
  const KIND_NAME = { start: 'start', pit: 'pit lap', sc: 'safety car', invalid: 'invalid', best: 'best lap', clean: '' };

  function pace(d) {
    const root = h('div', { class: 'pace' });
    if (!d.laps.length) {
      root.append(h('p', { class: 'ana__empty' }, 'No completed laps in this session.'));
      return root;
    }
    const laps = d.laps;
    const kinds = new Map(laps.map((l) => [l.lap, lapKind(d, l)]));
    const counts = (l) => ['clean', 'best'].includes(kinds.get(l.lap)) && l.timeMs > 0;

    // The chart: clean laps to scale, anything slower than 7% off the best pinned to the top.
    const W = 1000;
    const H = 300;
    const pad = { l: 118, r: 16, t: 14, b: 30 };
    const clean = laps.filter(counts).map((l) => l.timeMs);
    const lo = (clean.length ? Math.min(...clean) : Math.min(...laps.map((l) => l.timeMs))) * 0.995;
    const hi = (d.bestLap ? d.bestLap.ms : lo) * 1.07;
    const x = (i) => pad.l + (laps.length > 1 ? (i / (laps.length - 1)) * (W - pad.l - pad.r) : (W - pad.l - pad.r) / 2);
    const y = (ms) => pad.t + (1 - (Math.min(ms, hi) - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
    const svg = s('svg', { class: 'pace__chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Lap times, ${laps.length} laps` });
    for (const ms of [lo / 0.995, (lo / 0.995 + hi) / 2, hi]) {
      svg.append(s('line', { class: 'ana__grid', x1: pad.l, x2: W - pad.r, y1: y(ms), y2: y(ms) }), s('text', { class: 'ana__tick', x: pad.l - 14, y: y(ms) + 6, 'text-anchor': 'end' }, ms === hi ? `${fmtLap(ms)}+` : fmtLap(ms)));
    }
    const step = Math.max(1, Math.ceil(laps.length / 12));
    laps.forEach((l, i) => { if (i % step === 0) svg.append(s('text', { class: 'ana__tick', x: x(i), y: H - 6, 'text-anchor': 'middle' }, String(l.lap))); });
    // One line per stint through its laps that count, in the tyre's colour.
    for (const st of d.stints) {
      const pts = laps.map((l, i) => [l, i]).filter(([l]) => l.lap >= st.fromLap && l.lap <= st.toLap && counts(l)).map(([l, i]) => `${x(i).toFixed(1)},${y(l.timeMs).toFixed(1)}`);
      if (pts.length > 1) svg.append(s('polyline', { class: 'pace__line', 'data-c': (COMPOUND_NAME[st.compound] || '').toLowerCase(), points: pts.join(' ') }));
    }
    laps.forEach((l, i) => {
      const k = kinds.get(l.lap);
      svg.append(s('circle', { class: `pace__lap is-${k}`, 'data-lap': l.lap, 'data-kind': k, 'data-c': (COMPOUND_NAME[l.compound] || '').toLowerCase(), cx: x(i), cy: y(l.timeMs), r: k === 'best' ? 8 : 6 }));
    });
    const readout = h('p', { class: 'pace__readout' }, 'Point at the chart to read any lap.');
    svg.addEventListener('pointermove', (e) => {
      const box = svg.getBoundingClientRect();
      if (!box.width) return;
      const vx = ((e.clientX - box.left) / box.width) * W;
      const i = Math.max(0, Math.min(laps.length - 1, Math.round(((vx - pad.l) / (W - pad.l - pad.r)) * (laps.length - 1))));
      const l = laps[i];
      readout.textContent = [`Lap ${l.lap}`, fmtLap(l.timeMs), KIND_NAME[kinds.get(l.lap)], `${tyre(l.compound)}, ${l.tyreAge != null ? `${l.tyreAge} laps old` : ''}`, l.wearAvg != null ? `${Math.round(l.wearAvg)}% worn` : null, l.position ? `P${l.position}` : null].filter(Boolean).join(' · ');
    });

    // Stints: pace and how fast it fell away, from the laps that count (not the start or the in-lap).
    const stintRows = d.stints.map((st) => {
      const ls = laps.filter((l) => l.lap >= st.fromLap && l.lap <= st.toLap && counts(l) && kinds.get(l.lap) !== 'start');
      const fitted = ls.filter((l) => l.tyreAge != null);
      const deg = slope(fitted.map((l) => l.tyreAge), fitted.map((l) => l.timeMs / 1000));
      const wear = slope(fitted.filter((l) => l.wearAvg != null).map((l) => l.tyreAge), fitted.filter((l) => l.wearAvg != null).map((l) => l.wearAvg));
      const fuel = laps.filter((l) => l.lap >= st.fromLap && l.lap <= st.toLap && l.fuelKg != null);
      return h('tr', { class: 'pace__stint' },
        h('td', { 'data-c': (COMPOUND_NAME[st.compound] || '').toLowerCase() }, tyre(st.compound)),
        h('td', {}, st.fromLap === st.toLap ? String(st.fromLap) : `${st.fromLap}–${st.toLap}`),
        h('td', { class: 'num' }, ls.length ? fmtLap(median(ls.map((l) => l.timeMs))) : '–'),
        h('td', { class: 'num' }, ls.length ? fmtLap(Math.min(...ls.map((l) => l.timeMs))) : '–'),
        h('td', { class: 'num' }, deg != null && fitted.length >= 3 ? `${deg >= 0 ? '+' : '−'}${Math.abs(deg).toFixed(3)} s/lap` : '–'),
        h('td', { class: 'num' }, wear != null && fitted.length >= 3 ? `${wear.toFixed(1)}%/lap` : '–'),
        h('td', { class: 'num' }, fuel.length > 1 ? `${(fuel[0].fuelKg - fuel[fuel.length - 1].fuelKg).toFixed(1)} kg` : '–'),
        h('td', { class: 'num' }, String(ls.length)));
    });
    const stints = h('table', { class: 'tbl pace__stints' },
      h('thead', {}, h('tr', {}, ['Tyre', 'Laps', 'Typical lap', 'Best', 'Pace change per lap', 'Tyre wear', 'Fuel used', 'Laps counted'].map((x2, i) => h('th', { class: i > 1 ? 'num' : '' }, x2)))),
      h('tbody', {}, stintRows));

    // Sectors: your best, your typical, and what joining the best ones up would give.
    const sectorRows = ['s1', 's2', 's3'].map((k, i) => {
      const vals = laps.filter(counts).map((l) => l[k]).filter((v) => v > 0);
      const best = d.bestSectors && d.bestSectors[i];
      return h('tr', {}, h('td', {}, `Sector ${i + 1}`), h('td', { class: 'num' }, best ? (best / 1000).toFixed(3) : '–'), h('td', { class: 'num' }, vals.length ? (median(vals) / 1000).toFixed(3) : '–'), h('td', { class: 'num' }, best && vals.length ? `+${((median(vals) - best) / 1000).toFixed(3)}` : '–'));
    });
    const sectors = h('table', { class: 'tbl pace__sectors' },
      h('thead', {}, h('tr', {}, ['', 'Best', 'Typical', 'Typical vs best'].map((x2, i) => h('th', { class: i ? 'num' : '' }, x2)))), h('tbody', {}, sectorRows));

    // Every lap, sortable by any column.
    let sortKey = 'lap';
    let sortDir = 1;
    const table = h('table', { class: 'tbl pace__table' });
    function drawTable() {
      const rows = [...laps].sort((a, b) => ((a[sortKey] ?? Infinity) - (b[sortKey] ?? Infinity)) * sortDir || a.lap - b.lap);
      table.replaceChildren(
        h('thead', {}, h('tr', {}, COLS.map(([key, label]) => h('th', { class: key === 'lap' || key === 'compound' ? '' : 'num', 'aria-sort': key === sortKey ? (sortDir > 0 ? 'ascending' : 'descending') : 'none' },
          h('button', { type: 'button', onclick: () => { sortDir = key === sortKey ? -sortDir : 1; sortKey = key; drawTable(); } }, `${label}${key === sortKey ? (sortDir > 0 ? ' ↑' : ' ↓') : ''}`))))),
        h('tbody', {}, rows.map((l) => h('tr', { class: `is-${kinds.get(l.lap)}` }, COLS.map(([key, , fmt]) => h('td', { class: key === 'lap' || key === 'compound' ? '' : 'num' }, fmt(l)))))));
    }
    drawTable();
    const csv = h('button', {
      type: 'button', class: 'pace__csv',
      onclick: () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([widgets.debrief.lapsCsv(d)], { type: 'text/csv' }));
        a.download = widgets.debrief.csvName(d);
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      },
    }, 'Download CSV');

    root.append(
      h('section', {}, h('div', { class: 'pace__head' }, h('h3', {}, 'Lap times'), h('p', { class: 'pace__key' },
        h('span', {}, h('i', { class: 'is-clean' }), 'lap'), h('span', {}, h('i', { class: 'is-best' }), 'best'), h('span', {}, h('i', { class: 'is-pit' }), 'pit'),
        h('span', {}, h('i', { class: 'is-sc' }), 'safety car'), h('span', {}, h('i', { class: 'is-start' }), 'start'))), svg, readout),
      h('section', {}, h('h3', {}, 'Stints'), stints),
      h('section', {}, h('h3', {}, 'Sectors'), sectors, d.theoreticalBestMs ? h('p', { class: 'pace__note' }, `Your best three sectors joined up: ${fmtLap(d.theoreticalBestMs)}${d.bestLap ? `, ${((d.bestLap.ms - d.theoreticalBestMs) / 1000).toFixed(3)} s under your best lap` : ''}.`) : null),
      h('section', {}, h('div', { class: 'pace__head' }, h('h3', {}, 'Every lap'), csv), table));
    return root;
  }

  // ---------- Head to head: you against any car, lap by lap and slice by slice ----------
  // From every car's mini-sector splits (/api/debrief/field). Only laps you both completed count;
  // a lap more than 7% off a car's own typical lap (a stop, a safety car, a spin) is left out of the
  // pace, so a pit lap doesn't decide who was quicker.
  function headToHead(d) {
    const root = h('div', { class: 'h2h' }, h('p', { class: 'ana__empty' }, 'Loading every car\'s laps…'));
    let field = null;
    let rivalIdx = null;

    function clean(car) {
      const typical = car.laps.length ? median(car.laps.map((l) => l.ms)) : 0;
      return new Map(car.laps.filter((l) => l.ms <= typical * 1.07).map((l) => [l.lap, l]));
    }

    function render() {
      if (!field || field.error) {
        root.replaceChildren(h('p', { class: 'ana__empty' }, (field && field.error) || 'Couldn\'t reach the bridge.'));
        return;
      }
      const me = field.cars.find((c) => c.isPlayer);
      const others = field.cars.filter((c) => !c.isPlayer && c.laps.length).sort((a, b) => (a.position || 99) - (b.position || 99));
      if (!me || !me.laps.length || !others.length) {
        root.replaceChildren(h('p', { class: 'ana__empty' }, 'This session has no lap timing for the other cars to compare with.'));
        return;
      }
      if (rivalIdx == null || !others.some((c) => c.carIndex === rivalIdx)) {
        const ahead = others.find((c) => c.position === me.position - 1) || others.find((c) => c.position === me.position + 1) || others[0];
        rivalIdx = ahead.carIndex;
      }
      const them = others.find((c) => c.carIndex === rivalIdx);
      const pick = h('select', { class: 'h2h__pick lvl__pick', 'aria-label': 'Car to compare with', onchange: (e) => { rivalIdx = Number(e.target.value); render(); } },
        others.map((c) => h('option', { value: c.carIndex, selected: c.carIndex === rivalIdx }, `${c.position ? `P${c.position} ` : ''}${c.name}`)));

      const theirs = new Map(them.laps.map((l) => [l.lap, l]));
      const common = me.laps.filter((l) => theirs.has(l.lap));
      const myClean = clean(me);
      const theirClean = clean(them);
      const both = common.filter((l) => myClean.has(l.lap) && theirClean.has(l.lap));
      const diffs = both.map((l) => l.ms - theirs.get(l.lap).ms); // + = you slower
      const typical = diffs.length ? median(diffs) : null;
      const verdict = typical == null
        ? `No laps you and ${them.name} both ran cleanly to compare.`
        : `${them.name} was ${(Math.abs(typical) / 1000).toFixed(3)} s a lap ${typical > 0 ? 'faster' : 'slower'} than you over ${both.length} lap${both.length === 1 ? '' : 's'}`;

      const fact = (label, mine, theirsTxt) => h('tr', {}, h('th', {}, label), h('td', { class: 'num' }, theirsTxt), h('td', { class: 'num' }, mine));
      const facts = h('table', { class: 'tbl h2h__facts' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', { class: 'num' }, them.name), h('th', { class: 'num' }, 'You'))),
        h('tbody', {},
          fact('Finished', me.position ? `P${me.position}` : '–', them.position ? `P${them.position}` : '–'),
          fact('Best lap', fmtLap(me.bestMs) || '–', fmtLap(them.bestMs) || '–'),
          fact('Stops', String(me.stops ?? '–'), String(them.stops ?? '–')),
          fact('Tyres', (me.compounds || []).map(tyre).join(' → '), (them.compounds || []).map(tyre).join(' → '))));

      // Lap by lap: up = you were slower that lap.
      const W = 1000;
      const H = 220;
      const mid = H / 2;
      const cap = Math.max(300, ...diffs.map(Math.abs));
      const lapSvg = s('svg', { class: 'h2h__chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Lap by lap against ${them.name}` });
      lapSvg.append(s('line', { class: 'lvl__zero', x1: 0, x2: W, y1: mid, y2: mid }));
      const bw = W / Math.max(1, common.length);
      common.forEach((l, i) => {
        const diff = l.ms - theirs.get(l.lap).ms;
        const out = !(myClean.has(l.lap) && theirClean.has(l.lap));
        const hgt = (Math.min(Math.abs(diff), cap) / cap) * (mid - 18);
        const bar = s('rect', { class: `h2h__lap ${out ? 'is-out' : diff > 0 ? 'is-lost' : 'is-gained'}`, 'data-lap': l.lap, 'data-diff': diff, x: i * bw + bw * 0.18, width: bw * 0.64, y: diff > 0 ? mid - hgt : mid, height: Math.max(1, hgt), rx: 2 });
        bar.append(s('title', {}, `Lap ${l.lap}: ${signedS(diff / 1000)}${out ? ' (a stop, safety car or incident: not counted)' : ''}`));
        lapSvg.append(bar);
        if (common.length <= 30 || i % 2 === 0) lapSvg.append(s('text', { class: 'ana__tick', x: i * bw + bw / 2, y: H - 2, 'text-anchor': 'middle' }, String(l.lap)));
      });

      // Where on the lap: each slice's typical difference over the clean laps.
      const n = both.length ? both[0].splits.length : 0;
      const sliceM = n ? field.trackLength / n : 0;
      const slices = Array.from({ length: n }, (_, k) => median(both.map((l) => l.splits[k] - theirs.get(l.lap).splits[k])));
      const sCap = Math.max(50, ...slices.map(Math.abs));
      const sliceSvg = s('svg', { class: 'h2h__chart h2h__chart--slices', viewBox: `0 0 ${W} 140`, role: 'img', 'aria-label': `Where on the lap, against ${them.name}` });
      sliceSvg.append(s('line', { class: 'lvl__zero', x1: 0, x2: W, y1: 60, y2: 60 }));
      slices.forEach((v, k) => {
        const hgt = (Math.abs(v) / sCap) * 52;
        const bar = s('rect', { class: `h2h__slice ${v > 0 ? 'is-lost' : 'is-gained'}`, x: (k / n) * W + 1, width: W / n - 2, y: v > 0 ? 60 - hgt : 60, height: Math.max(1, hgt), rx: 2 });
        bar.append(s('title', {}, `${((k * sliceM) / 1000).toFixed(1)}–${(((k + 1) * sliceM) / 1000).toFixed(1)} km: ${signedS(v / 1000)} a lap`));
        sliceSvg.append(bar);
      });
      for (let km = 0; km <= field.trackLength / 1000; km++) sliceSvg.append(s('text', { class: 'ana__tick', x: Math.min(W - 12, ((km * 1000) / field.trackLength) * W + (km ? 0 : 12)), y: 132, 'text-anchor': 'middle' }, `${km} km`));
      const ranked = slices.map((v, k) => ({ v, k })).filter((x2) => Math.abs(x2.v) >= 20).sort((a, b) => b.v - a.v);
      const worst = h('ol', { class: 'h2h__worst' }, ranked.map(({ v, k }) => h('li', {},
        h('b', {}, `${((k * sliceM) / 1000).toFixed(1)}–${(((k + 1) * sliceM) / 1000).toFixed(1)} km`),
        h('span', { class: v > 0 ? 'lvl__lost' : 'lvl__gained' }, `you ${v > 0 ? 'lose' : 'gain'} ${(Math.abs(v) / 1000).toFixed(2)} s a lap`))));

      root.replaceChildren(
        h('div', { class: 'lvl__bar' }, h('label', {}, 'You against', pick)),
        h('p', { class: 'h2h__verdict lvl__verdict' }, verdict),
        facts,
        h('section', {}, h('div', { class: 'pace__head' }, h('h3', {}, 'Lap by lap'), h('p', { class: 'pace__key' }, h('span', {}, h('i', { class: 'h2h__key is-lost' }), 'you slower'), h('span', {}, h('i', { class: 'h2h__key is-gained' }), 'you faster'), h('span', {}, h('i', { class: 'h2h__key is-out' }), 'not counted'))), lapSvg),
        both.length ? h('section', {}, h('h3', {}, 'Where on the lap'), sliceSvg, ranked.length ? worst : h('p', { class: 'pace__note' }, 'Level everywhere: no part of the lap differs by more than 0.02 s.')) : '');
    }

    fetch(`/api/debrief/field?session=${encodeURIComponent(d.id)}`)
      .then((r) => r.json())
      .then((j) => { field = j; }, () => { field = null; })
      .then(render);
    return root;
  }

  // ---------- All races (R5): across sessions, from the race store ----------
  const ALL = '__all';
  function trendsPage() {
    const root = h('div', { class: 'trd' }, h('p', { class: 'ana__empty' }, 'Reading every race…'));
    const secs = (ms) => (ms / 1000).toFixed(3);
    fetch('/api/trends')
      .then((r) => r.json())
      .then((t) => {
        if (!t || t.error || !t.tracks) {
          root.replaceChildren(h('p', { class: 'ana__empty' }, (t && t.error) || 'Couldn\'t reach the bridge.'));
          return;
        }
        if (!t.tracks.length) {
          root.replaceChildren(h('p', { class: 'ana__empty' }, 'No races in the race store yet.'));
          return;
        }
        const c = t.calls.total;
        const nRaces = t.tracks.reduce((n, x) => n + x.races.length, 0);
        const verdict = c.graded
          ? `${c.right} of ${c.graded} graded calls were right${c.wrong ? `, ${c.wrong} wrong` : ', none wrong'}, across ${t.calls.races.length} race${t.calls.races.length === 1 ? '' : 's'}`
          : `${nRaces} race${nRaces === 1 ? '' : 's'} at ${t.tracks.length} track${t.tracks.length === 1 ? '' : 's'}; no calls graded yet`;
        const head = (...cells) => h('thead', {}, h('tr', {}, cells.map(([label, num]) => h('th', { class: num ? 'num' : null }, label))));
        root.replaceChildren(
          h('p', { class: 'trd__verdict lvl__verdict' }, verdict),
          ...t.tracks.map((tr) => h('section', { class: 'trd__track' },
            h('h3', {}, tr.track),
            h('p', { class: 'pace__note' }, `Best ever ${fmtLap(tr.bestEverMs)}. ${tr.improvedMs == null ? 'One race so far.' : `Against your first race here, your latest best lap was ${secs(Math.abs(tr.improvedMs))} s ${tr.improvedMs >= 0 ? 'faster' : 'slower'}${tr.typicalImprovedMs != null ? ` and your typical lap ${secs(Math.abs(tr.typicalImprovedMs))} s ${tr.typicalImprovedMs >= 0 ? 'faster' : 'slower'}` : ''}.`}`),
            h('table', { class: 'tbl trd__table' },
              head(['Date'], ['Session'], ['Grid → finish'], ['Best lap', true], ['Typical lap', true]),
              h('tbody', {}, tr.races.map((r) => h('tr', {},
                h('td', {}, r.date), h('td', {}, r.type), h('td', {}, `${r.grid ? `P${r.grid}` : '–'} → ${r.finish ? `P${r.finish}` : '–'}`),
                h('td', { class: 'num' }, fmtLap(r.bestMs)), h('td', { class: 'num' }, fmtLap(r.typicalMs)))))))),
          t.wear.length ? h('section', { class: 'trd__wear' },
            h('h3', {}, 'Tyre wear a lap'),
            h('p', { class: 'pace__note' }, 'The typical step in wear from one lap to the next on the same set, from your laps.'),
            h('table', { class: 'tbl trd__table' },
              head(['Track'], ['Tyre'], ['Wear a lap', true], ['Laps', true]),
              h('tbody', {}, t.wear.map((w) => h('tr', {}, h('td', {}, w.track), h('td', {}, w.tyre), h('td', { class: 'num' }, `${w.pctPerLap}%`), h('td', { class: 'num' }, String(w.laps))))))) : null,
        );
      }, () => root.replaceChildren(h('p', { class: 'ana__empty' }, 'Couldn\'t reach the bridge.')));
    return root;
  }

  // ---------- Strategy: the calls graded, your stops priced against the field's (R4) ----------
  // The calls audit (/api/debrief/audit) grades each call as `npm run backtest` does; its stops are
  // every car's in- and out-lap against the cars that stayed out those laps.
  const VERDICT_WORD = { right: 'Right', wrong: 'Wrong', unclear: 'Unclear', rule: 'Rule' };
  function strategy(d) {
    const root = h('div', { class: 'str' }, h('p', { class: 'ana__empty' }, 'Grading the calls…'));
    /** @type {any} */
    let audit = null;
    let filter = 'all';

    // Your stops from the laps: one per run of pit laps; the rejoin is the position after the out-lap.
    function myStops() {
      const out = [];
      d.laps.forEach((l, i) => {
        if (!l.pit || (i > 0 && d.laps[i - 1].pit)) return;
        let j = i;
        while (d.laps[j + 1] && d.laps[j + 1].pit) j++;
        const after = j > i ? d.laps[j] : d.laps[i + 1];
        const before = d.laps[i - 1];
        out.push({ lap: l.lap, from: l.compound, to: after ? after.compound : null, before: before ? before.position : null, after: after ? after.position : null });
      });
      return out;
    }

    // Races saved before the calls and every car's laps were kept with the session have neither.
    const oldSave = () => !audit.calls.length && !(audit.stops || []).length;

    function stopsSection() {
      const stops = myStops();
      if (!stops.length) return h('section', {}, h('h3', {}, 'Your stops'), h('p', { class: 'pace__note' }, 'No pit stop this race.'));
      const priced = audit.stops || [];
      const others = priced.filter((x) => !x.isPlayer && x.green).map((x) => x.costMs);
      const typical = others.length ? median(others) : null;
      const rows = stops.map((st) => {
        const p = priced.find((x) => x.isPlayer && x.lapNum === st.lap);
        let vs = oldSave() ? 'Not priced: this race was saved before stops were priced' : 'Not priced: no cars stayed out on those laps';
        if (p && !p.green) vs = 'Under the safety car or VSC: not comparable with green-flag stops';
        else if (p && typical != null) {
          const diff = p.costMs - typical;
          vs = `${(Math.abs(diff) / 1000).toFixed(1)} s ${diff <= 0 ? 'quicker' : 'slower'} than the others' typical ${(typical / 1000).toFixed(1)} s`;
        } else if (p) vs = 'Nobody else stopped under green to compare with';
        return h('li', { class: 'str__stop' },
          h('b', { class: 'str__stop-lap' }, `Lap ${st.lap}`),
          h('span', {}, `${tyre(st.from)} → ${st.to != null ? tyre(st.to) : '?'}`),
          h('span', { class: 'str__stop-cost' }, p ? `${(p.costMs / 1000).toFixed(1)} s` : '–'),
          h('span', { class: 'str__stop-vs' }, vs),
          h('span', {}, st.before && st.after ? `P${st.before} → P${st.after}` : ''));
      });
      // Every green-flag stop of the race on one axis: where yours sits.
      const green = priced.filter((x) => x.green);
      let strip = null;
      if (green.length > 1) {
        const W = 1000;
        const lo = Math.min(...green.map((x) => x.costMs));
        const hi = Math.max(...green.map((x) => x.costMs));
        const x = (v) => 20 + ((v - lo) / Math.max(1, hi - lo)) * (W - 40);
        strip = s('svg', { class: 'str__strip', viewBox: `0 0 ${W} 70`, role: 'img', 'aria-label': 'Every green-flag stop of the race, by what it cost' });
        strip.append(s('line', { class: 'ana__grid', x1: 20, x2: W - 20, y1: 30, y2: 30 }));
        for (const g of [...green].sort((a, b) => Number(a.isPlayer) - Number(b.isPlayer))) {
          const dot = s('circle', { class: `str__dot${g.isPlayer ? ' is-you' : ''}`, cx: x(g.costMs), cy: 30, r: g.isPlayer ? 9 : 6 });
          dot.append(s('title', {}, `${g.isPlayer ? 'You' : `Car ${g.carIndex + 1}`}, lap ${g.lapNum}: ${(g.costMs / 1000).toFixed(1)} s`));
          strip.append(dot);
        }
        strip.append(s('text', { class: 'ana__tick', x: 20, y: 64 }, `${(lo / 1000).toFixed(1)} s`), s('text', { class: 'ana__tick', x: W - 20, y: 64, 'text-anchor': 'end' }, `${(hi / 1000).toFixed(1)} s`));
      }
      return h('section', {},
        h('h3', {}, 'Your stops'),
        h('ol', { class: 'str__stops' }, rows),
        strip ? h('div', {}, h('p', { class: 'pace__note' }, 'Every green-flag stop in the race, cheapest on the left; yours is the large dot. A stop costs its in- and out-lap against the cars that stayed out those laps.'), strip) : null);
    }

    function callsSection() {
      const counts = { all: audit.calls.length, right: 0, wrong: 0, unclear: 0, rule: 0 };
      for (const c of audit.calls) counts[c.verdict] = (counts[c.verdict] || 0) + 1;
      const shown = audit.calls.filter((c) => filter === 'all' || c.verdict === filter);
      const chips = [['all', 'All'], ['right', 'Right'], ['wrong', 'Wrong'], ['unclear', 'Unclear'], ['rule', 'Rules']]
        .filter(([k]) => k === 'all' || counts[k])
        .map(([k, label]) => h('button', { type: 'button', class: 'str__filter', 'aria-pressed': String(filter === k), onclick: () => { filter = k; render(); } }, `${label} ${counts[k]}`));
      const copy = h('button', {
        type: 'button',
        class: 'str__copy',
        onclick: (e) => {
          const btn = e.currentTarget;
          if (!navigator.clipboard) return;
          navigator.clipboard.writeText(widgets.debrief.callsText(audit, d)).then(() => { btn.textContent = 'Copied'; }, () => { btn.textContent = 'Couldn\'t copy'; });
        },
      }, 'Copy as text');
      return h('section', {},
        h('div', { class: 'pace__head' }, h('h3', {}, 'Every call'), copy),
        h('div', { class: 'str__filters', role: 'group', 'aria-label': 'Show calls' }, chips),
        h('ol', { class: 'str__calls' }, shown.map((c) => h('li', { class: `str__call is-${c.verdict}`, 'data-lap': c.lapNum },
          h('b', { class: 'str__call-lap' }, `Lap ${c.lapNum}`),
          h('span', { class: 'str__call-action' }, c.action),
          h('span', { class: 'str__call-verdict' }, VERDICT_WORD[c.verdict] || c.verdict),
          h('span', { class: 'str__call-why' }, c.why)))),
        h('p', { class: 'pace__note' }, 'Each call is judged by the one thing it claims, on the laps after it. Following the rules (in the pits, a safety car, a penalty) isn\'t graded.'));
    }

    function render() {
      if (!audit || audit.error) {
        root.replaceChildren(h('p', { class: 'ana__empty' }, (audit && audit.error) || 'Couldn\'t reach the bridge.'));
        return;
      }
      const t = audit.summary;
      const verdict = oldSave()
        ? 'This race was saved before the calls were kept with it, so there is nothing to grade. Races from now on are graded here.'
        : t.graded
        ? `${t.right} of ${t.graded} graded call${t.graded === 1 ? ' was' : 's were'} right${t.wrong ? `, ${t.wrong} wrong` : ''}${t.unclear ? `, ${t.unclear} unclear` : ''}`
        : 'No calls to grade: every call this race followed the rules (pits, safety car, penalties).';
      root.replaceChildren(...[h('p', { class: 'str__verdict lvl__verdict' }, verdict), stopsSection(), audit.calls.length ? callsSection() : null].filter(Boolean));
    }

    fetch(`/api/debrief/audit?session=${encodeURIComponent(d.id)}`)
      .then((r) => r.json())
      .then((j) => { audit = j; }, () => { audit = null; })
      .then(render);
    return root;
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
      // Ask the race about the session on screen (its own place; it finds the session by track, type and day).
      const askBtn = h('button', {
        type: 'button',
        class: 'ana__ask',
        hidden: true,
        onclick: () => {
          const d = sessions.find((x) => x.id === selected);
          if (!d) return;
          const at = new Date(d.startedAt);
          desk.askSession = { track: d.track, type: d.sessionName, date: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}` };
          document.dispatchEvent(new CustomEvent('undercut:show', { detail: 'askrace' }));
        },
      }, 'Ask about this session');
      frame.replaceChildren(h('div', { class: 'ana' }, list, h('section', { class: 'ana__main' }, h('header', { class: 'ana__head' }, h('div', {}, title, meta, askBtn), views), body)));

      let sessions = [];
      let older = []; // saved sessions past the 10 the snapshot carries
      let selected = null;
      let view = 'overview';
      let last = null;
      let sig = '';
      let debriefUpdate = null;
      let lapView = null; // { id, node }: kept across redraws, so a new lap doesn't refetch the comparison
      let h2hView = null; // the same for Head to head
      let strView = null; // and Strategy
      let trendsView = null; // and All races
      const VIEWS = [['overview', 'Overview'], ['pace', 'Pace'], ['laps', 'Lap vs lap'], ['h2h', 'Head to head'], ['strategy', 'Strategy'], ['debrief', 'Full debrief']];

      function draw() {
        if (desk.analysisSession && sessions.some((x) => x.id === desk.analysisSession)) {
          selected = desk.analysisSession; // Storage's "Open in Race analysis"
          desk.analysisSession = null;
        }
        const all = selected === ALL;
        const d = all ? null : sessions.find((x) => x.id === selected) || sessions[0] || null;
        if (!all) selected = d ? d.id : null;
        list.replaceChildren(h('button', {
          type: 'button', class: 'ana__all', 'aria-current': String(all),
          onclick: () => { selected = ALL; sig = ''; draw(); },
        }, h('span', { class: 'ana__all-name' }, 'All races'), h('span', { class: 'ana__all-meta' }, 'Pace per track, tyre wear, the calls')), ...sessions.map((x) => h('button', {
          type: 'button', class: 'ana__session', 'aria-current': x.id === selected ? 'true' : 'false',
          onclick: () => { selected = x.id; sig = ''; draw(); },
        }, h('span', { class: 'ana__session-name' }, name(x)), h('span', { class: 'ana__session-meta' }, [x.live ? 'Now' : day(x.startedAt), x.finish ? `P${x.finish}` : null].filter(Boolean).join(' · ')))));
        // The Debrief card only has the sessions in the snapshot.
        const inSnap = !!(last && (last.debrief.sessions || []).some((x) => x.id === selected));
        if ((view === 'debrief' && !inSnap) || (view === 'strategy' && !(d && d.isRace))) view = 'overview';
        views.replaceChildren(...VIEWS.filter(([id]) => (id !== 'debrief' || inSnap) && (id !== 'strategy' || (d && d.isRace))).map(([id, label]) => h('button', {
          type: 'button', role: 'tab', class: 'ana__view', 'aria-selected': String(id === view),
          onclick: () => { view = id; sig = ''; draw(); },
        }, label)));
        views.hidden = !d;
        askBtn.hidden = true;
        if (all) {
          title.textContent = 'All races';
          meta.textContent = 'Every race in the race store, across sessions';
          debriefUpdate = null;
          if (!trendsView) trendsView = trendsPage();
          if (!body.contains(trendsView)) body.replaceChildren(trendsView);
          return;
        }
        if (!d) {
          title.textContent = '';
          meta.textContent = '';
          body.replaceChildren(h('p', { class: 'ana__empty' }, 'No saved sessions yet. Each session is saved here when it ends: drive one with the game\'s telemetry on, or watch the demo race.'));
          return;
        }
        title.textContent = name(d);
        askBtn.hidden = !!d.live; // a session in progress isn't in race.db yet
        meta.textContent = `${d.live ? 'In progress' : day(d.startedAt)} · ${d.laps.length} lap${d.laps.length === 1 ? '' : 's'} recorded`;
        debriefUpdate = null;
        if (view === 'overview') {
          body.replaceChildren(overview(d));
        } else if (view === 'pace') {
          body.replaceChildren(pace(d));
        } else if (view === 'h2h') {
          if (!h2hView || h2hView.id !== d.id) h2hView = { id: d.id, node: headToHead(d) };
          if (!body.contains(h2hView.node)) body.replaceChildren(h2hView.node);
        } else if (view === 'strategy') {
          if (!strView || strView.id !== d.id) strView = { id: d.id, node: strategy(d) };
          if (!body.contains(strView.node)) body.replaceChildren(strView.node);
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

      desk.olderSessions().then((list) => {
        older = list;
        if (!last) return;
        sessions = desk.withOlder(last.debrief.sessions || [], older);
        sig = '';
        draw();
      });

      return (snap) => {
        if (!snap.debrief) return;
        last = snap;
        sessions = desk.withOlder(snap.debrief.sessions || [], older);
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
