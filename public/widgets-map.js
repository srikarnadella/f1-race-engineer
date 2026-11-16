// The track map: the outline the bridge learned from one of your clean laps (src/state/trackOutline.js) and every car on
// it from the Motion packet. You are the bright dot, the cars ahead of you in the race one colour and those behind another.
// Registers into window.RaceWidgets.widgets (widgets.js, which loads first, has the shared helpers).
(function () {
  'use strict';
  const { widgets: W, setText, template, isNum } = window.RaceWidgets;
  const NS = 'http://www.w3.org/2000/svg';
  const SIZE = 100;
  const PAD = 7;

  W.map = {
    title: 'Track map',
    description: 'The track drawn from your first clean lap, with every car on it: you, the cars ahead and the cars behind',
    tall: true,
    mount(el) {
      const r = template(el, `
        <div class="w-map">
          <svg class="w-map__svg" viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-label="Track map"><path class="w-map__track" data-ref="path" d=""></path><g data-ref="dots"></g></svg>
          <p class="w-map__msg" data-ref="msg" hidden></p>
        </div>`);
      let fit = null; // the outline's scale and offset, worked out once per outline
      let fitFor = null;
      const dots = new Map();

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

      return (s) => {
        const m = s.map;
        const outline = m && m.outline;
        r.msg.hidden = !!outline;
        if (!outline) {
          setText(r.msg, 'The track is drawn from your first clean lap (not through the pits).');
          r.path.setAttribute('d', '');
          r.dots.replaceChildren();
          dots.clear();
          fit = null;
          fitFor = null;
          return;
        }
        if (fitFor !== outline) {
          fitFor = outline;
          fit = place(outline);
          r.path.setAttribute('d', `M${outline.map((p) => fit(p[0], p[1]).map((v) => v.toFixed(1)).join(',')).join('L')}Z`);
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
