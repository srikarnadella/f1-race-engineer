// Dashboard shell: connection, screens/layouts, the custom-screen editor,
// and the global radio band + toasts. Widgets live in widgets.js. Nothing
// here judges race state - it arrives decided in each snapshot.
(function () {
  'use strict';

  const { widgets: WIDGETS, setText, setTone, lapsTxt } = window.RaceWidgets;
  const $ = (id) => document.getElementById(id);
  const STALE_AFTER_MS = 3000;
  const TOAST_MS = 6000;
  const CRITICAL_BAND_MS = 6000;
  const STORE = { screen: 'raceEngineer.screen', custom: 'raceEngineer.custom', voice: 'raceEngineer.voice', auto: 'raceEngineer.auto' };

  function load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (_) {
      return fallback;
    }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode: just don't persist */ }
  }

  // ---------- Recorded demo (the public website) ----------
  // On GitHub Pages there's no bridge to talk to: the page plays a recording
  // the real engine made (npm run site) instead. The debrief's on-demand
  // requests are answered from files saved alongside it.
  const RECORDED = location.hostname.endsWith('.github.io') || new URLSearchParams(location.search).has('recorded');
  const DEMO_DATA = 'demo-data/';
  if (RECORDED) {
    const realFetch = window.fetch.bind(window);
    window.fetch = (url, ...rest) => {
      const u = new URL(url, location.href);
      if (!u.pathname.includes('/api/')) return realFetch(url, ...rest);
      const p = u.searchParams;
      const file = u.pathname.endsWith('/api/models') ? 'models'
        : u.pathname.endsWith('/rivals') ? `rivals-${p.get('session')}`
          : u.pathname.endsWith('/compare') && !p.has('a') && !p.has('b') ? `compare-${p.get('session')}` : null;
      if (file) return realFetch(`${DEMO_DATA}api/${file}.json`);
      const error = u.pathname.endsWith('/compare') ? 'This recorded demo compares the best lap with the latest one - the full app compares any two.' : 'Not available in the recorded demo.';
      return Promise.resolve(new Response(JSON.stringify({ error }), { headers: { 'Content-Type': 'application/json' } }));
    };
  }

  // ---------- Layouts ----------
  // Slots are [col, row, colSpan, rowSpan] on a grid that fills the screen.
  const LAYOUTS = {
    'banner-3x2': { label: 'Banner + 3×2', cols: 3, rows: '0.55fr 1fr 1fr', slots: [[1, 1, 3, 1], [1, 2], [2, 2], [3, 2], [1, 3], [2, 3], [3, 3]] },
    'banner-feature': { label: 'Banner + wide + 4', cols: 3, rows: '0.5fr 1fr 1fr', slots: [[1, 1, 3, 1], [1, 2, 2, 1], [3, 2], [1, 3], [2, 3], [3, 3]] },
    'wide-side-3': { label: 'Wide + tall + side ×3', cols: 3, rows: '1fr 1fr 1fr', slots: [[1, 1, 2, 1], [3, 1], [1, 2, 2, 2], [3, 2], [3, 3]] },
    'wide-side': { label: 'Two wide + side', cols: 3, rows: '1fr 1fr', slots: [[1, 1, 2, 1], [3, 1], [1, 2, 2, 1], [3, 2]] },
    'banner-2x2': { label: 'Banner + 2×2', cols: 2, rows: '0.55fr 1fr 1fr', slots: [[1, 1, 2, 1], [1, 2], [2, 2], [1, 3], [2, 3]] },
    'big-3': { label: 'Big + 3', cols: 3, rows: '1fr 1fr 1fr', slots: [[1, 1, 2, 3], [3, 1], [3, 2], [3, 3]] },
    'big-4': { label: 'Big + 4', cols: 4, rows: '1fr 1fr', slots: [[1, 1, 2, 2], [3, 1], [4, 1], [3, 2], [4, 2]] },
    '2x2': { label: '2×2', cols: 2, rows: '1fr 1fr', slots: [[1, 1], [2, 1], [1, 2], [2, 2]] },
    '3x2': { label: '3×2', cols: 3, rows: '1fr 1fr', slots: [[1, 1], [2, 1], [3, 1], [1, 2], [2, 2], [3, 2]] },
    '2x3': { label: '2×3', cols: 2, rows: '1fr 1fr 1fr', slots: [[1, 1], [2, 1], [1, 2], [2, 2], [1, 3], [2, 3]] },
    '3x3': { label: '3×3', cols: 3, rows: '1fr 1fr 1fr', slots: [[1, 1], [2, 1], [3, 1], [1, 2], [2, 2], [3, 2], [1, 3], [2, 3], [3, 3]] },
    'split': { label: 'Side by side', cols: 2, rows: '1fr', slots: [[1, 1], [2, 1]] },
    'single': { label: 'Single', cols: 1, rows: '1fr', slots: [[1, 1]] },
  };

  // ---------- Screens ----------
  // Rule: nothing the game's HUD or MFD already shows (wear %, temperatures,
  // fuel, ERS %, damage, the timing tower, delta) - only what it can't: the
  // engineer's calls, where the fight is heading, projections, ML. The
  // bridge still tracks all of it; the models need it.
  //   Live:  Drive (the one screen to leave up), Battle (the fight either
  //          side), Strategy ("should I box?"), Weather (rain, in laps),
  //          Custom (your own pick of the same widgets).
  //   After: Debrief (recap, lap-vs-lap telemetry, rivals, the models).
  // Battle, Strategy, Weather and Debrief are where auto-switch goes.
  const PRESETS = [
    { id: 'drive', group: 'live', label: 'Drive', layout: 'single', widgets: ['drive'] },
    { id: 'battle', group: 'live', label: 'Battle', layout: 'big-3', widgets: ['battle', 'call', 'radio', 'pace'] },
    { id: 'strategy', group: 'live', label: 'Strategy', layout: 'wide-side-3', widgets: ['rejoin', 'call', 'options', 'tyrecall', 'weather'] },
    { id: 'weather', group: 'live', label: 'Weather', layout: 'wide-side-3', widgets: ['tyrecall', 'call', 'weather', 'rejoin', 'radio'] },
    { id: 'debrief', group: 'after', label: 'Debrief', layout: 'single', widgets: ['debrief'] },
  ];
  // Screens from earlier versions, so a saved choice still lands somewhere sensible.
  const RENAMED = { engineer: 'drive', race: 'drive', adjust: 'drive', car: 'drive', timing: 'drive', pit: 'strategy' };
  const FILLER = ['battle', 'radio', 'call', 'rejoin', 'laptime', 'options', 'tyrecall', 'adjust', 'weather', 'nearby', 'pace'];
  const CUSTOM_DEFAULT = { layout: 'banner-feature', widgets: ['radio', 'battle', 'call', 'rejoin', 'tyrecall', 'adjust'] };

  function sanitizeCustom(c) {
    const layout = LAYOUTS[c && c.layout] ? c.layout : CUSTOM_DEFAULT.layout;
    const n = LAYOUTS[layout].slots.length;
    const chosen = (c && Array.isArray(c.widgets) ? c.widgets : []).filter((w) => WIDGETS[w]).slice(0, n);
    for (const w of FILLER) if (chosen.length < n && !chosen.includes(w)) chosen.push(w);
    return { layout, widgets: chosen };
  }
  let custom = sanitizeCustom(load(STORE.custom, CUSTOM_DEFAULT));
  // Custom sits with the live screens; Debrief last.
  const screens = () => [...PRESETS.filter((p) => p.group === 'live'), { id: 'custom', group: 'live', label: 'Custom', ...custom }, ...PRESETS.filter((p) => p.group === 'after')];

  let currentId = load(STORE.screen, 'drive');
  currentId = RENAMED[currentId] || currentId;
  if (!screens().some((s) => s.id === currentId)) currentId = 'drive';
  let editing = false;
  let mounted = []; // [{ id, update }]
  let lastSnapshot = null;

  // ---------- Tabs ----------
  const GROUP_LABEL = { live: 'Live', after: 'After the race' };
  function renderTabs() {
    const items = [];
    let group = null;
    screens().forEach((s, i) => {
      if (s.group !== group) {
        group = s.group;
        const h = document.createElement('div');
        h.className = 'tabs__group';
        h.textContent = GROUP_LABEL[group];
        items.push(h);
      }
      items.push(tabButton(s, i));
    });
    $('tabs').replaceChildren(...items);
    if (RECORDED && window.parent !== window) window.parent.postMessage({ type: 'screen', id: currentId, auto: autoOn }, location.origin);
    const btn = $('customize');
    setText(btn, currentId === 'custom' ? (editing ? 'Done' : 'Edit') : 'Customize');
    btn.classList.toggle('is-active', editing);
    btn.hidden = currentId === 'debrief';
  }

  function tabButton(s, i) {
    {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `tab${s.id === currentId ? ' is-active' : ''}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(s.id === currentId));
      const key = document.createElement('span');
      key.className = 'tab__key';
      key.textContent = i + 1;
      const label = document.createElement('span');
      label.textContent = s.label;
      b.append(key, label);
      // pointerdown, not click: switches on touch, without waiting for the
      // finger to lift - and a slightly sloppy tap still counts.
      b.addEventListener('pointerdown', (e) => {
        if (e.button) return;
        e.preventDefault();
        showScreen(s.id);
      });
      b.addEventListener('click', () => showScreen(s.id)); // keyboard activation
      return b;
    }
  }

  // auto: put up by auto-switch, not the driver - so it isn't remembered,
  // and "home" (where auto-switch returns once the moment passes) stays put.
  function showScreen(id, auto = false) {
    if (!auto) {
      homeId = id;
      save(STORE.screen, id);
      // The driver picked a screen: auto-switch stands back for a while.
      if (autoOn) autoPausedUntil = Date.now() + AUTO_PAUSE_MS;
      renderAutoChip();
    }
    if (id === currentId) return;
    if (id !== 'custom') editing = false;
    currentId = id;
    renderTabs();
    renderScreen();
  }

  $('customize').addEventListener('click', () => {
    if (currentId === 'custom') {
      editing = !editing;
    } else {
      // Start the custom screen from the preset on screen - except Drive,
      // which is one composite card: start from its parts instead.
      const preset = PRESETS.find((p) => p.id === currentId);
      custom = sanitizeCustom(preset.id === 'drive' ? CUSTOM_DEFAULT : { layout: preset.layout, widgets: preset.widgets });
      save(STORE.custom, custom);
      showScreen('custom');
      editing = true;
    }
    renderTabs();
    renderScreen();
  });

  // ---------- Grid rendering ----------
  // Wide screens use the layout as designed; narrower ones reflow the same
  // slots into 2 or 1 columns with fixed-height rows (and page scroll).
  function mode() {
    const w = $('grid').clientWidth || window.innerWidth;
    if (w >= 860 && w > window.innerHeight * 0.85) return 'wide';
    return w >= 600 ? 'medium' : 'narrow';
  }

  function renderScreen() {
    const screen = screens().find((s) => s.id === currentId);
    const layout = LAYOUTS[screen.layout];
    const grid = $('grid');
    const m = mode();
    grid.className = `grid grid--${m}${editing ? ' is-editing' : ''}`;
    grid.style.gridTemplateColumns = m === 'wide' ? `repeat(${layout.cols}, minmax(0, 1fr))` : '';
    grid.style.gridTemplateRows = m === 'wide' ? layout.rows : '';

    $('editbar').hidden = !editing;
    if (editing) renderEditbar();

    mounted = [];
    grid.replaceChildren(...layout.slots.map(([c, r, w = 1, h = 1], i) => {
      const id = screen.widgets[i];
      const def = WIDGETS[id];
      const slot = document.createElement('section');
      slot.className = `card card--${id}`;
      if (m === 'wide') {
        slot.style.gridArea = `${r} / ${c} / span ${h} / span ${w}`;
      } else {
        const span = m === 'medium' && (w > 1 || def.tall) ? 2 : 1;
        slot.style.gridColumn = `span ${span}`;
        if (def.tall || h > 1) slot.classList.add('card--tall');
      }
      const title = document.createElement('div');
      title.className = 'card__title';
      title.textContent = def.title;
      const body = document.createElement('div');
      body.className = 'card__body';
      slot.append(title, body);
      mounted.push({ id, update: def.mount(body) });
      if (editing) slot.appendChild(slotPicker(i, id));
      return slot;
    }));
    if (lastSnapshot) updateWidgets(lastSnapshot);
  }

  function updateWidgets(s) {
    for (const w of mounted) {
      // Widgets that need the player's car wait until it exists.
      if (!s.player && !['radio', 'session', 'debrief'].includes(w.id)) continue;
      try {
        w.update(s);
      } catch (err) {
        console.error(`widget ${w.id} failed`, err);
      }
    }
  }

  // ---------- Custom-screen editor ----------
  function slotPicker(index, current) {
    const wrap = document.createElement('label');
    wrap.className = 'slot-picker';
    const sel = document.createElement('select');
    for (const [id, def] of Object.entries(WIDGETS)) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = def.title;
      o.selected = id === current;
      sel.appendChild(o);
    }
    const desc = document.createElement('span');
    desc.textContent = WIDGETS[current].description;
    sel.addEventListener('change', () => {
      custom.widgets[index] = sel.value;
      save(STORE.custom, custom);
      renderScreen();
    });
    wrap.append(sel, desc);
    return wrap;
  }

  let editbarWired = false;
  function renderEditbar() {
    const sel = $('layout-select');
    if (!editbarWired) {
      editbarWired = true;
      for (const [id, l] of Object.entries(LAYOUTS)) {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = `${l.label} (${l.slots.length})`;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => {
        custom = sanitizeCustom({ layout: sel.value, widgets: custom.widgets });
        save(STORE.custom, custom);
        renderScreen();
      });
      $('reset-custom').addEventListener('click', () => {
        custom = sanitizeCustom(CUSTOM_DEFAULT);
        save(STORE.custom, custom);
        renderScreen();
      });
      $('done-custom').addEventListener('click', () => {
        editing = false;
        renderTabs();
        renderScreen();
      });
    }
    sel.value = custom.layout;
  }

  // Swipe left/right cycles screens (not while editing - that's for selects).
  let touchStart = null;
  $('grid').addEventListener('touchstart', (e) => { touchStart = e.touches[0]; }, { passive: true });
  $('grid').addEventListener('touchend', (e) => {
    if (!touchStart || editing) return;
    const dx = e.changedTouches[0].clientX - touchStart.clientX;
    const dy = e.changedTouches[0].clientY - touchStart.clientY;
    touchStart = null;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const all = screens();
    const i = all.findIndex((s) => s.id === currentId);
    showScreen(all[(i + (dx < 0 ? 1 : all.length - 1)) % all.length].id);
  }, { passive: true });

  // Number keys 1-6 switch screens: a keyboard (or a button box mapped to
  // keys) beside the wheel, when the dashboard is on a PC monitor.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || /^(SELECT|INPUT|TEXTAREA)$/.test(e.target.tagName) || !$('settings-sheet').hidden) return;
    const s = screens()[Number(e.key) - 1];
    if (s) showScreen(s.id);
  });

  let lastMode = mode();
  window.addEventListener('resize', () => {
    if (mode() !== lastMode) {
      lastMode = mode();
      renderScreen();
    }
  });

  // ---------- Auto-switch ----------
  // The bridge decides which screen matters (snapshot.focus: Battle in a
  // fight, Strategy at a pit call or under a safety car, Weather when rain is
  // close, Debrief after the flag - with hold times so it doesn't flap).
  // Here it's only obeyed, and only when the driver has turned it on. When
  // the moment passes it goes back to the screen the driver last picked.
  const AUTO_PAUSE_MS = 30000;
  let autoOn = load(STORE.auto, false) === true;
  let autoPausedUntil = 0;
  let homeId = currentId;
  const labelOf = (id) => (screens().find((x) => x.id === id) || {}).label || id;

  function applyFocus(s) {
    if (!autoOn || editing || Date.now() < autoPausedUntil || !s.focus || !s.connected) return;
    const target = s.focus.screen === 'drive' ? homeId : s.focus.screen;
    if (target !== currentId && screens().some((x) => x.id === target)) showScreen(target, true);
  }

  function renderAutoChip() {
    const chip = $('auto-chip');
    chip.hidden = !autoOn;
    if (!autoOn) return;
    const paused = Date.now() < autoPausedUntil;
    const f = lastSnapshot && lastSnapshot.focus;
    const why = f && f.screen !== 'drive' ? `${labelOf(f.screen)} · ${f.reason || ''}` : 'Watching';
    setText($('auto-chip-text'), paused ? `Paused ${Math.ceil((autoPausedUntil - Date.now()) / 1000)}s - tap to resume` : why);
    chip.classList.toggle('is-paused', paused);
  }
  $('auto-chip').addEventListener('click', () => {
    autoPausedUntil = 0;
    if (lastSnapshot) applyFocus(lastSnapshot);
    renderAutoChip();
  });
  setInterval(renderAutoChip, 1000); // the pause countdown

  // ---------- Settings ----------
  const closeSettings = () => { $('settings-sheet').hidden = true; };
  $('settings').addEventListener('click', () => {
    $('set-auto').checked = autoOn;
    $('settings-sheet').hidden = false;
  });
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-sheet').addEventListener('click', (e) => { if (e.target === $('settings-sheet')) closeSettings(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });
  $('set-auto').addEventListener('change', (e) => {
    autoOn = e.target.checked;
    save(STORE.auto, autoOn);
    autoPausedUntil = 0;
    homeId = currentId;
    if (autoOn && lastSnapshot) applyFocus(lastSnapshot);
    renderAutoChip();
    renderTabs();
  });
  // Pairing: this bridge's LAN address, and a QR code of it, for the iPad.
  fetch('/api/pair').then((r) => r.json()).then((p) => {
    if (!p || !p.url) return;
    setText($('pair-url'), p.url);
    $('pair-qr').src = '/api/qr';
    $('pair').hidden = false;
  }).catch(() => { /* no bridge to pair with (static page) */ });

  // ---------- Top bar ----------
  const SAFETY_CAR = { 1: 'SAFETY CAR', 2: 'VSC', 3: 'FORMATION' };
  function renderTopbar(s) {
    const sess = s.session;
    const sc = sess && SAFETY_CAR[sess.safetyCarStatus];
    $('flag').hidden = !sc;
    setText($('flag'), sc || '');

    const wx = s.analysis && s.analysis.weather;
    const nc = wx && wx.nextChange;
    let chip = null;
    if (wx && wx.trackState === 'rain-coming') chip = [`Rain ${lapsTxt(nc.inLaps)}`, Math.round(nc.inLaps) <= 3 ? 'is-act' : 'is-watch'];
    else if (wx && wx.trackState === 'raining') chip = [nc && !nc.afterFlag ? `Dry ${lapsTxt(nc.inLaps)}` : 'Wet', 'is-info'];
    else if (wx && wx.trackState === 'drying') chip = ['Drying', 'is-watch'];
    $('wx').hidden = !chip;
    if (chip) {
      setText($('wx'), chip[0]);
      setTone($('wx'), chip[1]);
    }
  }

  // ---------- Radio: critical band + toasts (global, any screen) ----------
  const seenInsights = new Set();
  const criticalFirstSeen = new Map();
  function toast(insight) {
    const el = document.createElement('div');
    el.className = `toast toast--${insight.severity}`;
    el.textContent = insight.message;
    $('toasts').appendChild(el);
    // Fixed lifetime: the iPad's and the PC's clocks needn't agree.
    setTimeout(() => {
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 320);
    }, TOAST_MS);
  }
  function renderRadio(insights) {
    const now = Date.now();
    for (const i of insights) if (i.severity === 'critical' && !criticalFirstSeen.has(i.id)) criticalFirstSeen.set(i.id, now);
    for (const id of criticalFirstSeen.keys()) if (!insights.some((i) => i.id === id)) criticalFirstSeen.delete(id);
    // The band is an interrupt: a few seconds when a critical call lands.
    // No band or toasts where the radio is already shown (Drive, a Radio
    // widget) - the band would cover Drive's mode banner - or over the Debrief.
    const radioOnScreen = mounted.some((w) => w.id === 'radio' || w.id === 'drive' || w.id === 'debrief');
    const interrupting = !radioOnScreen && insights.find((i) => i.severity === 'critical' && now - criticalFirstSeen.get(i.id) < CRITICAL_BAND_MS);
    $('critical-band').hidden = !interrupting;
    if (interrupting) setText($('critical-band-msg'), interrupting.message);

    const present = new Set();
    for (const i of insights) {
      present.add(i.id);
      if (!seenInsights.has(i.id) && i.severity !== 'critical' && !radioOnScreen) toast(i);
      seenInsights.add(i.id);
    }
    for (const id of seenInsights) if (!present.has(id)) seenInsights.delete(id);
  }

  // ---------- Voice: the engineer on the radio ----------
  // So the driver never has to look away from the race. Uses the device's
  // own speech synthesis (no server work, no install). Each call is spoken
  // once when it appears - again only if it escalates or (ERS) changes mode;
  // critical calls cut in, and anything stale is dropped, never queued up.
  const VOICE_MODES = ['off', 'key', 'all'];
  const VOICE_LABEL = { off: 'Voice off', key: 'Voice: key', all: 'Voice: all' };
  const VOICE_STALE_MS = 6000;
  const SEVERITY_RANK = { info: 0, advisory: 1, critical: 2 };
  let voiceMode = load(STORE.voice, 'off');
  if (!VOICE_MODES.includes(voiceMode)) voiceMode = 'off';
  const voiceSupported = 'speechSynthesis' in window;
  const spoken = new Map(); // insight id -> spoken key (severity + action)
  const recentlySaid = new Map(); // insight id -> { key, at } - survives the card dropping off
  const VOICE_REPEAT_MS = 45000;
  let lastSpokenCall = null;
  const voiceQueue = [];
  let speaking = false;

  // Written for the screen; said for the ear.
  function forSpeech(text) {
    return text
      .replace(/(\d+):(\d\d)\.(\d)\d*/g, '$1 $2 point $3') // 1:05.284 -> "1 05 point 2"
      .replace(/~/g, 'about ')
      .replace(/(\d)s\/lap/g, '$1 seconds a lap')
      .replace(/(\d)s\b/g, '$1 seconds')
      .replace(/\bP(\d+)/g, 'P $1')
      .replace(/(\d+) → (\d+)%/g, '$1 to $2 percent')
      .replace(/%/g, ' percent')
      .replace(/\bERS\b/g, 'E R S')
      .replace(/\bVSC\b/g, 'V S C')
      .replace(/ - /g, '. ');
  }

  // An urgent call cuts off routine chatter, but never another urgent call:
  // "tyres at the cliff" then "box, box" are both said, back to back.
  let speakingUrgent = false;
  function say(text, urgent) {
    if (!voiceSupported || voiceMode === 'off') return;
    const item = { text: forSpeech(text), at: Date.now(), urgent: !!urgent };
    if (urgent) {
      const queuedUrgent = voiceQueue.filter((q) => q.urgent);
      voiceQueue.length = 0;
      voiceQueue.push(...queuedUrgent, item);
      if (speaking && !speakingUrgent) {
        window.speechSynthesis.cancel();
        speaking = false;
      }
    } else {
      voiceQueue.push(item);
    }
    pumpVoice();
  }
  // Speech watchdog. Browsers don't always report that a line finished
  // (Safari on iPad, and Chrome after a long session, both drop the "end"
  // event), which left the queue thinking it was still talking - and the
  // engineer silent for the rest of the race. A line gets its expected
  // length plus slack; past that, the queue moves on regardless.
  let speakingSince = 0;
  let speakingBudgetMs = 0;
  function pumpVoice() {
    if (speaking && Date.now() - speakingSince < speakingBudgetMs) return;
    if (speaking) {
      window.speechSynthesis.cancel();
      speaking = false;
    }
    while (voiceQueue.length && Date.now() - voiceQueue[0].at > VOICE_STALE_MS) voiceQueue.shift();
    const next = voiceQueue.shift();
    if (!next) return;
    const u = new SpeechSynthesisUtterance(next.text);
    u.rate = 1.1;
    speaking = true;
    speakingUrgent = next.urgent;
    speakingSince = Date.now();
    speakingBudgetMs = 3000 + next.text.split(/\s+/).length * 450; // ~2.5 words/s, plus slack
    u.onend = u.onerror = () => {
      if (u !== currentUtterance) return; // a late event from a line the watchdog already gave up on
      speaking = false;
      pumpVoice();
    };
    currentUtterance = u;
    window.speechSynthesis.speak(u);
  }
  let currentUtterance = null;
  // Runs regardless of new calls: unsticks the queue, and nudges Chrome,
  // whose speech engine can go quiet mid-session until paused and resumed.
  setInterval(() => {
    if (!voiceSupported || voiceMode === 'off') return;
    if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
      window.speechSynthesis.pause();
      window.speechSynthesis.resume();
    }
    if (voiceQueue.length || speaking) pumpVoice();
  }, 4000);

  // Key calls: critical + advisory radio, and PUSH/HOLD/BOX changes.
  // All calls: every radio message (ERS, undercut, rain, fastest lap...).
  // The ERS tip is re-spoken only when its mode changes - not its wording
  // ("battery ~65%" -> "~60%") or its reason (attack <-> defend in a battle).
  const ersMode = (msg) => (msg.match(/Overtake|Medium|Hotlap|None|save/i) || [''])[0].toLowerCase();
  const voiceKey = (i) => `${i.severity}|${i.id === 'ers' ? ersMode(i.message) : ''}`;
  let voicePrimed = false;
  function voiceInsights(insights, strategy) {
    // Whatever is already on screen when the page opens counts as heard.
    if (!voicePrimed) {
      voicePrimed = true;
      for (const i of insights) spoken.set(i.id, voiceKey(i));
      lastSpokenCall = strategy && strategy.call ? strategy.call.action : null;
      return;
    }
    const present = new Set();
    const now = Date.now();
    for (const i of insights) {
      present.add(i.id);
      const key = voiceKey(i);
      const prev = spoken.get(i.id);
      if (prev === key) continue;
      // A call that dropped off and came back (a margin hovering at its
      // threshold) isn't news again so soon - unless it got more serious.
      const recent = recentlySaid.get(i.id);
      const prevKey = prev || (recent && now - recent.at < VOICE_REPEAT_MS ? recent.key : null);
      const escalated = prevKey && SEVERITY_RANK[i.severity] > SEVERITY_RANK[prevKey.split('|')[0]];
      spoken.set(i.id, key);
      if (prevKey && !escalated && !(i.id === 'ers' && prevKey !== key)) continue;
      if (voiceMode === 'key' && i.severity === 'info') continue;
      recentlySaid.set(i.id, { key, at: now });
      say(i.message, i.severity === 'critical');
    }
    for (const id of spoken.keys()) if (!present.has(id)) spoken.delete(id);
    for (const [id, r] of recentlySaid) if (now - r.at > VOICE_REPEAT_MS) recentlySaid.delete(id);
    const action = strategy && strategy.call ? strategy.call.action : null;
    if (action && lastSpokenCall && action !== lastSpokenCall && action !== 'PIT') {
      const { reason } = strategy.call;
      say(action === 'BOX' ? `Box, box. ${reason}` : `${action.charAt(0)}${action.slice(1).toLowerCase()}. ${reason}`, action === 'BOX');
    }
    if (action) lastSpokenCall = action;
  }

  function renderVoiceButton() {
    const b = $('voice');
    b.hidden = !voiceSupported;
    setText(b, VOICE_LABEL[voiceMode]);
    b.classList.toggle('is-on', voiceMode !== 'off');
  }
  $('voice').addEventListener('click', () => {
    voiceMode = VOICE_MODES[(VOICE_MODES.indexOf(voiceMode) + 1) % VOICE_MODES.length];
    save(STORE.voice, voiceMode);
    renderVoiceButton();
    window.speechSynthesis.cancel();
    voiceQueue.length = 0;
    speaking = false;
    // Mark what's already on screen as heard, so switching on doesn't read
    // out a backlog; the tap also unlocks speech on iOS.
    if (lastSnapshot) {
      for (const i of lastSnapshot.insights || []) spoken.set(i.id, voiceKey(i));
      lastSpokenCall = lastSnapshot.strategy ? lastSnapshot.strategy.call.action : lastSpokenCall;
    }
    if (voiceMode !== 'off') say(voiceMode === 'key' ? 'Radio check. Key calls only.' : 'Radio check. All calls.', true);
  });
  renderVoiceButton();

  // ---------- Capture markers ----------
  // While the bridge is capturing, MARK (or the M key) stamps "this moment"
  // into the capture so it can be lined up with the data afterwards. The
  // tap is saved at once; the optional tag sheet just labels it.
  const MARK_SHEET_MS = 5000;
  let activeSocket = null;
  let markSheetTimer = null;
  let lastMarkId = null;
  function send(msg) {
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) activeSocket.send(JSON.stringify(msg));
  }
  function hideMarkSheet() {
    clearTimeout(markSheetTimer);
    $('mark-sheet').hidden = true;
  }
  function mark() {
    if (!lastSnapshot || !lastSnapshot.capturing) return;
    lastMarkId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    send({ type: 'mark', id: lastMarkId, tag: 'mark' });
    const p = lastSnapshot.player;
    setText($('mark-where'), p ? `lap ${p.currentLapNum}, ${(p.lapDistance / 1000).toFixed(2)} km` : '');
    $('mark').classList.add('is-flash');
    setTimeout(() => $('mark').classList.remove('is-flash'), 400);
    $('mark-sheet').hidden = false;
    clearTimeout(markSheetTimer);
    markSheetTimer = setTimeout(hideMarkSheet, MARK_SHEET_MS);
  }
  $('mark').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    mark();
  });
  $('mark-sheet').addEventListener('pointerdown', (e) => {
    const tag = e.target.dataset && e.target.dataset.tag;
    if (!tag) return;
    e.preventDefault();
    send({ type: 'mark', id: lastMarkId, tag });
    hideMarkSheet();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'm' || e.key === 'M') && !/^(SELECT|INPUT|TEXTAREA)$/.test(e.target.tagName)) mark();
  });

  // ---------- Connection + waiting states ----------
  let lastMessageAt = 0;
  let socketOpen = false;

  function renderLink() {
    const fresh = socketOpen && Date.now() - lastMessageAt < STALE_AFTER_MS;
    const live = fresh && lastSnapshot && lastSnapshot.connected;
    const demo = live && lastSnapshot.source === 'demo';
    const link = $('link');
    link.classList.toggle('is-live', !!live && !demo);
    link.classList.toggle('is-demo', !!demo);
    setText($('link-text'), !socketOpen ? 'Bridge offline' : !fresh ? 'Stalled' : demo ? (RECORDED ? 'Recorded demo' : 'Demo replay') : live ? 'Live' : 'No telemetry');

    let title = null;
    let body = '';
    if (!socketOpen) {
      title = 'Bridge offline.';
      body = 'Make sure npm start is running on the PC and this device is on the same network.';
    } else if (!lastSnapshot || !lastSnapshot.player) {
      title = 'No telemetry.';
      body = 'In F1 26: Settings → Telemetry → UDP On, port 20777, format 2025 or later - then get on track.';
    } else if (!lastSnapshot.connected) {
      title = 'Telemetry paused.';
      body = 'Nothing from the game for a few seconds - paused, in a menu, or the session ended. Showing the last data.';
    }
    $('status-banner').hidden = !title;
    if (title) {
      setText($('status-title'), title);
      setText($('status-body'), body);
    }
  }

  let lastDebrief = null;
  function render(s) {
    // The debrief arrives once a second; other snapshots reuse the last one.
    if (s.debrief) lastDebrief = s.debrief;
    else s.debrief = lastDebrief;
    lastSnapshot = s;
    lastMessageAt = Date.now();
    s.nearby = s.nearby || [];
    $('mark').hidden = !s.capturing;
    // Each step on its own: one failure must not stop the screen or the voice
    // for the rest of the race.
    const steps = [
      ['topbar', () => renderTopbar(s)],
      ['toasts', () => renderRadio(s.insights || [])],
      ['voice', () => voiceInsights(s.insights || [], s.strategy)],
      ['widgets', () => updateWidgets(s)],
      ['auto', () => { applyFocus(s); renderAutoChip(); }],
      ['link', renderLink],
    ];
    for (const [name, step] of steps) {
      try {
        step();
      } catch (err) {
        console.error(`render step ${name} failed`, err);
      }
    }
  }

  // A connection can stay "open" while delivering nothing (an iPad waking
  // from sleep, a backgrounded tab). The bridge sends 10 snapshots a second,
  // so 6 s of silence means the link is dead: drop it and reconnect.
  const DEAD_LINK_MS = 6000;
  setInterval(() => {
    if (socketOpen && activeSocket && Date.now() - lastMessageAt > DEAD_LINK_MS) {
      const dead = activeSocket;
      dead.onclose = dead.onmessage = dead.onerror = null;
      try { dead.close(); } catch (_) { /* already gone */ }
      socketOpen = false;
      renderLink();
      connect();
    }
  }, 2000);

  // Keep the screen awake while the dashboard is open - an iPad that
  // auto-locks mid-race takes the page (and its connection) with it.
  // Needs a tap first on some browsers, so it's also requested on any touch.
  let wakeLock = null;
  async function keepAwake() {
    if (!('wakeLock' in navigator) || (wakeLock && !wakeLock.released) || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (_) {
      wakeLock = null; // not allowed yet (no user gesture) - try again on the next tap
    }
  }
  document.addEventListener('visibilitychange', keepAwake);
  document.addEventListener('pointerdown', keepAwake, { passive: true });

  let retryMs = 500;
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    activeSocket = ws;
    lastMessageAt = Date.now(); // a fresh socket gets the full grace period
    ws.onopen = () => {
      socketOpen = true;
      retryMs = 500;
      renderLink();
    };
    ws.onmessage = (e) => {
      try {
        render(JSON.parse(e.data));
      } catch (err) {
        console.error('Bad snapshot', err);
      }
    };
    ws.onclose = () => {
      socketOpen = false;
      renderLink();
      setTimeout(connect, retryMs);
      retryMs = Math.min(5000, retryMs * 2);
    };
    ws.onerror = () => ws.close();
  }

  // Plays the recording on a loop, at the pace it was recorded.
  function playRecording() {
    Promise.all([DEMO_DATA + 'snapshots.json', DEMO_DATA + 'debrief.json'].map((u) => fetch(u).then((r) => r.json())))
      .then(([frames, debrief]) => {
        socketOpen = true;
        let i = 0;
        const step = () => {
          const frame = frames[i];
          render({ ...frame.s, updatedAtMs: Date.now(), debrief });
          const last = i === frames.length - 1;
          setTimeout(step, last ? 2000 : frames[i + 1].t - frame.t);
          i = last ? 0 : i + 1;
        };
        step();
      })
      .catch(() => {
        setText($('status-title'), 'Demo data missing.');
        setText($('status-body'), 'Build it with npm run site.');
        $('status-banner').hidden = false;
      });
  }

  // The demo website's guide buttons drive this page when it's embedded.
  if (RECORDED) {
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || !e.data) return;
      if (e.data.type === 'show' && screens().some((x) => x.id === e.data.id)) showScreen(e.data.id);
      if (e.data.type === 'auto') {
        $('set-auto').checked = !!e.data.on;
        $('set-auto').dispatchEvent(new Event('change'));
      }
    });
  }

  renderTabs();
  renderScreen();
  setInterval(renderLink, 1000); // catches a silent stall between messages
  renderLink();
  if (RECORDED) playRecording();
  else connect();
  keepAwake();
})();
