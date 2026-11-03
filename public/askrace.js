// Ask the race: the desktop app's place for questions to a local model about your saved races
// (roadmap L3-L5). The model runs through Ollama on this PC, only when asked, never while the game
// is sending telemetry. L3: getting Ollama and the models, with a download manager on the right.
// Downloads run in the app's main process, so they carry on when you leave this page; it only
// shows them. Only in the app window.
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
  // "1.0 of 2.0 GB": the done part in the total's unit.
  const ofText = (done, total) => (total >= 1e9 ? `${(done / 1e9).toFixed(1)} of ${gb(total)}` : `${Math.round(done / 1e6)} of ${gb(total)}`);
  const pct = (f) => `${Math.round(f * 100)}%`;
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
      const manager = h('aside', { class: 'llm__dls', 'aria-label': 'Downloads' });
      frame.replaceChildren(h('div', { class: 'llm' }, h('div', { class: 'llm__main' }, notice, live, error, body), manager));

      let status = null;
      let catalog = [];
      let have = new Set();
      let downloads = []; // the app's list: { model, state, fraction, completed, total, error }
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
      const nameOf = (id) => (catalog.find((m) => m.id === id) || { name: id }).name;
      const downloading = (id) => downloads.find((d) => d.model === id && d.state === 'downloading');

      async function refresh() {
        if (!api || !api.llm) {
          body.replaceChildren(h('p', { class: 'ana__empty' }, 'Ask the race needs the Windows app.'));
          return;
        }
        status = await act(() => api.llm.status());
        if (status && status.installed) {
          catalog = (await act(() => api.llm.catalog())) || [];
          have = new Set(((await act(() => api.llm.models())) || []).map((m) => m.name));
          downloads = (await act(() => api.llm.downloads())) || [];
        }
        draw();
      }

      function startDownload(id) {
        error.hidden = true;
        // How it goes shows in the manager; only a refusal before it starts (racing) is an error here.
        api.llm.pull(id).catch((err) => {
          if (/cancelled/i.test(reason(err)) || downloads.some((d) => d.model === id)) return;
          error.textContent = reason(err);
          error.hidden = false;
        });
      }

      function modelRow(m) {
        const d = downloading(m.id);
        let actions;
        if (d) {
          actions = [h('progress', { class: 'llm__progress', max: 1, value: d.fraction }), h('span', { class: 'llm__pct' }, pct(d.fraction))];
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
          actions = [h('button', { type: 'button', class: 'pc-btn pc-btn--primary', disabled: isLive, onclick: () => startDownload(m.id) }, 'Download')];
        }
        return h('li', { class: 'llm__model', 'data-model': m.id },
          h('div', { class: 'llm__text' },
            h('b', { class: 'llm__name' }, m.name),
            h('span', { class: 'llm__meta' }, `${m.maker} · ${gb(m.sizeBytes)} · `, h('a', { class: 'llm__licence', href: m.licenceUrl, target: '_blank', rel: 'noopener' }, m.licence)),
            h('span', { class: 'llm__note' }, m.note)),
          h('div', { class: 'llm__actions' }, actions));
      }

      // The download manager: every download this run, the running ones first.
      const STATE = { downloading: 'Downloading', done: 'Downloaded', failed: 'Failed', cancelled: 'Cancelled' };
      function drawManager() {
        const list = [...downloads].sort((a, b) => Number(b.state === 'downloading') - Number(a.state === 'downloading'));
        const finished = list.some((d) => d.state !== 'downloading');
        manager.replaceChildren(
          h('div', { class: 'llm__dls-head' }, h('h2', { class: 'llm__head' }, 'Downloads'),
            finished ? h('button', { type: 'button', class: 'pc-btn pc-btn--quiet', onclick: () => act(() => api.llm.clearDownloads()) }, 'Clear finished') : null),
          list.length
            ? h('ol', { class: 'llm__dl-list' }, list.map((d) => h('li', { class: `llm__dl is-${d.state}`, 'data-model': d.model },
              h('div', { class: 'llm__dl-top' }, h('b', {}, nameOf(d.model)), h('span', { class: 'llm__dl-state' }, d.state === 'downloading' ? pct(d.fraction) : STATE[d.state] || d.state)),
              d.state === 'downloading' ? h('progress', { class: 'llm__progress', max: 1, value: d.fraction }) : null,
              h('div', { class: 'llm__dl-foot' },
                h('span', { class: 'llm__dl-bytes' }, d.state === 'failed' ? d.error || 'Ollama stopped the download' : d.total ? ofText(d.state === 'done' ? d.total : d.completed, d.total) : 'Starting…'),
                d.state === 'downloading' ? h('button', { type: 'button', class: 'pc-btn pc-btn--quiet', onclick: () => act(() => api.llm.cancelPull(d.model)) }, 'Cancel') : null,
                d.state === 'failed' || d.state === 'cancelled' ? h('button', { type: 'button', class: 'pc-btn pc-btn--quiet', disabled: isLive, onclick: () => startDownload(d.model) }, 'Try again') : null))))
            : h('p', { class: 'llm__dl-empty' }, 'Nothing downloading. Downloads keep going if you leave this page.'));
      }

      function draw() {
        live.hidden = !isLive;
        drawManager();
        if (!status) return;
        if (!status.installed) {
          manager.hidden = true;
          body.replaceChildren(
            h('h2', { class: 'llm__head' }, 'Get Ollama first'),
            h('p', { class: 'llm__lede' }, 'Ask the race runs its models through Ollama, a free app that downloads and runs them on this PC. Install it once, then come back here to pick a model.'),
            h('div', { class: 'llm__row' },
              h('a', { class: 'pc-btn pc-btn--primary llm__get', href: status.installUrl, target: '_blank', rel: 'noopener' }, 'Get Ollama'),
              h('button', { type: 'button', class: 'pc-btn pc-btn--quiet', onclick: refresh }, 'Check again')));
          return;
        }
        manager.hidden = false;
        body.replaceChildren(
          h('h2', { class: 'llm__head' }, 'Models'),
          h('p', { class: 'llm__lede' }, `Small models that run on a 4 GB graphics card, through Ollama ${status.version}. Download one or more; each stays on this PC until you delete it.`),
          h('ol', { class: 'llm__models' }, catalog.map(modelRow)));
      }

      const off = !api || !api.llm ? () => {} : api.on('llm', (msg) => {
        if (!el.isConnected) {
          off(); // this page was left: the next visit listens for itself
          return;
        }
        if (!msg || msg.kind !== 'downloads') return;
        for (const d of msg.downloads) if (d.state === 'done') have.add(d.model);
        downloads = msg.downloads;
        draw();
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
