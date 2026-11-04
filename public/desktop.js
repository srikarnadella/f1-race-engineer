// The desktop app's own screens - Connect (the game, other devices,
// recording) and Library (saved sessions and recordings) - and voice
// questions through Windows' speech recognizer. All of it only runs inside
// the Undercut app window, where desktop/preload.js defines window.undercut;
// a phone or browser on the Wi-Fi gets the dashboard without any of it.
(function () {
  'use strict';

  const api = window.undercut;
  if (!api) return;
  const { widgets, setText } = window.RaceWidgets;

  // ---------- Small helpers ----------
  // h('p', { class: 'x', onclick }, 'text', child) - text is always set as text, never as HTML.
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
  const button = (label, onclick, cls = '') => h('button', { type: 'button', class: `pc-btn ${cls}`.trim(), onclick }, label);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const bytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
  const when = (ms) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const lapTime = (ms) => (ms > 0 ? `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}` : null);
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const duration = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.max(1, Math.round(s / 60))} min`);
  // A recording's folder name is its start, local time: 2026-10-20_180121.
  function recordingStart(name) {
    const m = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)(\d\d)(\d\d)$/.exec(name || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
  }
  // Errors from the PC come back as "Error invoking remote method 'x': Error: <what happened>".
  const reason = (err) => String((err && err.message) || err).replace(/^.*Error: /, '');

  // ---------- The app's status (desktop/main.js), pushed on change ----------
  let status = null;
  const watchers = new Set();
  function setStatus(s) {
    status = s;
    for (const fn of watchers) fn(s);
  }
  api.on('status', setStatus);
  const refreshStatus = () => api.status().then(setStatus, () => {});
  refreshStatus();

  // ---------- Voice questions: Windows' recognizer behind the browser's interface ----------
  // voice.js uses the Web Speech API. Electron has no recognition service
  // behind it, so the window gets a stand-in with the same shape, fed by the
  // offline recognizer in the main process (desktop/speech.js).
  const SILENCE_GRACE_MS = 2500; // a timeout from before this question started isn't silence
  let activeRec = null;
  api.on('speech', (msg) => { if (activeRec) activeRec.line(msg); });
  function customPhrases() {
    try {
      const saved = JSON.parse(localStorage.getItem('raceEngineer.commands') || '[]');
      return Array.isArray(saved) ? saved.map((c) => c && c.phrase).filter((p) => typeof p === 'string') : [];
    } catch (_) {
      return [];
    }
  }
  class DesktopRecognition {
    constructor() {
      this.lang = 'en-US';
      this.continuous = false;
      this.interimResults = false;
      this.maxAlternatives = 1;
      /** @type {((e: any) => void) | null} */
      this.onresult = null;
      /** @type {((e: any) => void) | null} */
      this.onerror = null;
      /** @type {(() => void) | null} */
      this.onend = null;
      this.on = false;
      this.startedAt = 0;
    }
    start() {
      if (activeRec && activeRec !== this) activeRec.abort();
      activeRec = this;
      this.on = true;
      this.startedAt = Date.now();
      api.speech.start(customPhrases()).catch(() => this.fail('service-not-allowed'));
    }
    line(msg) {
      if (!this.on || msg.ready) return;
      if (msg.error) return this.fail(msg.error === 'no-microphone' ? 'audio-capture' : 'service-not-allowed');
      if (!msg.text) {
        if (!this.continuous && Date.now() - this.startedAt > SILENCE_GRACE_MS) this.end();
        return;
      }
      const guesses = [...new Set([msg.text, ...(msg.alternates || [])])];
      const result = Object.assign(guesses.map((transcript) => ({ transcript, confidence: msg.confidence })), { isFinal: true });
      if (this.onresult) this.onresult({ results: [result], resultIndex: 0 });
      if (!this.continuous) this.end();
    }
    fail(error) {
      if (this.onerror) this.onerror({ error });
      this.end();
    }
    end() {
      if (!this.on) return;
      this.on = false;
      if (activeRec === this) {
        activeRec = null;
        api.speech.stop().catch(() => {});
      }
      if (this.onend) this.onend();
    }
    stop() { this.end(); }
    abort() { this.end(); }
  }
  window.SpeechRecognition = DesktopRecognition;

  // Switch screens (app.js listens).
  const go = (id) => document.dispatchEvent(new CustomEvent('undercut:show', { detail: id }));

  // A place of its own (Race analysis, Storage, Connect): fills the window, no dashboard rail,
  // a way back Home (Esc too, in app.js). Returns the element the place's content goes in.
  function placeFrame(el, title) {
    const body = h('div', { class: 'place__body' });
    el.replaceChildren(h('div', { class: 'place' },
      h('header', { class: 'place__head' },
        h('button', { type: 'button', class: 'place__back', onclick: () => go('home') }, '← Home'),
        h('h1', { class: 'place__title' }, title)),
      body));
    return body;
  }

  // Saved sessions on disk past the 10 the snapshot carries (G3), newest first; [] if the bridge can't say.
  async function olderSessions() {
    try {
      const res = await fetch('/api/debrief/older');
      const out = res.ok ? await res.json() : null;
      return (out && out.sessions) || [];
    } catch (_) {
      return [];
    }
  }
  // The snapshot's sessions, then the older ones it doesn't already have.
  const withOlder = (list, older) => list.concat(older.filter((o) => !list.some((x) => x.id === o.id)));

  // ---------- Connect ----------
  widgets.connect = {
    title: 'Connect',
    description: 'The game, other devices and recording - on this PC only',
    tall: true,
    mount(place) {
      const el = placeFrame(place, 'Connect and record');
      const st = {
        modeText: h('p', { class: 'pc-mode__text' }),
        state: h('h2', { class: 'pc-game__state' }, 'Waiting for F1 26'),
        lede: h('p', { class: 'pc-game__lede' }),
        steps: h('ol', { class: 'pc-steps' }),
        facts: h('div', { class: 'pc-facts' }),
        demo: button('Watch the demo race', () => act(() => { keepScreen('drive'); return api.replay('demo'); })),
        drive: button('Go to Drive', () => go('drive'), 'pc-btn--primary'),
        recBtn: button('Record this session', () => toggleRecord(), 'pc-btn--rec'),
        recText: h('p', { class: 'pc-rec__text' }),
        recTime: h('span', { class: 'pc-rec__time' }),
        qr: h('img', { class: 'pc-share__qr', alt: 'QR code of the dashboard address', width: 220, height: 220 }),
        url: h('p', { class: 'pc-share__url' }),
        devices: h('p', { class: 'pc-share__devices' }),
        shareOff: h('p', { class: 'pc-share__off' }, 'Only this PC can open the dashboard right now. Turn on sharing to put it on a phone, tablet or laptop on the same Wi-Fi.'),
        share: h('input', { type: 'checkbox', onchange: (e) => act(() => { keepScreen(); return api.setSettings({ share: e.target.checked }); }) }),
        voice: h('input', { type: 'checkbox', onchange: (e) => act(() => { keepScreen(); return api.setSettings({ phoneVoice: e.target.checked }); }) }),
        voiceNote: h('p', { class: 'pc-share__note' }),
        error: h('p', { class: 'pc-error', role: 'alert', hidden: true }),
      };
      const mode = h('div', { class: 'pc-mode', hidden: true }, st.modeText, button('Back to live', () => act(() => { keepScreen(); return api.live(); }), 'pc-btn--primary'));
      const shareBlock = h('div', { class: 'pc-share__code' }, st.qr, h('div', {}, st.url, st.devices));
      el.replaceChildren(h('div', { class: 'pc pc-connect' },
        mode,
        h('section', { class: 'pc-game' }, st.state, st.lede, st.steps, st.facts, h('div', { class: 'pc-actions' }, st.drive, st.demo, button('Open in your browser', () => act(() => api.openInBrowser()), 'pc-btn--quiet'))),
        h('section', { class: 'pc-rec' },
          h('div', { class: 'pc-rec__head' }, h('h3', {}, 'Record a session'), st.recTime),
          st.recText,
          st.recBtn),
        h('section', { class: 'pc-share' },
          h('h3', {}, 'Other devices'),
          shareBlock,
          st.shareOff,
          h('label', { class: 'pc-toggle' }, st.share, h('span', {}, h('b', {}, 'Share on this Wi-Fi'), h('span', { class: 'dim' }, 'Phones, tablets and laptops on the same network can open the dashboard.'))),
          h('label', { class: 'pc-toggle' }, st.voice, h('span', {}, h('b', {}, 'Voice questions on phones'), h('span', { class: 'dim' }, 'Serves the dashboard over https, which phones need before they open the microphone.'))),
          st.voiceNote),
        st.error));

      async function act(fn) {
        st.error.hidden = true;
        try {
          const s = await fn();
          if (s && s.settings) setStatus(s);
        } catch (err) {
          setText(st.error, reason(err));
          st.error.hidden = false;
        }
      }
      function toggleRecord() {
        act(() => (status && status.recording ? api.stopRecording() : api.record()));
      }

      const STEPS = [
        'In F1 26, open Settings, then Telemetry Settings.',
        'Set UDP Telemetry to On, and UDP Format to 2025 or later.',
        'Set UDP Port to the port below, and the send rate to 20 Hz or more.',
        'Playing on a console or another PC? Set UDP IP Address to this PC\'s address.',
      ];
      let sig = '';
      function draw(s) {
        if (!status) return;
        const live = !!(s && s.connected);
        const replaying = status.mode === 'replay';
        const feed = (s && s.feed) || {};
        const key = JSON.stringify([live, replaying, status.replay, status.recording, status.settings, status.pairUrl, status.clients, feed.rateHz, feed.lossPct, status.addresses]);
        if (key === sig) return;
        sig = key;

        mode.hidden = !replaying;
        setText(st.modeText, replaying ? `Replaying ${status.replay.label}. Nothing is recorded or saved while it plays.` : '');
        setText(st.state, replaying ? 'Replay running' : live ? 'Receiving telemetry' : 'Waiting for F1 26');
        st.state.className = `pc-game__state ${replaying ? 'is-info' : live ? 'is-good' : 'is-watch'}`;
        setText(st.lede, replaying
          ? 'The screens show the recording as if it were live. Go back to live before your next race.'
          : live
            ? 'The engineer is on. Leave this window open, or switch to Drive.'
            : 'Undercut listens on this PC. Turn on the game\'s telemetry and the screens fill in as soon as you are on track.');
        st.steps.hidden = live || replaying;
        st.steps.replaceChildren(...STEPS.map((t) => h('li', {}, t)));
        const port = status.settings.udpPort;
        const lan = status.addresses[0];
        st.facts.replaceChildren(
          fact('Telemetry port', String(port)),
          fact('This PC', lan || 'No network'),
          ...(live ? [fact('Arriving', feed.rateHz ? `${Math.round(feed.rateHz)} a second` : '-'), fact('Lost', feed.lossPct != null ? `${feed.lossPct}%` : '-')] : []),
        );
        st.demo.hidden = live || replaying;
        st.drive.hidden = !live;

        // Recording
        const rec = status.recording;
        st.recBtn.hidden = replaying;
        setText(st.recBtn, rec ? 'Stop recording' : 'Record this session');
        st.recBtn.classList.toggle('is-on', !!rec);
        setText(st.recText, replaying
          ? 'Recording is for live sessions.'
          : rec
            ? 'Every packet and every call is being saved. Tap MARK (or press M) when a call looks wrong, or you lock up or spin.'
            : 'Saves every packet and every call, so you can replay the race later and see why the engineer said what it did. About 300 MB a race.');

        // Other devices
        const shared = status.settings.share;
        shareBlock.hidden = !shared || !status.pairUrl;
        st.shareOff.hidden = shared && !!status.pairUrl;
        if (shared && !status.pairUrl) setText(st.shareOff, 'This PC isn\'t on a network right now, so nothing else can reach it.');
        else if (!shared) setText(st.shareOff, 'Only this PC can open the dashboard right now. Turn on sharing to put it on a phone, tablet or laptop on the same Wi-Fi.');
        if (status.pairUrl) {
          setText(st.url, status.pairUrl);
          st.qr.src = `/api/qr?u=${encodeURIComponent(status.pairUrl)}`;
        }
        const others = Math.max(0, status.clients - 1); // this window is a client too
        setText(st.devices, others ? `${plural(others, 'other device')} connected` : 'Scan with a phone camera, or type the address.');
        st.share.checked = shared;
        st.voice.checked = status.settings.phoneVoice;
        st.voice.disabled = !shared;
        setText(st.voiceNote, status.settings.phoneVoice && shared
          ? 'The first time, the phone warns that the connection isn\'t private: the certificate is made by this PC, not a company. Tap Advanced, then Proceed. Voice works after that.'
          : '');
        st.voiceNote.hidden = !(status.settings.phoneVoice && shared);
      }
      const fact = (label, value) => h('div', { class: 'pc-fact' }, h('span', { class: 'dim' }, label), h('b', {}, value));

      // The recording clock ticks on its own; everything else follows the status.
      let last = null;
      const tick = setInterval(() => {
        const t0 = status && status.recording ? recordingStart(status.recording) : null;
        setText(st.recTime, t0 ? `Recording ${clock((Date.now() - t0) / 1000)}` : '');
        if (el.isConnected) refreshStatus();
        else clearInterval(tick);
      }, 1000);
      const watch = () => draw(last);
      watchers.add(watch);
      return (s) => {
        last = s;
        if (!el.isConnected) watchers.delete(watch);
        draw(s);
      };
    },
  };

  // ---------- Library ----------
  widgets.library = {
    title: 'Storage',
    description: 'Every saved session and recording on this PC',
    tall: true,
    mount(place) {
      const el = placeFrame(place, 'Storage');
      const st = {
        summary: h('p', { class: 'pc-lib__summary' }),
        sessions: h('ul', { class: 'pc-list' }),
        sessionsNote: h('p', { class: 'pc-list__empty dim' }),
        captures: h('ul', { class: 'pc-list' }),
        capturesNote: h('p', { class: 'pc-list__empty dim' }),
        error: h('p', { class: 'pc-error', role: 'alert', hidden: true }),
        disk: h('section', { class: 'disk', 'aria-label': 'Disk use' }),
      };
      el.replaceChildren(h('div', { class: 'pc pc-lib' },
        h('header', { class: 'pc-lib__head' },
          h('div', {}, st.summary),
          button('Open data folder', () => act(() => api.openDataFolder()), 'pc-btn--quiet')),
        st.error,
        st.disk,
        h('div', { class: 'pc-lib__cols' },
          h('section', { class: 'pc-lib__col' }, h('h3', {}, 'Saved sessions'), h('p', { class: 'dim' }, 'Each one opens in Race analysis: the result, every lap, lap compare and the calls audit.'), st.sessionsNote, st.sessions),
          h('section', { class: 'pc-lib__col' }, h('h3', {}, 'Recordings'), h('p', { class: 'dim' }, 'Every packet of a session. Replay one through the screens, or analyze it to check each call.'), st.capturesNote, st.captures))));

      let captures = null;
      let sessions = [];
      let older = [];
      let lastList = [];
      let lastReplaying = false;
      const open = new Set(); // recordings with their report shown
      async function act(fn) {
        st.error.hidden = true;
        try {
          return await fn();
        } catch (err) {
          setText(st.error, reason(err));
          st.error.hidden = false;
          return null;
        }
      }
      // Disk use per store (W3), largest first; a store with nothing in it drops out.
      const STORES = [['captures', 'Recordings', 'every packet of each recorded session'], ['raceDb', 'Race store', 'the laps of every car in every session'], ['sessions', 'Saved sessions', 'the debriefs Race analysis opens'], ['other', 'Other', 'the demo race and track notes']];
      async function loadDisk() {
        if (!api.diskUse) return;
        const found = await act(() => api.diskUse());
        if (!found) return;
        const use = { ...found };
        // Ask the race's models live in Ollama's own folder; a row of their own when there are any.
        let models = [];
        try {
          models = api.llm && api.llm.models ? (await api.llm.models()) || [] : [];
        } catch (_) { /* Ollama not running: no row */ }
        const stores = [...STORES];
        if (models.length) {
          use.models = models.reduce((n, m) => n + (m.size || 0), 0);
          use.total += use.models;
          stores.push(['models', 'Models', `${models.length} model${models.length === 1 ? '' : 's'}, kept by Ollama (delete them in Ask the race)`]);
        }
        const rows = stores.filter(([k]) => use[k] > 0).sort((a, b) => use[b[0]] - use[a[0]]);
        st.disk.replaceChildren(
          h('p', { class: 'disk__total' }, `${bytes(use.total)} on this PC`),
          h('ul', { class: 'disk__rows' }, rows.map(([k, label, what]) => h('li', { class: 'disk__row' },
            h('b', { class: 'disk__name' }, label),
            h('span', { class: 'disk__what' }, what),
            h('span', { class: 'disk__bar', 'aria-hidden': 'true' }, h('i', { style: `width: ${Math.max(0.5, (use[k] / Math.max(1, use.total)) * 100)}%` })),
            h('span', { class: 'disk__size' }, bytes(use[k]))))));
      }

      async function loadCaptures() {
        captures = (await act(() => api.captures())) || captures || [];
        drawCaptures();
        drawSummary();
      }

      function drawSummary() {
        const total = (captures || []).reduce((n, c) => n + c.bytes, 0);
        setText(st.summary, `${plural(sessions.length, 'saved session')} · ${plural((captures || []).length, 'recording')}${total ? `, ${bytes(total)}` : ''}. Everything stays on this PC.`);
      }

      let sessionSig = '';
      function drawSessions(list, replaying) {
        lastList = list;
        lastReplaying = replaying;
        sessions = (replaying ? list : withOlder(list, older)).filter((d) => !d.live);
        const key = JSON.stringify([replaying, sessions.map((d) => [d.id, d.finish, d.laps.length])]);
        if (key === sessionSig) return;
        sessionSig = key;
        setText(st.sessionsNote, replaying
          ? 'Showing the replay. Go back to live (Connect) to see and manage your saved sessions.'
          : sessions.length ? '' : 'Nothing saved yet. A session is saved here when it ends.');
        st.sessionsNote.hidden = !st.sessionsNote.textContent;
        st.sessions.replaceChildren(...sessions.map((d) => {
          const title = [d.track, d.sessionName].filter(Boolean).join(' ');
          const result = d.finish ? `P${d.finish}${d.grid ? ` from P${d.grid}` : ''}` : null;
          const best = d.bestLap ? `best ${lapTime(d.bestLap.ms)}` : null;
          return h('li', { class: 'pc-row' },
            h('div', { class: 'pc-row__text' },
              h('b', { class: 'pc-row__title' }, title || 'Session'),
              h('span', { class: 'pc-row__meta' }, [when(d.startedAt), result, plural(d.laps.length, 'lap'), best].filter(Boolean).join(' · '))),
            h('div', { class: 'pc-row__actions' },
              button('Open in Race analysis', () => {
                window.RaceDesktop.analysisSession = d.id; // analysis.js opens on it
                window.RaceDebrief.openSession(d.id);
                go('analysis');
              }, 'pc-btn--primary'),
              replaying ? null : button('Delete', () => act(async () => {
                if (await api.deleteSession(d.id, `${title}, ${when(d.startedAt)}`)) {
                  sessionSig = '';
                  sessions = sessions.filter((x) => x.id !== d.id);
                  older = older.filter((x) => x.id !== d.id);
                  drawSummary();
                  drawSessions(lastList.filter((x) => x.id !== d.id), lastReplaying);
                  loadDisk();
                }
              }), 'pc-btn--quiet')));
        }));
        drawSummary();
      }

      function drawCaptures() {
        if (!captures) return;
        const s = status || {};
        const replaying = s.mode === 'replay' ? s.replay.name : null;
        const analyzing = new Set(s.analyzing || []);
        setText(st.capturesNote, captures.length ? '' : 'No recordings yet. Record one from Connect.');
        st.capturesNote.hidden = !!captures.length;
        st.captures.replaceChildren(...captures.map((c) => {
          const title = [c.track, c.session].filter(Boolean).join(' ') || c.name;
          const isRecording = s.recording === c.name;
          const meta = [when(c.startedAt), c.report && c.report.durationS ? duration(c.report.durationS) : null, bytes(c.bytes), c.marks ? plural(c.marks, 'mark') : null].filter(Boolean).join(' · ');
          const row = h('li', { class: `pc-row${isRecording ? ' is-recording' : ''}` },
            h('div', { class: 'pc-row__text' }, h('b', { class: 'pc-row__title' }, title), h('span', { class: 'pc-row__meta' }, isRecording ? 'Recording now' : meta)),
            isRecording ? null : h('div', { class: 'pc-row__actions' },
              replaying === c.name
                ? button('Stop replay', () => act(() => { keepScreen(); return api.live(); }), 'pc-btn--primary')
                : button('Replay', () => act(() => { keepScreen('drive'); return api.replay(c.name); }), 'pc-btn--primary'),
              analyzing.has(c.name)
                ? h('span', { class: 'pc-row__busy' }, 'Analyzing…')
                : c.report
                  ? button(open.has(c.name) ? 'Hide report' : 'Report', () => { open.has(c.name) ? open.delete(c.name) : open.add(c.name); drawCaptures(); }, 'pc-btn--quiet')
                  : button('Analyze', () => act(async () => {
                    const report = await api.analyze(c.name);
                    if (report) {
                      c.report = report;
                      open.add(c.name);
                      drawCaptures();
                    }
                  }), 'pc-btn--quiet'),
              button('Show file', () => act(() => api.showCapture(c.name)), 'pc-btn--quiet'),
              button('Delete', () => act(async () => {
                if (await api.deleteCapture(c.name)) {
                  captures = captures.filter((x) => x.name !== c.name);
                  drawCaptures();
                  drawSummary();
                  loadDisk();
                }
              }), 'pc-btn--quiet')));
          if (c.report && open.has(c.name)) row.append(reportView(c));
          return row;
        }));
      }

      // The analyzer's checks and the driver's marks, from report.json.
      function reportView(c) {
        const r = c.report;
        const tone = { PASS: 'is-good', WARN: 'is-watch', FAIL: 'is-act' };
        return h('div', { class: 'pc-report' },
          h('p', {}, `${plural(r.laps, 'lap')} recorded${r.durationS ? ` over ${duration(r.durationS)}` : ''}.`),
          h('ul', { class: 'pc-report__checks' }, r.checks.map((k) => h('li', {}, h('b', { class: tone[k.status] || '' }, ({ PASS: 'OK', WARN: 'Check', FAIL: 'Problem', INFO: 'Note' })[k.status] || k.status), ` ${k.name}: ${k.detail}`))),
          r.marks.length
            ? h('div', {}, h('h4', {}, 'Your marks'), h('ul', { class: 'pc-report__marks' }, r.marks.map((m) => h('li', {}, `${m.lap != null ? `Lap ${m.lap}` : clock(m.tMs / 1000)}: ${m.tag === 'mark' ? 'marked' : m.tag.replace(/-/g, ' ')}${m.note ? ` - ${m.note}` : ''}`))))
            : null,
          button('Open the full report', () => act(() => api.openReport(c.name)), 'pc-btn--quiet'));
      }

      let lastRecording = null;
      const watch = (s) => {
        // A recording that just finished joins the list.
        if (lastRecording && !s.recording) loadCaptures();
        lastRecording = s.recording;
        drawCaptures();
      };
      watchers.add(watch);
      loadCaptures();
      loadDisk();
      olderSessions().then((list) => {
        older = list;
        drawSessions(lastList, lastReplaying);
      });
      return (snap) => {
        if (!el.isConnected) {
          watchers.delete(watch);
          return;
        }
        if (snap.debrief) drawSessions(snap.debrief.sessions || [], !!(status && status.mode === 'replay'));
      };
    },
  };

  // ---------- Settings: this PC ----------
  // The ports and the data folder, under the dashboard's own settings.
  function mountSettings() {
    const sheet = document.querySelector('#settings-sheet .sheet__panel');
    if (!sheet) return;
    const http = h('input', { type: 'number', min: 1024, max: 65535, class: 'pc-port', 'aria-label': 'Dashboard port' });
    const udp = h('input', { type: 'number', min: 1024, max: 65535, class: 'pc-port', 'aria-label': 'Telemetry port' });
    const note = h('span', { class: 'dim' });
    const save = button('Save ports', async () => {
      try {
        keepScreen();
        const s = await api.setSettings({ httpPort: Number(http.value), udpPort: Number(udp.value) });
        setStatus(s);
        setText(note, s.settings.httpPort === Number(http.value) && s.settings.udpPort === Number(udp.value) ? 'Saved.' : 'Ports are 1024-65535, and the two must differ.');
      } catch (err) {
        setText(note, reason(err));
      }
    }, 'pc-btn--primary');
    const version = h('span', { class: 'dim' });
    sheet.append(h('div', { class: 'setting setting--pc' },
      h('span', { class: 'setting__text' }, h('b', {}, 'This PC'),
        h('span', { class: 'dim' }, 'The game sends telemetry to the telemetry port; phones open the dashboard port. Change them only if another program uses them.')),
      h('div', { class: 'pc-ports' }, h('label', {}, 'Dashboard port', http), h('label', {}, 'Telemetry port', udp), save, note),
      h('div', { class: 'pc-ports' }, button('Open data folder', () => api.openDataFolder(), 'pc-btn--quiet'), version)));
    // On the PC's screen Settings reads across the window, in three columns, instead of one tall sheet.
    sheet.closest('.sheet').classList.add('sheet--wide');
    // Each column its own stack, so a tall one never pushes the others' settings down.
    const cols = { toggles: h('div', { class: 'sheet__col' }), voice: h('div', { class: 'sheet__col' }), pc: h('div', { class: 'sheet__col' }) };
    for (const s of /** @type {NodeListOf<HTMLElement>} */ (sheet.querySelectorAll('.setting'))) {
      s.dataset.col = s.classList.contains('setting--cmds') ? 'voice' : s.classList.contains('setting--pc') || s.classList.contains('setting--pair') || s.classList.contains('setting--keys') ? 'pc' : 'toggles';
      cols[s.dataset.col].append(s);
    }
    cols.pc.append(...[...cols.pc.children].reverse()); // This PC first, the phone QR code (when sharing) under it
    sheet.append(cols.toggles, cols.voice, cols.pc);
    watchers.add((s) => {
      if (document.activeElement !== http) http.value = s.settings.httpPort;
      if (document.activeElement !== udp) udp.value = s.settings.udpPort;
      setText(version, `Undercut ${s.version} · race data in ${s.dataDir}`);
    });
    if (status) for (const fn of watchers) fn(status);
    // Hands-free in the app listens with Windows, on this PC: say so instead of the browser's warning.
    const hf = document.querySelector('#set-handsfree + .setting__text .dim');
    if (hf) hf.textContent = 'Always listening, answers only what starts with "Engineer": "Engineer, gap behind?" Say just "Engineer" and it asks what you need. Wear a headset so it doesn\'t hear the game. In the app, Windows\' own speech recognition does the listening, on this PC: nothing is sent anywhere.';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountSettings);
  else mountSettings();

  // ---------- Home: where the app opens ----------
  // Real races behind the name, from Wikimedia Commons; each is credited while it shows.
  // pos keeps the cars clear of the bars on the left.
  const HOME_PHOTOS = [
    { src: 'img/home-austria-2023.jpg', w: 1920, h: 1080, pos: '50% 40%', alt: 'Verstappen\'s Red Bull chasing Leclerc\'s Ferrari through a corner at the 2023 Austrian Grand Prix',
      title: 'Austria 2023', by: 'Lukas Raich', lic: 'CC BY-SA 4.0', licUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
      page: 'https://commons.wikimedia.org/wiki/File:FIA_F1_Austria_2023_Race_(2).jpg' },
    { src: 'img/home-zandvoort-2024.jpg', w: 1920, h: 1080, pos: '50% 50%', alt: 'Leclerc\'s Ferrari head-on through a banked corner at the 2024 Dutch Grand Prix in Zandvoort',
      title: 'Zandvoort 2024', by: 'Steffen Prößdorf', lic: 'CC BY-SA 4.0', licUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
      page: 'https://commons.wikimedia.org/wiki/File:2024-08-25_Motorsport,_Formel_1,_Gro%C3%9Fer_Preis_der_Niederlande_2024_STP_3912_by_Stepro.jpg' },
    { src: 'img/home-monza-2019.jpg', w: 1583, h: 891, pos: '50% 50%', alt: 'Leclerc\'s Ferrari holding off Hamilton\'s Mercedes side by side at the 2019 Italian Grand Prix in Monza',
      title: 'Monza 2019', by: 'Interceptor73', lic: 'CC BY 2.0', licUrl: 'https://creativecommons.org/licenses/by/2.0',
      page: 'https://commons.wikimedia.org/wiki/File:Charles_Leclerc,_Ferrari_SF90_holds_off_Lewis_Hamilton,_Mercedes_F1_W10,_2019_Italian_Grand_Prix,_Monza,_8th_September.jpg' },
  ];

  // A landing page that fills the window: races behind the name, and
  // one bar into each part of the app with one line of what's there now. The
  // rail (app.js) only appears once you go into a screen.
  widgets.home = {
    title: 'Home',
    description: 'Where the app opens: the live dashboard, race analysis, Ask the race, storage and connecting',
    tall: true,
    mount(el) {
      const dest = (name, onclick) => {
        const state = h('span', { class: 'home__state' });
        const node = h('button', { type: 'button', class: 'home__dest', onclick }, h('span', { class: 'home__name' }, name), state);
        return { node, state };
      };
      const live = dest('Live dashboard', () => go('drive'));
      const analysis = dest('Race analysis', () => go('analysis'));
      const ask = dest('Ask the race', () => go('askrace'));
      const storage = dest('Storage', () => go('library'));
      const connect = dest('Connect and record', () => go('connect'));
      live.node.classList.add('home__dest--primary');

      const line = h('span', {});
      const dot = h('span', { class: 'home__dot' });
      const demo = button('Watch the demo race', () => act(() => { keepScreen('drive'); return api.replay('demo'); }), 'home__btn');
      const back = button('Back to live', () => act(() => { keepScreen('home'); return api.live(); }), 'home__btn');
      const settings = button('Settings', () => { const b = document.getElementById('settings'); if (b) b.click(); }, 'home__btn');
      const error = h('p', { class: 'pc-error home__error', role: 'alert', hidden: true });
      const photos = HOME_PHOTOS.map((p, i) => h('img', { class: `home__photo${i ? '' : ' is-on'}`, src: p.src, width: p.w, height: p.h, alt: p.alt, style: `object-position: ${p.pos}` }));
      const credit = h('p', { class: 'home__credit' });
      el.replaceChildren(h('div', { class: 'home' },
        ...photos,
        h('div', { class: 'home__top' }, h('div', {}, h('p', { class: 'home__status' }, dot, line), error), h('div', { class: 'home__actions' }, demo, back, settings)),
        h('nav', { class: 'home__nav', 'aria-label': 'Parts of the app' }, live.node, analysis.node, ask.node, storage.node, connect.node),
        h('h1', { class: 'home__mark' }, 'Undercut'),
        credit));

      // A new photograph every 8 s: a CSS crossfade, nothing redrawn in between. It waits while the
      // window is hidden (behind the game, minimized) and stops for good once Home is left.
      let photo = 0;
      const showCredit = () => {
        const p = HOME_PHOTOS[photo];
        credit.replaceChildren('Photo: ', h('a', { href: p.page, target: '_blank', rel: 'noopener' }, p.title), ` by ${p.by}, `, h('a', { href: p.licUrl, target: '_blank', rel: 'noopener' }, p.lic));
      };
      showCredit();
      const slideshow = setInterval(() => {
        if (!el.isConnected) return clearInterval(slideshow);
        if (document.hidden) return;
        photos[photo].classList.remove('is-on');
        photo = (photo + 1) % photos.length;
        photos[photo].classList.add('is-on');
        showCredit();
      }, 8000);

      async function act(fn) {
        error.hidden = true;
        try {
          await fn();
        } catch (err) {
          setText(error, reason(err));
          error.hidden = false;
        }
      }
      let captures = null;
      api.captures().then((c) => { captures = c; sig = ''; draw(last); }, () => {});

      let sig = '';
      let last = null;
      function draw(snap) {
        if (!status) return;
        const s = snap || {};
        const replaying = status.mode === 'replay';
        const on = !!s.connected;
        const call = s.strategy && s.strategy.call;
        const p = s.player;
        const sessions = (s.debrief && s.debrief.sessions) || [];
        const latest = sessions.find((d) => !d.live) || null;
        const key = JSON.stringify([replaying, on, call && call.action, p && [p.position, p.currentLapNum], s.session && s.session.totalLaps, latest && [latest.id, latest.finish], sessions.length, captures && captures.length, status.recording, status.pairUrl, status.clients, status.replay]);
        if (key === sig) return;
        sig = key;

        setText(line, replaying ? `Replaying ${status.replay.label}. Nothing is saved while it plays.` : on ? 'F1 26 is connected' : 'Waiting for F1 26');
        dot.className = `home__dot ${on ? 'is-good' : replaying ? 'is-info' : 'is-watch'}`;
        demo.hidden = on || replaying;
        back.hidden = !replaying;

        const where = p && p.position ? `P${p.position}${p.currentLapNum ? ` · lap ${p.currentLapNum}${s.session && s.session.totalLaps ? ` of ${s.session.totalLaps}` : ''}` : ''}` : null;
        setText(live.state, on ? [where, call && call.action].filter(Boolean).join(' · ') || 'On track' : replaying ? 'Replay running' : 'Turn on UDP telemetry in the game');
        setText(analysis.state, latest ? [[latest.track, latest.sessionName].filter(Boolean).join(' '), latest.finish ? `P${latest.finish}` : null].filter(Boolean).join(' · ') : 'No sessions yet');
        setText(ask.state, on ? 'After the session' : 'A local model, on this PC');
        const nSessions = sessions.filter((d) => !d.live).length;
        setText(storage.state, captures ? `${plural(nSessions, 'session')} · ${plural(captures.length, 'recording')}` : plural(nSessions, 'session'));
        const others = Math.max(0, status.clients - 1);
        setText(connect.state, status.recording ? 'Recording now' : status.pairUrl ? `Sharing${others ? ` · ${plural(others, 'device')}` : ''}` : 'This PC only');
      }
      const watch = () => draw(last);
      watchers.add(watch);
      draw(null);
      return (s) => {
        last = s;
        if (!el.isConnected) watchers.delete(watch);
        draw(s);
      };
    },
  };

  // Replays, going back to live and some settings reload the window: come back to this screen.
  function keepScreen(id) {
    try {
      sessionStorage.setItem('raceEngineer.next', id || JSON.parse(localStorage.getItem('raceEngineer.screen') || '"home"'));
    } catch (_) { /* storage off: the app opens on Home */ }
  }

  // Race analysis (analysis.js) builds its place with the same frame.
  window.RaceDesktop = {
    placeFrame,
    olderSessions,
    withOlder,
    screens: [
      { id: 'home', group: 'home', label: 'Home', layout: 'single', widgets: ['home'] },
      { id: 'analysis', group: 'place', label: 'Race analysis', layout: 'single', widgets: ['analysis'] },
      { id: 'connect', group: 'place', label: 'Connect', layout: 'single', widgets: ['connect'] },
      { id: 'library', group: 'place', label: 'Storage', layout: 'single', widgets: ['library'] },
      { id: 'askrace', group: 'place', label: 'Ask the race', layout: 'single', widgets: ['askrace'] },
    ],
  };
})();
