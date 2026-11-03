// Ask the race: the desktop app's place for questions to a local model about your saved races
// (roadmap L3-L5). The model runs through Ollama on this PC, only when asked, never while the game
// is sending telemetry. L3: getting Ollama and the models. Only in the app window.
(function () {
  'use strict';

  const desk = window.RaceDesktop;
  const api = window.undercut;
  if (!desk || !desk.placeFrame) return;
  const { widgets } = window.RaceWidgets;

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  const gb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
  const reason = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  widgets.askrace = {
    title: 'Ask the race',
    description: 'Questions about your saved races, answered by a local model',
    tall: true,
    mount(el) {
      const frame = desk.placeFrame(el, 'Ask the race');
      const notice = h('p', { class: 'llm__notice' }, 'Not for use while racing. The model runs on the graphics card the game needs, so questions and downloads are off while F1 26 is sending telemetry, and the model leaves memory as soon as it has answered.');
      const live = h('p', { class: 'llm__live', role: 'status', hidden: true }, 'The game is sending telemetry. Come back after the session.');
      const error = h('p', { class: 'pc-error', role: 'alert', hidden: true });
      const body = h('div', { class: 'llm__body' }, h('p', { class: 'ana__empty' }, 'Looking for Ollama…'));
      frame.replaceChildren(h('div', { class: 'llm' }, notice, live, error, body));

      let status = null;
      let catalog = [];
      let have = new Set();
      const progress = new Map(); // model -> fraction while downloading
      let isLive = false;

      async function act(fn) {
        error.hidden = true;
        try {
          return await fn();
        } catch (err) {
          error.textContent = reason(err);
          error.hidden = false;
          return null;
        }
      }

      async function refresh() {
        if (!api || !api.llm) {
          body.replaceChildren(h('p', { class: 'ana__empty' }, 'Ask the race needs the Windows app.'));
          return;
        }
        status = await act(() => api.llm.status());
        if (status && status.installed) {
          catalog = (await act(() => api.llm.catalog())) || [];
          have = new Set(((await act(() => api.llm.models())) || []).map((m) => m.name));
        }
        draw();
      }

      function modelRow(m) {
        const downloading = progress.has(m.id);
        const frac = progress.get(m.id) || 0;
        let actions;
        if (downloading) {
          actions = [h('progress', { class: 'llm__progress', max: 1, value: frac }), h('span', { class: 'llm__pct' }, `${Math.round(frac * 100)}%`),
            h('button', { type: 'button', class: 'pc-btn pc-btn--quiet', onclick: () => act(() => api.llm.cancelPull(m.id)) }, 'Cancel')];
        } else if (have.has(m.id)) {
          actions = [h('span', { class: 'llm__have' }, 'Downloaded'), h('button', {
            type: 'button',
            class: 'pc-btn pc-btn--quiet',
            onclick: () => act(async () => {
              if (await api.llm.remove(m.id)) have.delete(m.id);
              draw();
            }),
          }, 'Delete')];
        } else {
          actions = [h('button', {
            type: 'button',
            class: 'pc-btn pc-btn--primary',
            disabled: isLive,
            onclick: () => {
              progress.set(m.id, 0);
              draw();
              act(async () => {
                try {
                  if (await api.llm.pull(m.id)) have.add(m.id);
                } finally {
                  progress.delete(m.id);
                  draw();
                }
              });
            },
          }, 'Download')];
        }
        // Keep the progress element itself, so a redraw doesn't reset its value mid-download.
        const row = h('li', { class: 'llm__model', 'data-model': m.id },
          h('div', { class: 'llm__text' },
            h('b', { class: 'llm__name' }, m.name),
            h('span', { class: 'llm__meta' }, `${m.maker} · ${gb(m.sizeBytes)} · `, h('a', { class: 'llm__licence', href: m.licenceUrl, target: '_blank', rel: 'noopener' }, m.licence)),
            h('span', { class: 'llm__note' }, m.note)),
          h('div', { class: 'llm__actions' }, actions));
        return row;
      }

      function draw() {
        live.hidden = !isLive;
        if (!status) return;
        if (!status.installed) {
          body.replaceChildren(
            h('h2', { class: 'llm__head' }, 'Get Ollama first'),
            h('p', { class: 'llm__lede' }, 'Ask the race runs its models through Ollama, a free app that downloads and runs them on this PC. Install it once, then come back here to pick a model.'),
            h('div', { class: 'llm__row' },
              h('a', { class: 'pc-btn pc-btn--primary llm__get', href: status.installUrl, target: '_blank', rel: 'noopener' }, 'Get Ollama'),
              h('button', { type: 'button', class: 'pc-btn pc-btn--quiet', onclick: refresh }, 'Check again')));
          return;
        }
        body.replaceChildren(
          h('h2', { class: 'llm__head' }, 'Models'),
          h('p', { class: 'llm__lede' }, `Small models that run on a 4 GB graphics card, through Ollama ${status.version}. Download one or more; each stays on this PC until you delete it.`),
          h('ol', { class: 'llm__models' }, catalog.map(modelRow)));
      }

      const off = !api || !api.llm ? () => {} : api.on('llm', (msg) => {
        if (!msg || msg.kind !== 'pull' || !progress.has(msg.model)) return;
        progress.set(msg.model, msg.fraction);
        const row = [...body.querySelectorAll('.llm__model')].find((x) => x.dataset.model === msg.model);
        const bar = row && row.querySelector('progress');
        if (bar) {
          bar.value = msg.fraction;
          row.querySelector('.llm__pct').textContent = `${Math.round(msg.fraction * 100)}%`;
        }
      });
      refresh();

      return (snap) => {
        if (!el.isConnected) {
          off();
          return;
        }
        const now = snap.source === 'live' && !!snap.connected;
        if (now !== isLive) {
          isLive = now;
          draw();
        }
      };
    },
  };
})();
