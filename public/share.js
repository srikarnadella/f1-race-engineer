// The share-this-race image: one 1200 x 630 PNG (the size social posts show) with the result, the best lap, the
// stints and the graded calls of a saved session. shareModel says what the card says, drawShareCard draws it on a
// canvas context, savePng downloads it. Nothing is uploaded and no driver name, address or file path goes on it.
(function () {
  'use strict';
  const { fmtLap, COMPOUND_NAME } = window.RaceWidgets;

  const CARD = { width: 1200, height: 630 };
  const MARGIN = 64;
  const FONT = 'Archivo, system-ui, sans-serif';
  const MINUS = '−';

  const day = (ms) => new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
  const lapsRange = (a, b) => (a === b ? `Lap ${a}` : `Laps ${a}–${b}`);

  // What the card says. d: a session as Race analysis has it; audit: the calls audit, or null.
  function shareModel(d, audit) {
    const g = d.positionsGained;
    const sub = d.isRace && d.grid
      ? `from P${d.grid}${g ? ` · ${g > 0 ? '+' : MINUS}${Math.abs(g)}` : ''}${d.points ? ` · ${d.points} pts` : ''}`
      : d.isRace ? '' : 'Final position';
    const stats = [
      { label: 'Best lap', value: d.bestLap ? fmtLap(d.bestLap.ms) : '–' },
      d.isRace ? { label: 'Race pace', value: d.medianPaceMs ? fmtLap(d.medianPaceMs) : '–' } : { label: 'Timed laps', value: String(d.cleanLaps || 0) },
      d.isRace ? { label: 'Stops', value: d.pitStops != null ? String(d.pitStops) : '–' } : { label: 'Laps', value: String((d.laps || []).length) },
      { label: 'Consistency', value: d.consistencyMs != null ? `±${(d.consistencyMs / 1000).toFixed(2)} s` : '–' },
    ];
    let calls = null;
    if (audit && audit.calls && audit.calls.length) {
      const n = (v) => audit.calls.filter((c) => c.verdict === v).length;
      calls = `${audit.calls.length} calls: ${n('right')} right, ${n('wrong')} wrong, ${n('unclear') + n('rule')} not judged`;
    }
    return {
      title: [d.track, d.sessionName].filter(Boolean).join(' · ') || 'Race',
      date: day(d.startedAt),
      result: { big: d.finish ? `P${d.finish}` : '–', sub },
      stats,
      stints: (d.stints || []).map((s) => ({ name: COMPOUND_NAME[s.compound] || 'Unknown tyre', laps: s.laps, range: lapsRange(s.fromLap, s.toLap) })),
      calls,
    };
  }

  // The app's own colors, read from the page; the defaults are the dashboard's.
  function palette() {
    const css = getComputedStyle(document.documentElement);
    const v = (name, fallback) => css.getPropertyValue(`--${name}`).trim() || fallback;
    return {
      bg: v('bg', '#0a0a0a'), panel: v('panel', '#121212'), text: v('text', '#f4f4f4'), muted: v('muted', '#c8c8c8'), good: v('good', '#3ef08a'),
      soft: v('soft', '#ff3b3b'), medium: v('medium', '#ffd32b'), hard: v('hard', '#f2f2f2'), inter: v('inter', '#3ad15f'), wet: v('wet', '#2f8cff'),
    };
  }

  // A line that fits `max` px: cut with an ellipsis when it would run over.
  function fit(ctx, text, max) {
    if (ctx.measureText(text).width <= max) return text;
    let s = text;
    while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
    return `${s}…`;
  }

  function drawShareCard(ctx, m, pal) {
    const W = CARD.width;
    const H = CARD.height;
    const text = (str, x, y, size, color, { weight = 400, align = 'left', max = W - MARGIN * 2 } = {}) => {
      ctx.font = `${weight} ${size}px ${FONT}`;
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.fillText(fit(ctx, str, max), x, y);
    };
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, W, H);

    text(m.title, MARGIN, 96, 46, pal.text, { weight: 750 });
    text(m.date, MARGIN, 138, 26, pal.muted);

    // The result, large, with how it got there under it.
    text(m.result.big, MARGIN, 318, 168, pal.text, { weight: 800, max: 380 });
    text(m.result.sub, MARGIN, 366, 30, pal.muted, { max: 420 });

    // Four numbers in two columns.
    const colX = [520, 840];
    m.stats.slice(0, 4).forEach((s, i) => {
      const x = colX[i % 2];
      const y = 232 + Math.floor(i / 2) * 124;
      text(s.label, x, y, 24, pal.muted, { max: 290 });
      text(s.value, x, y + 56, 54, pal.text, { weight: 750, max: 290 });
    });

    // Stints, to scale: each bar as wide as the laps it ran.
    const total = m.stints.reduce((n, s) => n + s.laps, 0) || 1;
    const GAP = 6;
    const span = W - MARGIN * 2 - GAP * Math.max(0, m.stints.length - 1);
    let x = MARGIN;
    for (const s of m.stints) {
      const w = (span * s.laps) / total;
      ctx.fillStyle = pal[s.name.toLowerCase()] || pal.muted;
      ctx.fillRect(x, 440, w, 26);
      text(s.name, x, 502, 26, pal.text, { weight: 700, max: w });
      text(`${s.range} · ${s.laps} lap${s.laps === 1 ? '' : 's'}`, x, 532, 22, pal.muted, { max: w });
      x += w + GAP;
    }

    if (m.calls) text(m.calls, MARGIN, 592, 26, pal.good);
    text('Undercut', W - MARGIN, 592, 26, pal.muted, { align: 'right', weight: 700, max: 200 });
  }

  // 'undercut-spa-francorchamps-race-2026-10-20.png'
  function fileName(d) {
    const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const at = new Date(d.startedAt);
    const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
    return `undercut-${[slug(d.track), slug(d.sessionName)].filter(Boolean).join('-') || 'race'}-${date}.png`;
  }

  // Draws a session on a new canvas and offers it as a download. audit may be null (no graded calls on the card).
  async function shareRace(d, audit) {
    try {
      await document.fonts.load(`750 40px ${FONT}`);
      await document.fonts.load(`400 24px ${FONT}`);
    } catch (_) { /* the card falls back to the system font */ }
    const canvas = document.createElement('canvas');
    canvas.width = CARD.width;
    canvas.height = CARD.height;
    drawShareCard(canvas.getContext('2d'), shareModel(d, audit), palette());
    return savePng(canvas, fileName(d));
  }

  function savePng(canvas, name) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error('Couldn\'t make the picture'));
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        resolve(name);
      }, 'image/png');
    });
  }

  window.RaceShare = { CARD, shareModel, drawShareCard, fileName, shareRace, savePng };
})();
