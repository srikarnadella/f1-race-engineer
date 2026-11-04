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

  // ---------- Charts: the engine's chart specs (src/llm/charts.js) drawn as SVG ----------
  // You in orange, the other line in blue: the Lap vs lap pair, which passes the dataviz checks.
  const SVGNS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs, ...kids) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    for (const kid of kids) el.append(kid);
    return el;
  };
  const fmt = (v) => (Math.abs(v) >= 100 ? String(Math.round(v)) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
  function ticks(lo, hi, n = 5) {
    const step = Math.pow(10, Math.floor(Math.log10((hi - lo) / n || 1)));
    const nice = [1, 2, 5, 10].map((m) => m * step).find((s) => (hi - lo) / s <= n) || step * 10;
    const out = [];
    for (let v = Math.ceil(lo / nice) * nice; v <= hi + 1e-9; v += nice) out.push(+v.toFixed(6));
    return out;
  }
  function chartView(c) {
    const W = 900;
    const H = 300;
    const pad = { l: 56, r: 16, t: 14, b: 36 };
    const all = c.series.flatMap((s) => s.points);
    const xs = all.map((p) => p[0]);
    let ys = all.map((p) => p[1]);
    // Lap times: a pit or safety-car lap would flatten the rest; the axis stops at 107% of your best.
    if (c.kind === 'lap_times') {
      const best = Math.min(...ys);
      ys = ys.map((y) => Math.min(y, best * 1.07));
    }
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    let y0 = Math.min(...ys, c.y.zero ? 0 : Infinity);
    let y1 = Math.max(...ys, c.y.zero ? 0 : -Infinity);
    if (y0 === y1) { y0 -= 1; y1 += 1; }
    const span = y1 - y0;
    if (!c.y.invert) { y0 -= span * 0.05; y1 += span * 0.05; }
    const X = (v) => pad.l + ((v - x0) / Math.max(1e-9, x1 - x0)) * (W - pad.l - pad.r);
    const Y = (v) => {
      const f = (Math.min(Math.max(v, y0), y1) - y0) / (y1 - y0);
      return c.y.invert ? pad.t + f * (H - pad.t - pad.b) : H - pad.b - f * (H - pad.t - pad.b);
    };
    const svg = sv('svg', { class: 'llm__chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${c.title}. ${c.finding}` });
    // Positions: whole places, always including your best and worst.
    const yTicks = c.y.invert ? [...new Set([y0, ...ticks(y0, y1).filter((v) => Number.isInteger(v) && v >= 1), y1])].sort((p, q) => p - q) : ticks(y0, y1);
    for (const v of yTicks) {
      svg.append(sv('line', { class: 'llm__grid', x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v) }), sv('text', { class: 'llm__tick', x: pad.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, c.y.invert ? `P${v}` : fmt(v)));
    }
    if (c.y.zero) svg.append(sv('line', { class: 'llm__zero', x1: pad.l, x2: W - pad.r, y1: Y(0), y2: Y(0) }));
    // Laps are whole numbers: no 2.5 rounded to a second "3".
    const wholeX = xs.every(Number.isInteger);
    for (const v of ticks(x0, x1, 10).filter((v) => !wholeX || Number.isInteger(v))) svg.append(sv('text', { class: 'llm__tick', x: X(v), y: H - 12, 'text-anchor': 'middle' }, String(Math.round(v))));
    svg.append(sv('text', { class: 'llm__tick', x: W - pad.r, y: H - 1, 'text-anchor': 'end' }, c.x.label));
    // Labels close together step down a line instead of overlapping.
    let lastX = -Infinity;
    let row = 0;
    for (const m of [...(c.marks || [])].sort((p, q) => p.x - q.x)) {
      row = X(m.x) - lastX < 150 ? row + 1 : 0;
      lastX = X(m.x);
      svg.append(sv('line', { class: 'llm__mark', x1: X(m.x), x2: X(m.x), y1: pad.t, y2: H - pad.b }), sv('text', { class: 'llm__mark-label', x: X(m.x) + 4, y: pad.t + 10 + (row % 3) * 16 }, m.label));
    }
    const lines = c.series.map((s, i) => {
      const color = s.you ? 'is-you' : i === 0 || c.series.length === 2 ? 'is-ref' : 'is-other';
      const step = c.kind === 'positions';
      const d = s.points.map((p, k) => `${k ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
      const g = sv('g', { class: `llm__series ${color}` }, sv('path', { d, class: 'llm__line' }));
      if (s.points.length <= 40) for (const p of s.points) g.append(sv('circle', { cx: X(p[0]), cy: Y(p[1]), r: step ? 4 : 3.5 }));
      return g;
    });
    lines.sort((a, b) => Number(a.classList.contains('is-you')) - Number(b.classList.contains('is-you'))).forEach((g) => svg.append(g));
    // Hover: the values at the nearest x, for every line.
    const cross = sv('line', { class: 'llm__cross', y1: pad.t, y2: H - pad.b, visibility: 'hidden' });
    svg.append(cross);
    const readout = h('p', { class: 'llm__readout' }, ' ');
    svg.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const vx = x0 + (((e.clientX - rect.left) / rect.width) * W - pad.l) / (W - pad.l - pad.r) * (x1 - x0);
      const near = c.series.map((s) => s.points.reduce((a, p) => (Math.abs(p[0] - vx) < Math.abs(a[0] - vx) ? p : a), s.points[0]));
      cross.setAttribute('x1', X(near[0][0]));
      cross.setAttribute('x2', X(near[0][0]));
      cross.setAttribute('visibility', 'visible');
      readout.textContent = `${c.x.label} ${Math.round(near[0][0])}: ${c.series.map((s, i) => `${s.name} ${c.y.invert ? `P${near[i][1]}` : fmt(near[i][1])}`).join(' · ')}`;
    });
    svg.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); readout.textContent = ' '; });
    const legend = c.series.length > 1 ? h('p', { class: 'llm__legend' }, c.series.map((s, i) => h('span', {}, h('i', { class: `llm__key ${s.you ? 'is-you' : i === 0 || c.series.length === 2 ? 'is-ref' : 'is-other'}` }), s.name))) : null;
    return h('figure', { class: 'llm__figure' },
      h('figcaption', {}, h('b', { class: 'llm__chart-title' }, c.title), h('span', { class: 'llm__finding' }, c.finding)),
      legend,
      h('p', { class: 'llm__axis' }, `${c.y.label}${c.kind === 'lap_times' ? ' · slower than 107% of your best is cut off at the top' : ''}`),
      svg, readout);
  }

  // The conversation outlives the page: leave Ask the race and come back, and it's still there.
  const chatState = { thread: null, sessionId: null };

  widgets.askrace = {
    title: 'Ask the race',
    description: 'Questions about your saved races, answered by a local model',
    tall: true,
    mount(el) {
      const frame = desk.placeFrame(el, 'Ask the race');
      const error = h('p', { class: 'pc-error llm__error', role: 'alert', hidden: true });

      let status = null;
      let catalog = [];
      let have = new Set();
      let downloads = []; // the app's list: { model, state, fraction, completed, total, error }
      let isLive = false;
      let sessions = [];
      let busy = false;
      let model = null; // the model answering
      let view = null; // 'chat' | 'models'

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
      const mine = () => catalog.filter((m) => have.has(m.id));

      // ---------- The chat ----------
      const sessionPick = h('select', { class: 'llm__session', 'aria-label': 'Session to ask about', onchange: () => sessionChanged() });
      const modelBtn = h('button', { type: 'button', class: 'llm__model-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => toggleMenu() });
      const menu = h('div', { class: 'llm__menu', role: 'menu', hidden: true });
      const bar = h('div', { class: 'llm__bar' },
        h('label', { class: 'llm__ctx' }, h('span', {}, 'Asking about'), sessionPick),
        h('div', { class: 'llm__switch' }, modelBtn, menu));
      const notice = h('p', { class: 'llm__notice' }, 'Not for use while racing: the model runs on the graphics card the game needs. It loads only to answer, and leaves memory straight after.');
      const live = h('p', { class: 'llm__live', role: 'status', hidden: true }, 'F1 26 is sending telemetry, so questions are off. Ask after the session.');
      const thread = chatState.thread || (chatState.thread = h('ol', { class: 'llm__thread', 'aria-live': 'polite' }));
      const empty = h('div', { class: 'llm__empty' });
      const question = h('textarea', { class: 'llm__question', rows: 1, maxlength: 2000, placeholder: 'Ask about this session', 'aria-label': 'Question' });
      const askBtn = h('button', { type: 'button', class: 'llm__ask', onclick: () => ask(question.value) }, 'Send');
      const stopBtn = h('button', { type: 'button', class: 'llm__stop', hidden: true, onclick: () => act(() => api.llm.stop()) }, 'Stop');
      const gapPick = h('select', { class: 'llm__gap-driver', 'aria-label': 'Driver for the gap chart' });
      const chip = (label, onclick, cls = '') => h('button', { type: 'button', class: `llm__chip ${cls}`.trim(), onclick }, label);
      const charts = h('div', { class: 'llm__chips llm__chips--charts', role: 'group', 'aria-label': 'Charts' },
        h('span', { class: 'llm__chips-label' }, 'Charts'),
        chip('Lap times', () => chart('lap_times', {}), 'llm__chip--chart'),
        chip('Positions', () => chart('positions', {}), 'llm__chip--chart'),
        h('span', { class: 'llm__gap' }, chip('Gap to', () => chart('gap_to_driver', { driver: gapPick.value }), 'llm__chip--chart'), gapPick),
        chip('Best vs slowest lap', () => ask('Where did I lose time on my slowest clean lap compared with my best lap?'), 'llm__chip--chart'));
      const composer = h('div', { class: 'llm__composer' },
        charts,
        h('div', { class: 'llm__input' }, question, askBtn, stopBtn),
        h('p', { class: 'llm__fine' }, 'Answers come only from this session\'s recording. Anything in an answer the recording doesn\'t show is flagged.'));
      question.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          ask(question.value);
        }
      });
      // The box grows with the question, up to a few lines.
      question.addEventListener('input', () => {
        question.style.height = 'auto';
        question.style.height = `${Math.min(question.scrollHeight, 180)}px`;
      });
      const chatView = h('section', { class: 'llm__chat', 'aria-label': 'Ask about a session' }, bar, notice, live, thread, empty, composer);

      // ---------- Manage models ----------
      const modelsBody = h('div', { class: 'llm__models-body' }, h('p', { class: 'ana__empty' }, 'Looking for Ollama…'));
      const manager = h('aside', { class: 'llm__dls', 'aria-label': 'Downloads' });
      const backBtn = h('button', { type: 'button', class: 'llm__back', onclick: () => show('chat') }, '← Back to chat');
      const manageView = h('section', { class: 'llm__manage', 'aria-label': 'Manage models', hidden: true },
        backBtn, h('div', { class: 'llm' }, h('div', { class: 'llm__main' }, modelsBody), manager));

      frame.replaceChildren(h('div', { class: 'llm-page' }, error, chatView, manageView));

      function show(v) {
        view = v;
        chatView.hidden = v !== 'chat';
        manageView.hidden = v !== 'models';
        menu.hidden = true;
        modelBtn.setAttribute('aria-expanded', 'false');
        draw();
      }

      // The model switcher: your downloaded models, the one answering ticked, and Manage models.
      function toggleMenu(open = menu.hidden) {
        menu.hidden = !open;
        modelBtn.setAttribute('aria-expanded', String(open));
        if (open) {
          const first = menu.querySelector('button');
          if (first) first.focus();
        }
      }
      menu.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation(); // Esc closes the menu, not the place
        toggleMenu(false);
        modelBtn.focus();
      });
      document.addEventListener('click', (e) => {
        if (!menu.hidden && !menu.contains(/** @type {Node} */ (e.target)) && e.target !== modelBtn) toggleMenu(false);
      });
      function pickModel(id) {
        model = id;
        try { localStorage.setItem('undercut.llmModel', id); } catch (_) { /* fine */ }
        toggleMenu(false);
        drawChat();
      }
      function drawMenu() {
        menu.replaceChildren(
          ...mine().map((m) => h('button', { type: 'button', role: 'menuitemradio', class: 'llm__model-option', 'aria-checked': String(m.id === model), onclick: () => pickModel(m.id) },
            h('span', { class: 'llm__option-name' }, m.name), h('span', { class: 'llm__option-note' }, m.note))),
          h('button', { type: 'button', role: 'menuitem', class: 'llm__manage-btn', onclick: () => show('models') }, 'Manage models'));
      }

      const sessionName = (x) => (x ? `${x.track} ${x.type}` : '');
      const current = () => sessions.find((x) => x.session_id === Number(sessionPick.value)) || null;
      const SUGGESTED = ['What was my best lap?', 'When did I pit, and what tyres did I go onto?', 'How did my position change through the race?', 'Who finished right behind me?'];

      function drawChat() {
        const ready = mine().length > 0;
        if (ready && !mine().some((m) => m.id === model)) {
          let saved = null;
          try { saved = localStorage.getItem('undercut.llmModel'); } catch (_) { /* fine */ }
          model = mine().some((m) => m.id === saved) ? saved : mine()[0].id;
        }
        modelBtn.textContent = ready ? nameOf(model) : 'No model';
        drawMenu();
        live.hidden = !isLive;
        composer.hidden = !ready;
        const off = isLive || busy || !sessions.length;
        askBtn.disabled = off;
        askBtn.hidden = busy;
        stopBtn.hidden = !busy;
        question.disabled = isLive;
        for (const b of composer.querySelectorAll('.llm__chip')) b.disabled = off;
        // The empty state: what you can ask, until there's a conversation.
        empty.hidden = thread.children.length > 0;
        if (!ready) {
          empty.hidden = false;
          empty.replaceChildren(
            h('h2', { class: 'llm__hello' }, 'Download a model to start'),
            h('p', { class: 'llm__lede' }, status && !status.installed
              ? 'Ask the race runs its models through Ollama, a free app. Set it up once, then pick a model.'
              : 'Pick a small model that runs on this PC. It stays here until you delete it.'),
            h('button', { type: 'button', class: 'pc-btn pc-btn--primary', onclick: () => show('models') }, 'Manage models'));
        } else if (!empty.hidden) {
          empty.replaceChildren(
            h('h2', { class: 'llm__hello' }, sessions.length ? `Ask about ${sessionName(current())}` : 'No races saved yet'),
            h('p', { class: 'llm__lede' }, sessions.length
              ? 'Every answer comes from this session\'s recording, with the chart and the evidence underneath.'
              : 'Drive a session with the game\'s telemetry on; it is saved here when it ends.'),
            ...(sessions.length ? [h('div', { class: 'llm__suggest', role: 'group', 'aria-label': 'Suggested questions' }, SUGGESTED.map((q) => chip(q, () => ask(q), 'llm__chip--ask')))] : []));
          for (const b of empty.querySelectorAll('.llm__chip')) b.disabled = off;
        }
      }

      async function loadSessions() {
        sessions = (await act(() => api.llm.sessions())) || [];
        sessionPick.replaceChildren(...sessions.map((x) => h('option', { value: x.session_id }, `${sessionName(x)}${x.date ? ` · ${x.date}` : ''}${x.finish ? ` · P${x.finish}` : ''}`)));
        // Back to the session the conversation was about, else the newest race.
        // Race analysis's "Ask about this session" asks for one by track, type and day.
        const want = desk.askSession;
        desk.askSession = null;
        const asked = want && sessions.find((x) => x.track === want.track && x.type === want.type && x.date === want.date);
        const keep = asked || sessions.find((x) => x.session_id === chatState.sessionId) || sessions.find((x) => x.is_race) || sessions[0];
        if (keep) sessionPick.value = String(keep.session_id);
        chatState.sessionId = keep ? keep.session_id : null;
        await loadDrivers();
      }
      async function loadDrivers() {
        if (!sessions.length) return;
        const all = (await act(() => api.llm.results(Number(sessionPick.value)))) || [];
        const me = all.find((r) => r.you);
        const others = all.filter((r) => !r.you).sort((a, b) => (me ? Math.abs(a.position - me.position) - Math.abs(b.position - me.position) : 0) || a.position - b.position);
        gapPick.replaceChildren(...others.map((r) => h('option', { value: r.driver }, `P${r.position} ${r.driver}`)));
      }
      // A new session mid-conversation: said in the thread, so earlier answers keep their context.
      async function sessionChanged() {
        chatState.sessionId = Number(sessionPick.value);
        if (thread.children.length) thread.append(h('li', { class: 'llm__switched' }, `Now asking about ${sessionName(current())}`));
        await loadDrivers();
        drawChat();
      }

      // One exchange: your question, then the answer with its charts and what it was worked out from.
      function exchange(title) {
        const a = h('div', { class: 'llm__a' }, h('span', { class: 'llm__thinking' }, 'Working it out…'));
        const li = h('li', { class: 'llm__answer' }, h('p', { class: 'llm__q' }, title), a);
        thread.append(li);
        drawChat();
        if (li.scrollIntoView) li.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return a;
      }
      function fill(a, out, took) {
        const kids = [];
        if (out.answer != null) kids.push(h('p', { class: 'llm__reply' }, out.answer || '(no answer)'));
        if (out.fromEngine) kids.push(h('p', { class: 'llm__meta' }, 'Written by Undercut\'s analysis: the model didn\'t give a usable answer.'));
        if (out.unsupported && out.unsupported.length) kids.push(h('p', { class: 'llm__unsupported' }, `Check this: not in your data: ${out.unsupported.join(', ')}. The model wrote it; the recording doesn't show it.`));
        for (const c of out.charts || []) kids.push(chartView(c));
        if (out.evidence && out.evidence.length) kids.push(h('details', { class: 'llm__why' }, h('summary', {}, 'How this was worked out'), h('ul', { class: 'llm__evidence' }, out.evidence.map((e) => h('li', {}, e)))));
        if (took != null) kids.push(h('p', { class: 'llm__meta' }, `${out.model ? `${out.model} · ` : ''}${(took / 1000).toFixed(1)} s`));
        a.replaceChildren(...kids);
      }

      async function ask(text) {
        const q = String(text || '').trim();
        if (!q || busy || isLive || !sessions.length || !model) return;
        busy = true;
        question.value = '';
        question.style.height = '';
        const a = exchange(q);
        const t0 = Date.now();
        try {
          const out = await api.llm.ask(model, Number(sessionPick.value), q);
          fill(a, { ...out, model: nameOf(model) }, Date.now() - t0);
        } catch (err) {
          a.replaceChildren(h('p', { class: 'pc-error' }, reason(err)));
        } finally {
          busy = false;
          drawChat();
          question.focus();
        }
      }

      // A chart command: straight from the data, no model.
      async function chart(kind, args) {
        if (isLive || !sessions.length) return;
        const a = exchange(kind === 'gap_to_driver' ? `Chart: gap to ${args.driver}` : `Chart: ${kind.replace('_', ' ')}`);
        try {
          const c = await api.llm.chart(Number(sessionPick.value), kind, args);
          if (c.error) a.replaceChildren(h('p', { class: 'llm__reply' }, c.error));
          else fill(a, { charts: [c] }, null);
        } catch (err) {
          a.replaceChildren(h('p', { class: 'pc-error' }, reason(err)));
        }
      }

      // ---------- Models and downloads ----------
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
          actions = [h('span', { class: 'llm__have' }, m.id === model ? 'Selected' : 'Downloaded'), h('button', {
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

      function drawModels() {
        drawManager();
        if (!status) return;
        if (!status.installed) {
          manager.hidden = true;
          modelsBody.replaceChildren(
            h('h2', { class: 'llm__head' }, 'Get Ollama first'),
            h('p', { class: 'llm__lede' }, 'Ask the race runs its models through Ollama, a free app that downloads and runs them on this PC. Install it once, then come back here to pick a model.'),
            h('div', { class: 'llm__row' },
              h('a', { class: 'pc-btn pc-btn--primary llm__get', href: status.installUrl, target: '_blank', rel: 'noopener' }, 'Get Ollama'),
              h('button', { type: 'button', class: 'pc-btn pc-btn--quiet', onclick: refresh }, 'Check again')));
          return;
        }
        manager.hidden = false;
        modelsBody.replaceChildren(
          h('h2', { class: 'llm__head' }, 'Models'),
          h('p', { class: 'llm__lede' }, `Small models that run on a 4 GB graphics card, through Ollama ${status.version}. Download one or more; each stays on this PC until you delete it. Pick which one answers from the switcher in the chat.`),
          ...(isLive ? [h('p', { class: 'llm__live' }, 'F1 26 is sending telemetry, so downloads wait until the session ends.')] : []),
          h('ol', { class: 'llm__models' }, catalog.map(modelRow)));
      }

      function draw() {
        drawChat();
        drawModels();
        backBtn.hidden = !mine().length;
      }

      async function refresh() {
        if (!api || !api.llm) {
          chatView.hidden = true;
          manageView.hidden = false;
          modelsBody.replaceChildren(h('p', { class: 'ana__empty' }, 'Ask the race needs the Windows app.'));
          return;
        }
        status = await act(() => api.llm.status());
        if (status && status.installed) {
          catalog = (await act(() => api.llm.catalog())) || [];
          have = new Set(((await act(() => api.llm.models())) || []).map((m) => m.name));
          downloads = (await act(() => api.llm.downloads())) || [];
          await loadSessions();
        }
        // Straight to the models when there's nothing to ask with yet.
        if (!view) show(status && status.installed && mine().length ? 'chat' : 'models');
        else draw();
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
