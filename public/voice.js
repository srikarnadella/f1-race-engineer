// The engineer's voice and ears: radio calls read aloud, "Ask the engineer"
// (spoken or tapped), your own voice commands, and hands-free ("Engineer, ...").
// app.js creates it once and hands it the page helpers it shares.
(function () {
  'use strict';

  const { setText } = window.RaceWidgets;

  /** @param {{ $: (id: string) => any, inField: (e: Event) => boolean, STORE: Record<string, string>, load: (key: string, fallback: any) => any, save: (key: string, value: any) => void, snapshot: () => any }} page */
  function create({ $, inField, STORE, load, save, snapshot }) {
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
    let lastSpokeAt = 0;

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
    // force: an answer the driver asked for is spoken even with the radio voice off.
    function say(text, urgent, force = false) {
      if (!voiceSupported || (voiceMode === 'off' && !force)) return;
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
        lastSpokeAt = Date.now();
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
    const ersMode = (msg) => (msg.match(/Overtake|Boost|Medium|Hotlap|None|save/i) || [''])[0].toLowerCase();
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
      if (snapshot()) {
        for (const i of snapshot().insights || []) spoken.set(i.id, voiceKey(i));
        lastSpokenCall = snapshot().strategy ? snapshot().strategy.call.action : lastSpokenCall;
      }
      if (voiceMode !== 'off') say(voiceMode === 'key' ? 'Radio check. Key calls only.' : 'Radio check. All calls.', true);
    });
    renderVoiceButton();

    // ---------- Ask the engineer ----------
    // Tap Ask (or press Q), speak - "gap behind?", "when do I box?" - and the
    // answer is said and shown. The question is matched in ask.js against the
    // latest snapshot, on this device. The speech-to-text is the browser's,
    // usually its maker's servers (Chrome: Google), so it listens only on a tap.
    // Browsers only open the microphone on a secure page - the PC's own
    // browser (localhost) or https - so elsewhere the questions are buttons.
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const canListen = !!Recognition && window.isSecureContext;
    const ASK_SHEET_MS = 15000;
    let recognition = null;
    let askTimer = null;
    function closeAsk() {
      clearTimeout(askTimer);
      if (recognition) recognition.abort();
      $('ask-sheet').hidden = true;
    }
    function keepAskOpen() {
      clearTimeout(askTimer);
      askTimer = setTimeout(() => { if (!recognition) closeAsk(); }, ASK_SHEET_MS);
    }
    function answer(question) {
      const { reply } = window.RaceAsk.ask(question, snapshot(), commands);
      setText($('ask-reply'), reply);
      say(reply, true, true);
      keepAskOpen();
    }
    function listen() {
      if (recognition) return recognition.stop();
      stopHandsFree(); // one microphone at a time; it restarts when this question is done
      if (voiceSupported) {
        window.speechSynthesis.cancel(); // don't transcribe the engineer's own voice
        voiceQueue.length = 0;
        speaking = false;
      }
      const rec = new Recognition();
      recognition = rec;
      rec.lang = navigator.language || 'en-GB';
      rec.interimResults = false;
      rec.maxAlternatives = 3;
      let heard = false;
      $('ask-mic').classList.add('is-on');
      setText($('ask-mic-text'), 'Listening');
      setText($('ask-heard'), 'Listening…');
      setText($('ask-reply'), '');
      rec.onresult = (e) => {
        heard = true;
        // Of the recogniser's guesses, the first that is a question we know.
        const guesses = [...e.results[0]].map((x) => x.transcript);
        const q = guesses.find((t) => window.RaceAsk.ask(t, null, commands).id) || guesses[0];
        setText($('ask-heard'), `"${q}"`);
        answer(q);
      };
      rec.onerror = (e) => {
        heard = true;
        setText($('ask-heard'), e.error === 'not-allowed' || e.error === 'service-not-allowed'
          ? 'Microphone blocked - allow it for this page, or tap a question.'
          : e.error === 'no-speech' ? 'Heard nothing - tap Speak and ask.' : `Couldn't listen (${e.error}) - tap a question.`);
      };
      rec.onend = () => {
        recognition = null;
        $('ask-mic').classList.remove('is-on');
        setText($('ask-mic-text'), 'Speak');
        if (!heard) setText($('ask-heard'), 'Heard nothing - tap Speak and ask.');
        keepAskOpen();
        startHandsFree();
      };
      try {
        rec.start();
      } catch (_) {
        recognition = null; // already listening in another tab, or blocked
      }
    }
    function openAsk(andListen) {
      $('ask-sheet').hidden = false;
      $('ask-mic').hidden = !canListen;
      if (!canListen) setText($('ask-heard'), Recognition ? 'Voice questions need the PC\'s own browser or an https page - tap a question.' : 'Tap a question.');
      keepAskOpen();
      if (andListen && canListen) listen();
    }
    // Your commands first, then the built-in questions - each a one-tap button.
    function renderAskButtons() {
      const button = (label, question, mine) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        if (mine) b.className = 'is-mine';
        b.addEventListener('click', () => {
          setText($('ask-heard'), label);
          answer(question);
        });
        return b;
      };
      $('ask-qs').replaceChildren(
        ...commands.map((c) => button(`"${c.phrase}"`, c.phrase, true)),
        ...window.RaceAsk.QUESTIONS.map((q) => button(q.label, q.id, false)),
      );
    }

    // ---------- Your voice commands (Settings) ----------
    // A phrase and the things it reports: "Engineer, status" -> gap ahead,
    // gap behind, tyres, read out in one go. Saved on this device.
    let commands = (load(STORE.commands, []) || []).map(window.RaceAsk.cleanCommand).filter(Boolean);
    const reportLabel = Object.fromEntries(window.RaceAsk.REPORTS.map((r) => [r.id, r.label]));
    $('cmd-reports').replaceChildren(...window.RaceAsk.REPORTS.map((r) => {
      const l = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = r.id;
      l.append(box, r.label);
      return l;
    }));
    function renderCommands() {
      $('cmds').replaceChildren(...commands.map((c, i) => {
        const li = document.createElement('li');
        const phrase = document.createElement('b');
        phrase.textContent = `"Engineer, ${c.phrase}"`;
        const what = document.createElement('span');
        what.className = 'dim';
        what.textContent = c.reports.map((id) => reportLabel[id]).join(' · ');
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'tool';
        del.textContent = 'Remove';
        del.addEventListener('click', () => {
          commands.splice(i, 1);
          save(STORE.commands, commands);
          renderCommands();
        });
        li.append(phrase, what, del);
        return li;
      }));
      renderAskButtons();
    }
    $('cmd-save').addEventListener('click', () => {
      const picked = [...$('cmd-reports').querySelectorAll('input:checked')].map((/** @type {HTMLInputElement} */ x) => x.value);
      const c = window.RaceAsk.cleanCommand({ phrase: $('cmd-phrase').value, reports: picked });
      if (!c) {
        setText($('cmd-note'), !picked.length ? 'Tick at least one thing to report.' : 'Pick a phrase of a word or more (not "engineer").');
        return;
      }
      // The same phrase again replaces the old command.
      commands = [...commands.filter((x) => x.phrase !== c.phrase), c];
      save(STORE.commands, commands);
      $('cmd-phrase').value = '';
      $('cmd-reports').querySelectorAll('input').forEach((x) => { x.checked = false; });
      setText($('cmd-note'), `Added. Say "Engineer, ${c.phrase}".`);
      renderCommands();
    });
    renderCommands();
    $('ask').addEventListener('click', () => ($('ask-sheet').hidden ? openAsk(true) : closeAsk()));
    $('ask-mic').addEventListener('click', listen);
    $('ask-close').addEventListener('click', closeAsk);
    // Q: push-to-talk from a keyboard, or a wheel button mapped to it.
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'q' || e.key === 'Q') && !e.repeat && !inField(e) && $('settings-sheet').hidden) openAsk(true);
    });

    // ---------- Hands-free: "Engineer, ..." ----------
    // For when no button can be reached: listens all the time, acts only on
    // what follows "Engineer". Off by default - while it's on, the browser
    // streams the microphone to its speech service (Chrome: Google).
    // What it hears while the engineer is talking (or just after) is
    // ignored, so it never answers its own voice. Chrome ends a listening
    // session after a minute or so of silence, so it restarts itself.
    const FOLLOW_UP_MS = 7000;
    const ECHO_MS = 1200;
    let handsFree = canListen && load(STORE.handsFree, false) === true;
    let wakeRec = null;
    let wakeStartedAt = 0;
    let restartMs = 300;
    let awaitingUntil = 0;
    function onPhrase(text) {
      if (speaking || (voiceSupported && window.speechSynthesis.speaking) || Date.now() - lastSpokeAt < ECHO_MS) return;
      let q = window.RaceAsk.afterWake(text);
      if (q == null && Date.now() < awaitingUntil) q = text.trim(); // the question after a bare "Engineer"
      if (q == null) return;
      openAsk(false);
      if (!q) {
        awaitingUntil = Date.now() + FOLLOW_UP_MS;
        setText($('ask-heard'), 'Go ahead…');
        setText($('ask-reply'), '');
        say('Go ahead.', true, true);
        return;
      }
      awaitingUntil = 0;
      setText($('ask-heard'), `"${q}"`);
      answer(q);
    }
    function startHandsFree() {
      if (!handsFree || wakeRec || recognition) return;
      const rec = new Recognition();
      wakeRec = rec;
      rec.lang = navigator.language || 'en-GB';
      rec.continuous = true;
      rec.interimResults = false;
      rec.maxAlternatives = 3;
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (!e.results[i].isFinal) continue;
          // Of the guesses, prefer one that has the wake word in it.
          const guesses = [...e.results[i]].map((x) => x.transcript);
          onPhrase(guesses.find((t) => window.RaceAsk.afterWake(t) != null) || guesses[0]);
        }
      };
      rec.onerror = (e) => {
        if (e.error !== 'not-allowed' && e.error !== 'service-not-allowed') return;
        handsFree = false; // blocked: stop retrying, but keep the saved choice for when it's allowed
        renderHandsFree('Microphone blocked - allow it for this page, then turn this on again.');
      };
      rec.onend = () => {
        if (wakeRec !== rec) return;
        wakeRec = null;
        // A normal timeout restarts at once; a session that dies straight away backs off.
        restartMs = Date.now() - wakeStartedAt > 5000 ? 300 : Math.min(10000, restartMs * 2);
        if (handsFree) setTimeout(startHandsFree, restartMs);
      };
      wakeStartedAt = Date.now();
      try {
        rec.start();
      } catch (_) {
        wakeRec = null;
      }
      renderHandsFree();
    }
    function stopHandsFree() {
      const rec = wakeRec;
      wakeRec = null;
      if (rec) rec.abort();
    }
    function renderHandsFree(note) {
      $('ask').classList.toggle('is-listening', handsFree);
      setText($('ask'), handsFree ? 'Ask · on' : 'Ask');
      $('ask').title = handsFree ? 'Hands-free: say "Engineer, ..."' : '';
      $('set-handsfree').checked = handsFree;
      $('set-handsfree').disabled = !canListen;
      setText($('handsfree-note'), note || (canListen ? '' : 'Not available on this page: open the dashboard in a browser on the PC itself (http://localhost:8080), or on an https page.'));
    }
    $('set-handsfree').addEventListener('change', (e) => {
      handsFree = $('set-handsfree').checked && canListen;
      save(STORE.handsFree, handsFree);
      if (handsFree) startHandsFree();
      else stopHandsFree();
      renderHandsFree();
    });
    renderHandsFree();
    startHandsFree();

    return { voiceInsights, closeAsk };
  }

  window.RaceVoice = { create };
})();
