// The Debrief widget: the post-session recap, lap against lap, where the
// time goes against a rival, and the models. Loaded after widgets.js, whose
// formatting helpers it shares; like every widget it only formats.
(function () {
  'use strict';

  const { widgets: W, esc, badge, plus, isNum, fmtLap, degText, COMPOUND_NAME } = window.RaceWidgets;

  // ---------- Debrief: post-session recap ----------
  // The live session plus the last few finished ones (the bridge keeps them
  // after the game moves on). Rebuilt only when the data changes - it
  // arrives once a second - and every game-sourced string is escaped.
  const sec = (ms) => (isNum(ms) && ms > 0 ? (ms / 1000).toFixed(3) : '–');

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
      const maxS = Math.max(...o.importance.map((w) => w.share), 0.01);
      // Features the trees never split on learned nothing - hide them.
      const shares = o.importance.filter((w) => w.share >= 0.005).map((w) => `<div class="w-mdl__w"><span>${FEATURE_LABEL[w.feature] || esc(w.feature)}</span>`
        + `<span class="w-mdl__bar"><i class="pos" style="width:${(w.share / maxS) * 100}%"></i></span><b>${Math.round(w.share * 100)}%</b></div>`).join('');
      html += `<div class="w-mdl__card"><h3>Overtake probability</h3><p class="dim">${esc(o.question)} Gradient-boosted trees (LightGBM, ${o.trees} trees), trained on ${o.trainedOn.races} recorded races: ${o.trainedOn.samples.toLocaleString()} one-second battle samples, ${o.trainedOn.passes.toLocaleString()} followed by a pass. Drives the pass / threat chips and "pass likely" calls.</p>`
        + (ev ? `<div class="w-deb__tiles"><div class="w-deb__tile"><span class="w-label">Held-out AUC</span><b>${ev.model.auc.toFixed(3)}</b><span class="dim">gap-only baseline ${ev.gapOnlyBaseline.auc.toFixed(3)}</span></div><div class="w-deb__tile"><span class="w-label">Brier skill</span><b>${ev.model.brierSkill.toFixed(3)}</b><span class="dim">baseline ${ev.gapOnlyBaseline.brierSkill.toFixed(3)}</span></div><div class="w-deb__tile"><span class="w-label">Evaluation</span><b>Leave one race out</b><span class="dim">each race scored by a model that never saw it</span></div></div>` : '')
        + (ev ? verdictHtml(ev) + calibrationHtml(ev.model.calibration) : '')
        + `<div class="w-label">What it leans on <span class="dim">share of what the trees learned from each</span></div><div class="w-mdl__weights">${shares}</div></div>`;
    } else {
      html += '<div class="w-mdl__card"><h3>Overtake probability</h3><p class="dim">No model yet - record races with npm run capture, then python ml/overtake_lgbm.py.</p></div>';
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
})();
