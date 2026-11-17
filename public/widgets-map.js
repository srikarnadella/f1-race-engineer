// The track map: the outline the bridge learned from one of your clean laps (src/state/trackOutline.js), coloured by where
// you lose time (red) and gain it (green) - against your own laps or against the car ahead, from the 25 mini-sectors of
// every car's lap (src/analysis/mapLoss.js) - with every car on it from the Motion packet. You are the bright dot.
// Registers into window.RaceWidgets.widgets (widgets.js, which loads first, has the shared helpers).
(function () {
  'use strict';
  const { widgets: W, setText, template, isNum } = window.RaceWidgets;
  const NS = 'http://www.w3.org/2000/svg';
  const SIZE = 100;
  const PAD = 7;
  const EVEN_MS = 30; // a slice within this is "about even": grey
  const SCALE_MS = 150; // a slice this far off (or the worst one, if worse) is drawn at full strength

  const s1 = (ms) => (Math.abs(ms) / 1000).toFixed(2);
  const where = (w) => (w.corner != null ? `into turn ${w.corner}` : `${Math.round(((w.sector + 0.5) / 25) * 100)}% round the lap`);

  W.map = {
    title: 'Track map',
    description: 'Where on the track you lose time: against your own laps or the car ahead, with every car on it',
    tall: true,
    mount(el) {
      const r = template(el, `
        <div class="w-map">
          <div class="w-map__modes" role="group" aria-label="Compare against">
            <button type="button" class="tool" data-ref="laps" aria-pressed="false">Your laps</button>
            <button type="button" class="tool" data-ref="ahead" aria-pressed="false">Car ahead</button>
          </div>
          <svg class="w-map__svg" viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-label="Track map"><g data-ref="segs"></g><g data-ref="dots"></g></svg>
          <p class="w-map__sum" data-ref="sum"></p>
          <p class="w-map__msg" data-ref="msg" hidden></p>
        </div>`);
      let fit = null; // the outline's scale and offset, worked out once per outline
      let fitFor = null;
      let segs = [];
      let shownLoss;
      let chosen = null; // the driver's pick; until then the car ahead in a race, your laps otherwise
      const dots = new Map();
      let last = null;

      for (const mode of ['laps', 'ahead']) {
        r[mode].addEventListener('click', () => {
          chosen = mode;
          shownLoss = undefined;
          if (last) paint(last);
        });
      }

      function place(outline) {
        const xs = outline.map((p) => p[0]);
        const zs = outline.map((p) => p[1]);
        const minX = Math.min(...xs);
        const minZ = Math.min(...zs);
        const spanX = Math.max(...xs) - minX;
        const spanZ = Math.max(...zs) - minZ;
        const k = (SIZE - 2 * PAD) / (Math.max(spanX, spanZ) || 1);
        const offX = (SIZE - spanX * k) / 2;
        const offZ = (SIZE - spanZ * k) / 2;
        return (x, z) => [(x - minX) * k + offX, (z - minZ) * k + offZ];
      }

      // One short line per outline point, so each stretch of the lap can take its own colour.
      function drawTrack(outline) {
        segs = outline.map((p, i) => {
          const [x1, y1] = fit(p[0], p[1]);
          const q = outline[(i + 1) % outline.length];
          const [x2, y2] = fit(q[0], q[1]);
          const seg = document.createElementNS(NS, 'line');
          seg.setAttribute('x1', x1.toFixed(1));
          seg.setAttribute('y1', y1.toFixed(1));
          seg.setAttribute('x2', x2.toFixed(1));
          seg.setAttribute('y2', y2.toFixed(1));
          seg.setAttribute('class', 'w-map__seg');
          return seg;
        });
        r.segs.replaceChildren(...segs);
      }

      // The colours and the line under the map, for the comparison picked.
      function paint(loss) {
        const hasAhead = !!(loss && loss.ahead);
        const mode = chosen || (hasAhead ? 'ahead' : 'laps');
        r.laps.classList.toggle('is-active', mode === 'laps');
        r.ahead.classList.toggle('is-active', mode === 'ahead');
        r.laps.setAttribute('aria-pressed', String(mode === 'laps'));
        r.ahead.setAttribute('aria-pressed', String(mode === 'ahead'));
        const cmp = loss && loss[mode];
        const sectors = cmp && Array.isArray(cmp.sectors) ? cmp.sectors : null;
        const big = sectors ? Math.max(SCALE_MS, ...sectors.map(Math.abs)) : 1;
        segs.forEach((seg, i) => {
          const v = sectors ? sectors[Math.min(sectors.length - 1, Math.floor(((i + 0.5) / segs.length) * sectors.length))] : 0;
          const kind = v > EVEN_MS ? ' is-lost' : v < -EVEN_MS ? ' is-gained' : '';
          seg.setAttribute('class', `w-map__seg${kind}`);
          if (kind) seg.setAttribute('stroke-opacity', Math.min(1, 0.4 + (Math.abs(v) / big) * 0.6).toFixed(2));
          else seg.removeAttribute('stroke-opacity');
        });
        if (!cmp) {
          setText(r.sum, mode === 'ahead' ? 'Needs a clean lap from you and from the car ahead.' : 'Needs two clean laps (no pit stop or safety car).');
          return;
        }
        const total = sectors.reduce((a, b) => a + b, 0);
        const vs = mode === 'ahead' ? (cmp.name || 'the car ahead') : 'your laps before';
        const lead = Math.abs(total) < EVEN_MS ? `Level with ${vs}` : `${s1(total)}s ${total > 0 ? 'slower' : 'faster'} than ${vs}`;
        setText(r.sum, cmp.worst ? `${lead} - most lost ${where(cmp.worst)} (${s1(cmp.worst.ms)}s)` : `${lead} - nowhere slower`);
      }

      return (s) => {
        const m = s.map;
        const outline = m && m.outline;
        r.msg.hidden = !!outline;
        r.sum.hidden = !outline;
        if (!outline) {
          setText(r.msg, 'The track is drawn from your first clean lap (not through the pits).');
          r.segs.replaceChildren();
          segs = [];
          r.dots.replaceChildren();
          dots.clear();
          fit = null;
          fitFor = null;
          shownLoss = undefined;
          return;
        }
        if (fitFor !== outline) {
          fitFor = outline;
          fit = place(outline);
          drawTrack(outline);
          shownLoss = undefined;
        }
        last = m.loss || null;
        if (shownLoss !== last) {
          shownLoss = last;
          paint(last);
        }
        const me = (m.cars || []).find((c) => c.you);
        const live = new Set();
        for (const c of m.cars || []) {
          if (!isNum(c.x) || !isNum(c.z)) continue;
          live.add(c.idx);
          let d = dots.get(c.idx);
          if (!d) {
            d = document.createElementNS(NS, 'circle');
            r.dots.appendChild(d);
            dots.set(c.idx, d);
          }
          const [px, pz] = fit(c.x, c.z);
          d.setAttribute('cx', px.toFixed(1));
          d.setAttribute('cy', pz.toFixed(1));
          d.setAttribute('r', c.you ? '3.4' : '2.5');
          const rel = !me || c.you || !isNum(c.position) || !isNum(me.position) ? '' : c.position < me.position ? ' is-ahead' : ' is-behind';
          d.setAttribute('class', `w-map__car${c.you ? ' is-you' : ''}${rel}${c.pit ? ' is-pit' : ''}`);
        }
        for (const [idx, d] of dots) {
          if (!live.has(idx)) {
            d.remove();
            dots.delete(idx);
          }
        }
        if (me && dots.get(me.idx)) r.dots.appendChild(dots.get(me.idx)); // you on top
      };
    },
  };
})();
