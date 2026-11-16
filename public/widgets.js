// Widget library. Each widget is a self-contained card: mount(el) builds its
// DOM once from a static template and returns update(snapshot), which only
// writes text/classes. Widgets format and colour; they never decide anything
// - the calls, projections and gaps all arrive pre-computed from the server.
//
// Driver names come from game packets, so they are only ever set with
// textContent, never interpolated into HTML.
(function () {
  'use strict';

  // ---------- Formatting ----------
  const COMPOUND = { 16: 'S', 17: 'M', 18: 'H', 7: 'I', 8: 'W' };

  const WEATHER = ['Clear', 'Light cloud', 'Overcast', 'Light rain', 'Heavy rain', 'Storm'];

  const YELLOW = { 1: 'Safety car', 2: 'VSC' };

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  function fmtLap(ms) {
    if (!isNum(ms) || ms <= 0) return '–';
    const m = Math.floor(ms / 60000);
    return `${m}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
  }

  const secs = (ms, dp = 1) => (isNum(ms) ? (Math.abs(ms) / 1000).toFixed(dp) : '–');

  const signed = (ms, dp = 1) => (isNum(ms) ? `${ms < 0 ? '−' : '+'}${secs(ms, dp)}` : '–');

  function setText(el, text) {
    const t = text == null ? '' : String(text);
    if (el.textContent !== t) el.textContent = t;
  }

  function setTone(el, tone) {
    for (const c of ['is-good', 'is-watch', 'is-act', 'is-muted', 'is-info', 'is-pb']) el.classList.toggle(c, c === tone);
  }

  function setCompound(el, code) {
    const c = COMPOUND[code] || '';
    setText(el, c);
    el.dataset.c = c;
  }

  function compoundBadge(code) {
    const b = document.createElement('span');
    b.className = 'compound';
    setCompound(b, code);
    return b;
  }

  // Builds the static template and collects [data-ref] elements.
  function template(el, html) {
    el.innerHTML = html;
    const refs = {};
    el.querySelectorAll('[data-ref]').forEach((n) => { refs[n.dataset.ref] = n; });
    return refs;
  }

  // Nearest car each side, from the server's signed gaps.
  function neighbours(s) {
    const ahead = s.nearby.filter((n) => n.gapToPlayerMs < 0).sort((a, b) => b.gapToPlayerMs - a.gapToPlayerMs)[0] || null;
    const behind = s.nearby.filter((n) => n.gapToPlayerMs >= 0).sort((a, b) => a.gapToPlayerMs - b.gapToPlayerMs)[0] || null;
    return { ahead, behind };
  }

  // "Closing 0.5s/lap" etc, from the server's gap trend (negative = shrinking).
  function trendText(car, side) {
    const t = car && car.gapTrendMsPerLap;
    if (!isNum(t)) return { text: 'Pace: needs a clean lap', tone: 'is-muted' };
    const rate = `${secs(t)}s/lap`;
    if (Math.abs(t) < 50) return { text: 'Holding the gap', tone: 'is-muted' };
    if (side === 'ahead') return t < 0 ? { text: `Closing ${rate}`, tone: 'is-good' } : { text: `Dropping ${rate}`, tone: 'is-watch' };
    return t < 0 ? { text: `Catching you ${rate}`, tone: 'is-act' } : { text: `Pulling away ${rate}`, tone: 'is-good' };
  }

  function tyreCompare(car, myAge) {
    if (!car || !isNum(car.tyresAgeLaps) || !isNum(myAge)) return '';
    const d = car.tyresAgeLaps - myAge;
    if (d === 0) return 'same age tyres';
    const n = Math.abs(d);
    return `${n} lap${n === 1 ? '' : 's'} ${d > 0 ? 'older' : 'fresher'} tyres`;
  }

  // A wear rate and, once the field has enough laps, its 90% range: "+0.090s (0.071–0.110)".
  const degText = (d) => `+${(d.degMsPerLap / 1000).toFixed(3)}s${d.ciMs ? ` <span class="dim">(${(d.ciMs[0] / 1000).toFixed(3)}–${(d.ciMs[1] / 1000).toFixed(3)})</span>` : ''}`;

  // HTML from game strings: always through esc().
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const badge = (code) => (COMPOUND[code] ? `<span class="compound" data-c="${COMPOUND[code]}">${COMPOUND[code]}</span>` : '');

  const plus = (ms) => (isNum(ms) ? `${ms >= 0 ? '+' : '−'}${(Math.abs(ms) / 1000).toFixed(3)}` : '–');

  // ---------- Tyre strategy (ML) ----------
  // Not the wear % (that's on the MFD): the projection - laps to the cliff,
  // the field-wide degradation the model has learned, and whether fresh
  // tyres would pay for a stop with the laps that are left.
  const COMPOUND_NAME = { 16: 'Soft', 17: 'Medium', 18: 'Hard', 7: 'Inter', 8: 'Wet' };

  // ---------- Weather ----------
  // The MFD lists forecast slots in minutes. This answers in laps: when does
  // the rain come, when does it stop, is the track drying - and once it's
  // mixed, which tyre is actually faster out there right now.
  const lapsTxt = (n) => {
    const l = Math.max(1, Math.round(n));
    return `~${l} lap${l === 1 ? '' : 's'}`;
  };

  // A small tag by a name when the field mixes the 2025 and 2026 rules (online): '26 has active aero and Overtake mode, '25 has DRS.
  function eraTag(car, s) {
    if (!s || !s.rules || !s.rules.mixed || car.regs2026 == null) return null;
    const t = document.createElement('span');
    t.className = `era-tag is-${car.regs2026 ? '26' : '25'}`;
    t.textContent = car.regs2026 ? "'26" : "'25";
    t.title = car.regs2026 ? 'On the 2026 rules: active aero and Overtake mode' : 'On the 2025 rules: DRS, no Overtake mode';
    return t;
  }

  // Kilometres and Celsius, or miles and Fahrenheit (Settings, remembered by app.js). The bridge always sends metric.
  const units = {
    imperial: false,
    speed: (kmh) => (isNum(kmh) ? (units.imperial ? `${Math.round(kmh * 0.621371)} mph` : `${Math.round(kmh)} km/h`) : '–'),
    temp: (c) => (isNum(c) ? (units.imperial ? `${Math.round((c * 9) / 5 + 32)}°F` : `${Math.round(c)}°C`) : '–'),
  };

  // A phone or tablet that scanned the pairing QR code arrives with ?k=<key>: keep it for this device and take it out of the address
  // bar. With it the device can save setup names, stars and notes; without it, it can only look (src/server/httpServer.js).
  const KEY_STORE = 'raceEngineer.pairKey';
  try {
    const u = new URL(location.href);
    const k = u.searchParams.get('k');
    if (k && /^[0-9a-f]{32}$/.test(k)) {
      localStorage.setItem(KEY_STORE, k);
      u.searchParams.delete('k');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    }
  } catch (_) { /* storage off: this device just cannot save */ }
  const pairKey = () => {
    try { return localStorage.getItem(KEY_STORE); } catch (_) { return null; }
  };
  const canSaveSetups = () => !!(window.undercut && window.undercut.saveSetupNote) || !!pairKey();
  // The desktop app saves itself; any other device asks the bridge, with its key. Throws the reason if it cannot.
  async function saveSetupNote(input) {
    if (window.undercut && window.undercut.saveSetupNote) return window.undercut.saveSetupNote(input);
    const key = pairKey();
    if (!key) throw new Error('This device is not paired: scan the QR code in Connect to edit');
    const res = await fetch('/api/setups/note', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Undercut-Key': key }, body: JSON.stringify(input) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `Could not save (${res.status})`);
    return true;
  }

  const W = {};
  // The order the Custom screen's widget picker lists them in (the files that register them load in another order).
  const ORDER = ['radio', 'call', 'rejoin', 'battle', 'drive', 'laptime', 'pittiming', 'options', 'tyrecall', 'pace', 'nearby', 'adjust', 'weather', 'qlap', 'qorder', 'qplan', 'setup', 'brief', 'map'];

  // ---------- Radio ----------
  W.radio = {
    title: 'Radio',
    description: 'The most important call right now, plus anything else active',
    mount(el) {
      const r = template(el, `
        <div class="w-radio">
          <div class="w-radio__top"><span class="w-radio__cat" data-ref="cat"></span><span class="w-radio__msg" data-ref="msg"></span></div>
          <ul class="w-radio__rest" data-ref="rest"></ul>
        </div>`);
      // Severity tints the whole card rather than a box nested inside it.
      const card = el.closest('.card');
      return (s) => {
        const [top, ...rest] = s.insights || [];
        card.dataset.severity = top ? top.severity : 'none';
        setText(r.cat, top ? top.category : '');
        setText(r.msg, top ? top.message : 'No calls - drive');
        const sig = rest.map((i) => i.id + i.message).join('|');
        if (r.rest.dataset.sig !== sig) {
          r.rest.dataset.sig = sig;
          r.rest.replaceChildren(...rest.slice(0, 4).map((i) => {
            const li = document.createElement('li');
            li.dataset.severity = i.severity;
            li.textContent = i.message;
            return li;
          }));
        }
      };
    },
  };

  // ---------- Strategy call ----------
  W.call = {
    title: 'Call',
    description: 'PUSH / HOLD / BOX / PIT with the reason behind it',
    mount(el) {
      const r = template(el, `<div class="w-call"><div class="w-call__action big" data-ref="action">–</div><div class="w-call__reason" data-ref="reason"></div></div>`);
      return (s) => {
        const st = s.strategy;
        setText(r.action, st ? st.call.action : '–');
        r.action.dataset.action = st ? st.call.action : '';
        setText(r.reason, st ? st.call.reason : 'Waiting for lap data');
      };
    },
  };

  // The Debrief (debrief.js) and the widget files below (widgets-*.js, loaded after this one) build on the same helpers.
  window.RaceWidgets = { widgets: W, order: ORDER, units, saveSetupNote, canSaveSetups, eraTag, setText, setTone, setCompound, compoundBadge, template, neighbours, trendText, tyreCompare, secs, signed, fmtLap, isNum, esc, badge, plus, degText, lapsTxt, COMPOUND, COMPOUND_NAME, WEATHER, YELLOW };
})();
