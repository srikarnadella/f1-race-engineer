// The Setup screen's widget: the car's setup on top, the community sheet's setup for this track below, every value that
// is off in red and every one that is right in green. Deliberately plain. It only formats what `snapshot.setup` carries
// (src/analysis/setupView.js); the screen comes up by itself in the garage or the pit lane (public/app.js).
// Registers into window.RaceWidgets.widgets (widgets.js, which loads first, has the shared helpers).
(function () {
  'use strict';
  const { widgets: W, setText, template, isNum, fmtLap, compoundBadge, COMPOUND_NAME, saveSetupNote, canSaveSetups } = window.RaceWidgets;

  const show = (v) => (isNum(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : '–');
  const signedChange = (c) => `${c > 0 ? '+' : '−'}${Math.abs(c)}`;

  W.setup = {
    title: 'Setup',
    description: 'Your car\'s setup against the community sheet\'s for this track: green is right, red needs changing',
    tall: true,
    bare: true,
    mount(el) {
      const r = template(el, `
        <div class="w-su">
          <section class="w-su__card w-su__top">
            <span class="w-label">Setup</span>
            <div class="w-su__head"><b data-ref="title">Setup</b><span data-ref="status"></span></div>
            <div class="w-su__mine" data-ref="mine" hidden>
              <button type="button" class="w-su__star" data-ref="star" aria-pressed="false" aria-label="Mark this setup as a favorite">☆</button>
              <span class="w-su__mine-label">This setup</span>
              <button type="button" class="w-su__mine-name" data-ref="mineName" title="Name this setup"></button>
              <span class="w-su__mine-err" data-ref="mineErr" role="status"></span>
            </div>
          </section>
          <p class="w-su__card w-su__msg" data-ref="msg" hidden></p>
          <section class="w-su__card w-su__block" data-ref="blockNow"><span class="w-label">Now</span><div class="w-su__grid" data-ref="now"></div></section>
          <section class="w-su__card w-su__block" data-ref="blockWant"><span class="w-label">Suggested</span><div class="w-su__grid" data-ref="want"></div></section>
          <section class="w-su__card w-su__block" data-ref="blockBest" hidden><span class="w-label" data-ref="bestLabel">Your fastest here</span><div class="w-su__grid" data-ref="best"></div></section>
          <p class="w-su__card w-su__note" data-ref="note"></p>
        </div>`);
      const cell = (label, value, cls) => {
        const d = document.createElement('div');
        d.className = `w-su__cell${cls ? ` ${cls}` : ''}`;
        const l = document.createElement('span');
        l.textContent = label;
        const v = document.createElement('b');
        v.textContent = value;
        d.append(l, v);
        return d;
      };
      // Naming and starring the setup on the car, so it lands in the Setups library (the desktop app saves it, and so does a phone
      // that scanned the pairing QR code; any other device cannot).
      let cur = null;
      let renaming = false;
      const save = async (input) => {
        r.mineErr.textContent = '';
        try {
          await saveSetupNote({ trackId: cur.trackId, key: cur.key, values: cur.values, ...input });
        } catch (err) {
          r.mineErr.textContent = String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^setup note: /, '');
        }
      };
      r.star.addEventListener('click', () => { if (cur) save({ favorite: !cur.favorite }); });
      r.mineName.addEventListener('click', () => {
        if (!cur || renaming) return;
        renaming = true;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'w-su__rename';
        input.maxLength = 60;
        input.value = cur.name;
        input.setAttribute('aria-label', 'Setup name');
        const done = () => { renaming = false; input.remove(); r.mineName.hidden = false; };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const name = input.value.trim();
            done();
            save({ name });
          } else if (e.key === 'Escape') {
            e.stopPropagation(); // cancels the rename only
            done();
          }
        });
        input.addEventListener('blur', () => { if (renaming) done(); });
        r.mineName.hidden = true;
        r.mineName.after(input);
        input.focus();
      });

      return (s) => {
        const su = s.setup;
        cur = su && su.current ? su.current : null;
        r.mine.hidden = !(cur && canSaveSetups());
        if (cur) {
          r.star.setAttribute('aria-pressed', String(cur.favorite));
          setText(r.star, cur.favorite ? '★' : '☆');
          r.mine.classList.toggle('is-favorite', cur.favorite);
          if (!renaming) setText(r.mineName, cur.name || 'Name this setup');
        }
        // Your own fastest clean lap at this track in an earlier session, and the setup behind it: green where the car
        // has the same value now, red with the change that gets back to it.
        const hist = su && su.history;
        r.blockBest.hidden = !hist;
        if (hist) {
          const bits = [fmtLap(hist.lapMs), COMPOUND_NAME && COMPOUND_NAME[hist.compound], hist.session].filter(Boolean);
          setText(r.bestLabel, `Your fastest here · ${bits.join(' · ')}`);
          const sig = JSON.stringify(hist.rows.map((x) => [x.key, x.value, x.current, x.ok]));
          if (r.best.dataset.sig !== sig) {
            r.best.dataset.sig = sig;
            r.best.replaceChildren(...hist.rows.map((x) => cell(x.label, x.value == null ? '–' : x.ok === false ? `${show(x.value)} (${signedChange(x.change)})` : show(x.value), x.ok === true ? 'is-ok' : x.ok === false ? 'is-off' : '')));
          }
        }
        const show2 = (on) => { r.blockNow.hidden = !on; r.blockWant.hidden = !on; };
        if (!su || !su.available) {
          show2(false);
          r.msg.hidden = false;
          setText(r.title, 'Setup');
          setText(r.status, '');
          r.msg.hidden = !!hist && !su.source; // history alone is a fine answer without a sheet
          setText(r.msg, !su || !su.source
            ? 'No setup sheet yet. In Settings, choose Import setups and pick the setups spreadsheet (.xlsx).'
            : `The sheet has no setup for ${su.track || 'this track'}.`);
          setText(r.note, '');
          return;
        }
        show2(true);
        r.msg.hidden = true;
        setText(r.title, `${su.circuit} · ${su.kind === 'q' ? 'Qualifying' : 'Race'} setup`);
        setText(r.status, su.off === 0 ? 'Matches the sheet' : `${su.off} to change`);
        r.status.className = su.off === 0 ? 'is-good' : 'is-act';
        const sig = JSON.stringify(su.rows.map((x) => [x.key, x.current, x.target, x.ok]));
        if (r.now.dataset.sig !== sig) {
          r.now.dataset.sig = sig;
          r.now.replaceChildren(...su.rows.map((x) => cell(x.label, show(x.current), x.ok === true ? 'is-ok' : x.ok === false ? 'is-off' : '')));
          r.want.replaceChildren(...su.rows.map((x) => cell(x.label, x.target == null ? '–' : x.ok === false ? `${x.target} (${signedChange(x.change)})` : x.target, x.ok === true ? 'is-ok' : x.ok === false ? 'is-off' : '')));
        }
        const bits = [];
        if (!su.editable) bits.push('The car can\'t be changed in a race.');
        if (su.notes) bits.push(`Sheet note: ${su.notes}`);
        setText(r.note, bits.join(' '));
      };
    },
  };

  // ---------- Briefing ----------
  // What your own earlier sessions at this track say (snapshot.briefing, src/analysis/briefing.js): a few plain lines.
  W.brief = {
    title: 'Briefing',
    description: 'Before the race: your history at this track, the usual number of stops, the pit stop cost and tyre wear',
    tall: true,
    bare: true,
    mount(el) {
      const r = template(el, `
        <div class="w-brief">
          <section class="w-brief__head"><span class="w-label">Briefing</span><div class="w-su__head"><b data-ref="title">Briefing</b></div></section>
          <p class="w-brief__msg" data-ref="msg" hidden></p>
          <div class="w-brief__grid" data-ref="grid"></div>
        </div>`);
      const cell = (label, value, note) => {
        const d = document.createElement('div');
        d.className = 'w-brief__cell';
        const l = document.createElement('span');
        l.textContent = label;
        const v = document.createElement('b');
        v.textContent = value;
        d.append(l, v);
        if (note) {
          const n = document.createElement('small');
          n.textContent = note;
          d.append(n);
        }
        return d;
      };
      return (s) => {
        const b = s.briefing;
        setText(r.title, b && b.track ? `Briefing · ${b.track}` : 'Briefing');
        // What it has to say, as labelled figures; a figure the store does not have is left out rather than shown as a dash.
        const plain = !b ? 'Nothing to compare with yet: the race store is not available.'
          : !b.sessions ? `This is your first time at ${b.track || 'this track'}: nothing to compare with yet.` : null;
        r.msg.hidden = !plain;
        setText(r.msg, plain || '');
        const cells = [];
        if (b && b.sessions) {
          cells.push(['Here before', `${b.sessions} session${b.sessions === 1 ? '' : 's'}`, `${b.races} race${b.races === 1 ? '' : 's'}`]);
          if (b.bestLapMs) cells.push(['Best lap', fmtLap(b.bestLapMs)]);
          if (b.bestFinish) cells.push(['Best finish', `P${b.bestFinish}`]);
          if (b.last) cells.push(['Last race', `P${b.last.grid ?? '–'} → P${b.last.finish ?? '–'}`, new Date(b.last.startedAt).toLocaleDateString()]);
          if (b.stops != null) cells.push(['Usual stops', String(b.stops)]);
          if (b.pitLossS != null) cells.push(['Pit stop cost', `${b.pitLossS} s`]);
          for (const w of b.wear) cells.push([`${COMPOUND_NAME[w.compound]} wear`, `+${(w.msPerLap / 1000).toFixed(3)} s`, 'a lap']);
        }
        const sig = JSON.stringify(cells);
        if (r.grid.dataset.sig !== sig) {
          r.grid.dataset.sig = sig;
          r.grid.replaceChildren(...cells.map((c) => cell(...c)));
        }
      };
    },
  };

  // ---------- Tyre sets ----------
  // The sets you can still fit (snapshot player.tyreSets, from the game's Tyre Sets packet): the one on the car first, then
  // softest first and freshest first, each with its wear, the laps of life the game gives it, and its pace against the fitted set.
  const SOFTEST = { 16: 0, 17: 1, 18: 2, 7: 3, 8: 4 };
  W.tyresets = {
    title: 'Tyre sets',
    description: 'The sets you have left: wear, laps of life and pace against the set on the car',
    tall: true,
    bare: true,
    mount(el) {
      const r = template(el, `
        <div class="w-brief w-ts">
          <section class="w-brief__head"><span class="w-label">Tyre sets</span><p class="w-ts__sum" data-ref="sum"></p></section>
          <div class="w-ts__list" data-ref="list"></div>
        </div>`);
      const span = (cls, text) => {
        const n = document.createElement('span');
        n.className = cls;
        n.textContent = text;
        return n;
      };
      const pace = (x) => (x.fitted ? 'Fitted' : Math.abs(x.deltaMs) < 50 ? 'Same pace' : `${(Math.abs(x.deltaMs) / 1000).toFixed(2)}s ${x.deltaMs < 0 ? 'faster' : 'slower'}`);
      return (s) => {
        const list = (s.player && s.player.tyreSets) || null;
        const sorted = list ? [...list].sort((a, b) => b.fitted - a.fitted || (SOFTEST[a.compound] ?? 9) - (SOFTEST[b.compound] ?? 9) || a.wear - b.wear) : [];
        const left = sorted.filter((x) => !x.fitted);
        const count = (c) => left.filter((x) => x.compound === c).length;
        const parts = [16, 17, 18, 7, 8].filter(count).map((c) => `${count(c)} ${COMPOUND_NAME[c].toLowerCase()}`);
        setText(r.sum, !list ? 'Shows up once the game sends your tyre sets (in the garage, or on track).'
          : left.length ? `${left.length} set${left.length === 1 ? '' : 's'} left: ${parts.join(', ')}` : 'No other sets left');
        const sig = JSON.stringify(sorted);
        if (r.list.dataset.sig === sig) return;
        r.list.dataset.sig = sig;
        r.list.replaceChildren(...sorted.map((x) => {
          const row = document.createElement('div');
          row.className = `w-ts__row${x.fitted ? ' is-fitted' : ''}`;
          const badge = compoundBadge(x.compound);
          badge.classList.add('compound--lg');
          row.append(badge, span('w-ts__wear', x.wear ? `${x.wear}% worn` : 'New'), span('w-ts__life', `${x.lapsLeft} laps`), span('w-ts__pace', pace(x)));
          return row;
        }));
      };
    },
  };
})();
