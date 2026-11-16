// Setups: every setup you have run, as the desktop app's place and as a screen on a phone or tablet. For each track the setups from your recordings (the race
// store's setup_run rows), their stats with the conditions beside them, the community sheet's values as the reference, and
// the names, stars and notes you give them, with links back to the races they were run in. It shows what the library
// (src/analysis/setupLibrary.js) built and writes only names, stars and notes (the app saves them itself; a phone needs the key
// from the pairing QR code, and without it is read-only). Reading recordings and opening Race analysis are the PC's alone.
(function () {
  'use strict';

  const desk = window.RaceDesktop;
  const api = window.undercut;
  const hasDesk = !!(desk && desk.placeFrame);
  const canRead = !!(api && api.backfillSetups); // reading recordings needs the PC's files
  const { widgets, fmtLap, COMPOUND_NAME, WEATHER, units, saveSetupNote, canSaveSetups } = window.RaceWidgets;

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'value') /** @type {HTMLInputElement} */ (el).value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }

  // The values in the order of the car menu, then what else the game sends. Brake bias is the one the wheel moves, so it is
  // shown as it was run and never counted as a difference.
  const LABELS = [
    ['frontWing', 'Front wing'], ['rearWing', 'Rear wing'], ['diffOn', 'Diff on throttle'], ['diffOff', 'Diff off throttle'],
    ['frontSuspension', 'Front suspension'], ['rearSuspension', 'Rear suspension'], ['frontAntiRollBar', 'Front anti-roll bar'], ['rearAntiRollBar', 'Rear anti-roll bar'],
    ['frontHeight', 'Front ride height'], ['rearHeight', 'Rear ride height'], ['brakePressure', 'Brake pressure'], ['brakeBias', 'Brake bias (as run)'],
    ['tyreFront', 'Front tyre pressure'], ['tyreRear', 'Rear tyre pressure'],
    ['frontCamber', 'Front camber'], ['rearCamber', 'Rear camber'], ['frontToe', 'Front toe'], ['rearToe', 'Rear toe'], ['engineBraking', 'Engine braking'], ['ballast', 'Ballast'],
  ];
  const DECIMALS = { tyreFront: 1, tyreRear: 1, frontCamber: 2, rearCamber: 2, frontToe: 2, rearToe: 2 };
  const round = (v, k) => Math.round(v * 10 ** (DECIMALS[k] ?? 0)) / 10 ** (DECIMALS[k] ?? 0);
  const show = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(Number.isInteger(v) ? v : Math.round(v * 100) / 100) : '–');
  const signed = (c) => `${c > 0 ? '+' : '−'}${Math.abs(c)}`;
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const reason = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^setup note: /, '');
  const MIN_RACE_LAPS = 5;
  const tempRange = (a, b) => (a == null ? null : a === b ? units.temp(a) : `${units.temp(a).replace(/°[CF]$/, '')}–${units.temp(b)}`);
  const kindOf = (setup) => (setup.sessions.length && setup.sessions[0].sessionType >= 5 && setup.sessions[0].sessionType <= 14 ? 'q' : 'r');

  widgets.setups = {
    title: 'Setups',
    description: 'Every setup you have run, by track, with its stats, names, stars and links to the races',
    tall: true,
    bare: true,
    mount(el) {
      const frame = hasDesk ? desk.placeFrame(el, 'Setups') : el;
      let library = null; // { sheet, tracks } or { error }
      let trackId = null;
      let favoritesOnly = false;
      let editing = null; // the key of the setup being renamed
      const open = new Set(); // keys of the setups whose details are showing
      let picked = []; // keys ticked for comparing, oldest first
      let statusText = '';
      let backfill = null; // { done, total } while recordings are being read
      let debriefs = []; // the saved sessions the races link to
      let older = [];

      const root = h('div', { class: 'sl' });
      frame.replaceChildren(root);

      // ---------- Reading and writing ----------
      async function load() {
        try {
          const res = await fetch('/api/setups');
          library = await res.json();
          if (!library || (!library.error && !Array.isArray(library.tracks))) library = { error: 'The setup library could not be read.' };
        } catch (err) {
          library = { error: reason(err) };
        }
        draw();
      }
      async function save(input, setup) {
        statusText = '';
        try {
          await saveSetupNote({ trackId: setup.trackId, key: setup.key, values: setup.values, ...input });
        } catch (err) {
          statusText = reason(err);
        }
        await load();
      }
      async function readRecordings() {
        statusText = 'Reading your recordings…';
        draw();
        try {
          const r = await api.backfillSetups();
          statusText = r.read
            ? `Read ${plural(r.read, 'recording')}.${r.skipped ? ` ${plural(r.skipped, 'recording')} skipped: the packets were dropped, so they can no longer be read.` : ''}`
            : `No recordings to read.${r.skipped ? ` ${plural(r.skipped, 'recording')} skipped: the packets were dropped.` : ''}`;
        } catch (err) {
          statusText = reason(err);
        }
        await load();
      }

      // The debrief of a session, so a run can link to Race analysis: by the game's session id, or by track, session and time
      // for debriefs saved before that id was kept.
      const debriefOf = (run, track) => {
        const all = debriefs.concat(older.filter((o) => !debriefs.some((x) => x.id === o.id)));
        return all.find((d) => d.uid && d.uid === run.uid)
          || all.find((d) => !d.uid && d.track === track && d.sessionName === run.name && Math.abs(d.startedAt - run.startedAt) < 15 * 60000) || null;
      };

      // ---------- Pieces ----------
      function stat(label, value, note) {
        return h('div', { class: 'sl__stat' }, h('dt', {}, label), h('dd', {}, value, note ? h('small', {}, note) : null));
      }

      function statsFor(s) {
        const st = s.stats;
        const q = kindOf(s) === 'q';
        const pace = st.racePaceMs
          ? stat('Race pace', fmtLap(st.racePaceMs), `${plural(st.raceLaps, 'lap')} · not corrected for fuel${st.avgRaceFuelKg ? ` (about ${st.avgRaceFuelKg} kg)` : ''}`)
          : stat('Race pace', st.raceLaps ? 'not enough laps' : '–', st.raceLaps ? `${plural(st.raceLaps, 'clean race lap')}, ${MIN_RACE_LAPS} needed` : null);
        const off = s.sheetOff ? s.sheetOff[q ? 'q' : 'r'] : null;
        return h('dl', { class: 'sl__stats' },
          stat('Best quali lap', st.bestQ ? fmtLap(st.bestQ) : '–', st.bestQ ? plural(st.cleanLapsQ, 'clean lap') : null),
          stat('Best race/practice lap', st.bestR ? fmtLap(st.bestR) : '–', st.bestR ? plural(st.cleanLapsR, 'clean lap') : null),
          pace,
          stat('Tyres', st.compounds.length ? st.compounds.map((c) => COMPOUND_NAME[c] || '?').join(', ') : '–'),
          stat('Track', tempRange(st.trackTempMin, st.trackTempMax) || '–', st.weathers.length ? st.weathers.map((w) => WEATHER[w]).filter(Boolean).join(', ') : null),
          stat('Against the sheet', off == null ? 'no sheet entry' : `${off} of 14 differ`, off == null ? null : q ? 'qualifying values' : 'race values'));
      }

      function valueCells(s) {
        const rows = s.vsSheet ? s.vsSheet[kindOf(s)] : null;
        const by = rows ? Object.fromEntries(rows.map((r) => [r.key, r])) : {};
        return h('div', { class: 'sl__cells' }, LABELS.map(([key, label]) => {
          const r = by[key];
          const v = s.values[key];
          const cls = r && r.ok === true ? ' is-ok' : r && r.ok === false ? ' is-off' : '';
          return h('div', { class: `sl__cell${cls}` }, h('span', {}, label), h('b', {}, s.valueText && s.valueText[key] ? s.valueText[key] : show(v)), r && r.ok === false ? h('small', {}, `${signed(r.change)} to match`) : null);
        }));
      }

      function runsFor(s, track) {
        if (!s.sessions.length) return h('p', { class: 'sl__quiet' }, 'No sessions left: the races this was run in have been deleted. The name, star and note are kept.');
        return h('ul', { class: 'sl__runs' }, s.sessions.map((r) => {
          const d = debriefOf(r, track);
          const result = r.isRace ? `P${r.grid ?? '–'} → P${r.finish ?? '–'}` : r.finish ? `P${r.finish}` : '';
          // Race analysis is the PC's: a phone shows the run without a link.
          const link = !hasDesk ? null : h('button', {
            type: 'button', class: 'sl__open', disabled: !d, title: d ? 'Open this race in Race analysis' : 'Its debrief was removed; the stats stay',
            onclick: () => {
              desk.analysisSession = d.id;
              document.dispatchEvent(new CustomEvent('undercut:show', { detail: 'analysis' }));
            },
          }, d ? 'Open race' : 'Debrief removed');
          return h('li', { class: 'sl__run' },
            h('span', { class: 'sl__run-when' }, day(r.startedAt)),
            h('span', { class: 'sl__run-what' }, r.name),
            h('span', { class: 'sl__run-result' }, result),
            h('span', { class: 'sl__run-laps' }, `${plural(r.cleanLaps, 'clean lap')}${r.bestMs ? ` · best ${fmtLap(r.bestMs)}` : ''}${r.compounds.length ? ` · ${r.compounds.map((c) => COMPOUND_NAME[c] || '?').join(', ')}` : ''}${r.brakeBias != null ? ` · bias ${r.brakeBias}` : ''}`),
            link);
        }));
      }

      function nameNode(s) {
        if (!canSaveSetups()) return h('span', { class: `sl__name is-fixed${s.named ? ' is-named' : ''}` }, s.name);
        if (editing !== s.key) {
          return h('button', { type: 'button', class: `sl__name${s.named ? ' is-named' : ''}`, title: 'Rename', onclick: () => { editing = s.key; draw(); const i = root.querySelector('.sl__rename'); if (i) /** @type {HTMLInputElement} */ (i).focus(); } }, s.name);
        }
        const input = h('input', {
          class: 'sl__rename', type: 'text', maxlength: 60, value: s.name, 'aria-label': 'Setup name',
          onkeydown: (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              editing = null;
              save({ name: input.value.trim() }, s);
            } else if (e.key === 'Escape') {
              e.stopPropagation(); // Escape here cancels the rename; it must not also take you back Home (app.js)
              editing = null;
              draw();
            }
          },
          onblur: () => { if (editing === s.key) { editing = null; draw(); } },
        });
        return input;
      }

      // The sheet's own setup for the track, as a starting point: labelled, open, and with nothing to rename, star or note.
      function recommendedRow(s) {
        return h('li', { class: 'sl__row is-recommended', 'data-key': s.key },
          h('div', { class: 'sl__head' },
            h('span', { class: 'sl__name is-fixed' }, s.name),
            h('span', { class: 'sl__tag' }, 'Recommended default'),
            h('label', { class: 'sl__compare-pick', title: 'Tick two setups to compare them' }, h('input', {
              type: 'checkbox', class: 'sl__pick', checked: picked.includes(s.key) || null,
              onchange: (e) => {
                picked = picked.filter((k) => k !== s.key);
                if (e.target.checked) picked = [...picked, s.key].slice(-2);
                draw();
              },
            }), ' Compare')),
          h('div', { class: 'sl__detail' }, valueCells(s)));
      }

      function rowFor(s, track) {
        if (s.recommended) return recommendedRow(s);
        const isOpen = open.has(s.key);
        const detail = h('div', { class: 'sl__detail', hidden: !isOpen },
          valueCells(s),
          h('h4', { class: 'sl__h' }, 'Ran in'),
          runsFor(s, track),
          canSaveSetups()
            ? h('label', { class: 'sl__notelabel' }, h('span', { class: 'sl__h' }, 'Note'),
              h('textarea', { class: 'sl__note', maxlength: 500, rows: 3, placeholder: 'What it did: loose at Eau Rouge, good in S3…', onchange: (e) => save({ note: e.target.value }, s) }, s.note))
            : (s.note ? h('p', { class: 'sl__quiet' }, `Note: ${s.note}`) : null));
        // textarea content set through its value, never as markup
        const area = detail.querySelector('.sl__note');
        if (area) area.value = s.note;
        return h('li', { class: `sl__row${s.favorite ? ' is-favorite' : ''}${s.orphan ? ' is-orphan' : ''}`, 'data-key': s.key },
          h('div', { class: 'sl__head' },
            canSaveSetups() ? h('button', { type: 'button', class: 'sl__star', 'aria-pressed': String(s.favorite), 'aria-label': s.favorite ? 'Remove from favorites' : 'Mark as a favorite', title: s.favorite ? 'Favorite' : 'Mark as a favorite', onclick: () => save({ favorite: !s.favorite }, s) }, s.favorite ? '★' : '☆') : (s.favorite ? h('span', { class: 'sl__star is-static', 'aria-label': 'Favorite' }, '★') : null),
            nameNode(s),
            s.orphan ? h('span', { class: 'sl__tag' }, 'No sessions left') : !s.stats.cleanLapsQ && !s.stats.cleanLapsR ? h('span', { class: 'sl__tag', title: 'Set in the garage, but no clean lap was driven on it yet' }, 'No clean laps yet') : null,
            s.lastAt ? h('span', { class: 'sl__when' }, `Last run ${day(s.lastAt)} · ${plural(s.sessions.length, 'session')}`) : null,
            h('label', { class: 'sl__compare-pick', title: 'Tick two setups to compare them' }, h('input', {
              type: 'checkbox', class: 'sl__pick', checked: picked.includes(s.key) || null,
              onchange: (e) => {
                picked = picked.filter((k) => k !== s.key);
                if (e.target.checked) picked = [...picked, s.key].slice(-2);
                draw();
              },
            }), ' Compare'),
            h('button', { type: 'button', class: 'sl__toggle', 'aria-expanded': String(isOpen), onclick: () => { if (open.has(s.key)) open.delete(s.key); else open.add(s.key); draw(); } }, isOpen ? 'Hide' : 'Details')),
          statsFor(s),
          detail);
      }

      function compareFor(a, b) {
        const diff = (k) => a.values[k] != null && b.values[k] != null && k !== 'brakeBias' && round(a.values[k], k) !== round(b.values[k], k);
        return h('section', { class: 'sl__compare', 'aria-label': 'Compare two setups' },
          h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Value'), h('th', {}, a.name), h('th', {}, b.name))),
            h('tbody', {}, LABELS.map(([k, label]) => h('tr', { class: diff(k) ? 'is-diff' : '' }, h('th', { scope: 'row' }, label), h('td', {}, show(a.values[k])), h('td', {}, show(b.values[k])))))));
      }

      function referenceFor(t) {
        if (!t.reference) return null;
        const q = Object.fromEntries(t.reference.q.map((r) => [r.key, r.target]));
        const r = Object.fromEntries(t.reference.r.map((x) => [x.key, x.target]));
        return h('details', { class: 'sl__ref' },
          h('summary', {}, `Sheet · ${library.sheet || ''}${t.circuit ? ` · ${t.circuit}` : ''}`, h('span', { class: 'sl__ref-hint' }, ' (values)')),
          h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Value'), h('th', {}, 'Qualifying'), h('th', {}, 'Race'))),
            h('tbody', {}, LABELS.filter(([k]) => q[k] != null || r[k] != null).map(([k, label]) => h('tr', {}, h('th', { scope: 'row' }, label), h('td', {}, q[k] ?? '–'), h('td', {}, r[k] ?? '–'))))),
          t.reference.notes ? h('p', { class: 'sl__quiet' }, `Sheet note: ${t.reference.notes}`) : null);
      }

      // ---------- The page ----------
      // Arriving from a race (analysis.js): open that track and that setup, once.
      let reveal = null;
      function takeFocus() {
        const f = hasDesk ? desk.setupsFocus : null;
        if (!f || !library || !Array.isArray(library.tracks)) return;
        desk.setupsFocus = null;
        if (!library.tracks.some((t) => t.trackId === f.trackId)) return;
        favoritesOnly = false;
        trackId = f.trackId;
        open.add(f.key);
        reveal = f.key;
      }

      function draw() {
        if (!root.isConnected) return; // you left the place while something was still being read
        takeFocus();
        const busy = !!backfill;
        const readBtn = (cls = '') => (!canRead ? null : h('button', { type: 'button', class: `sl__backfill ${cls}`, disabled: busy, onclick: readRecordings },
          busy ? `Reading recordings… ${backfill.done} of ${backfill.total}` : 'Read setups from my recordings'));
        if (!library) {
          root.replaceChildren(h('p', { class: 'sl__quiet' }, 'Reading the library…'));
          return;
        }
        if (library.error) {
          root.replaceChildren(h('p', { class: 'sl__quiet' }, library.error));
          return;
        }
        const tracks = library.tracks.map((t) => (favoritesOnly ? { ...t, setups: t.setups.filter((s) => s.favorite) } : t)).filter((t) => t.setups.length);
        if (!library.tracks.length) {
          root.replaceChildren(h('div', { class: 'sl__empty' },
            h('h2', { class: 'sl__title' }, 'No setups yet'),
            h('p', {}, canRead ? 'Setups are kept as you drive. To bring in the ones from races you have already recorded, read your recordings. This is safe to repeat, keeps a copy of your library first, and never touches your names and stars.' : 'Setups are kept as you drive. To bring in the ones from races you have already recorded, read your recordings in the Setups page on the PC.'),
            readBtn('is-primary'),
            h('p', { class: 'sl__status', role: 'status' }, statusText)));
          return;
        }
        if (!tracks.some((t) => t.trackId === trackId)) trackId = tracks.length ? tracks[0].trackId : null;
        const t = tracks.find((x) => x.trackId === trackId);

        const nav = h('nav', { class: 'sl__tracks', 'aria-label': 'Tracks' },
          h('div', { class: 'sl__tracks-head' }, h('span', { class: 'sl__h' }, 'Tracks'), h('button', { type: 'button', class: 'sl__filter', 'aria-pressed': String(favoritesOnly), onclick: () => { favoritesOnly = !favoritesOnly; draw(); } }, '★ Favorites')),
          tracks.map((x) => h('button', { type: 'button', class: `sl__track${x.favorites ? ' has-favorite' : ''}`, 'aria-current': String(x.trackId === trackId), onclick: () => { trackId = x.trackId; picked = []; draw(); } },
            h('span', { class: 'sl__track-name' }, x.track || `Track ${x.trackId}`), h('span', { class: 'sl__track-count' }, String(x.setups.filter((s) => !s.recommended).length || '–')))));

        let main = h('p', { class: 'sl__quiet' }, favoritesOnly ? 'No favorites yet: star a setup to see it here.' : '');
        if (t) {
          const own = t.setups.filter((s) => !s.recommended);
          const sessions = new Set(t.setups.flatMap((s) => s.sessions.map((r) => r.uid))).size;
          const best = Math.min(...t.setups.map((s) => s.stats.bestQ || Infinity), ...t.setups.map((s) => s.stats.bestR || Infinity));
          const pair = picked.map((k) => t.setups.find((s) => s.key === k)).filter(Boolean);
          main = h('section', { class: 'sl__main' },
            h('header', { class: 'sl__top' },
              h('h2', { class: 'sl__title' }, t.track || `Track ${t.trackId}`),
              h('p', { class: 'sl__meta' }, [t.circuit, plural(own.length, 'setup'), plural(sessions, 'session'), Number.isFinite(best) ? `best ${fmtLap(best)}` : null].filter(Boolean).join(' · ')),
              h('div', { class: 'sl__tools' }, readBtn(), h('p', { class: 'sl__status', role: 'status' }, statusText)),
              canSaveSetups() ? null : h('p', { class: 'sl__quiet' }, 'Read-only on this device. To name and star setups here, scan the QR code under Connect and record on the PC.')),
            referenceFor(t),
            pair.length === 2 ? compareFor(pair[0], pair[1]) : null,
            h('ul', { class: 'sl__list' }, t.setups.map((s) => rowFor(s, t.track))));
        }
        root.replaceChildren(nav, main);
        if (reveal) {
          const row = root.querySelector(`[data-key="${reveal}"]`);
          if (row && row.scrollIntoView) row.scrollIntoView({ block: 'start' });
          reveal = null;
        }
        // The status is the one place errors and results land; keep it readable for a screen reader.
      }

      draw();
      const unwatch = !hasDesk ? () => {} : desk.watchStatus((s) => {
        const was = backfill;
        backfill = s && s.backfill ? s.backfill : null;
        if (was && !backfill) load();
        else if (was || backfill) draw();
      });
      load();
      if (hasDesk) desk.olderSessions().then((list) => { older = list; draw(); });

      return (s) => {
        if (!el.isConnected) unwatch();
        const next = (s && s.debrief && s.debrief.sessions) || [];
        if (next.length !== debriefs.length || next.some((d, i) => d.id !== (debriefs[i] || {}).id)) {
          debriefs = next;
          if (library && library.tracks) draw();
        }
      };
    },
  };
})();
