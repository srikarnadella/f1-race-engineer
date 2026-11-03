// Ask the race (roadmap L2): the local model through Ollama on this PC, only when asked and never
// while you race - it uses the GPU the game needs. Every answer ends by unloading the model
// (keep_alive 0), whether it finished, failed or was stopped; within one answer the tool rounds keep
// it warm for a minute so it doesn't reload from disk for each tool call. A live session refuses
// questions without reaching Ollama, and its start stops any answer and unloads whatever is loaded.
const INSTALL_URL = 'https://ollama.com/download';
const MAX_ROUNDS = 4; // tool rounds per answer; the last one gets no tools, so it must answer
const WARM_WITHIN_ANSWER = '1m';

/** @param {{ host?: string, isLive?: () => boolean, timeoutMs?: number }} [opts] */
function createOllama({ host = 'http://127.0.0.1:11434', isLive = () => false, timeoutMs = 180000 } = {}) {
  let used = false; // never touch Ollama on a session start unless it was used this run
  /** @type {{ controller: AbortController, done: Promise<unknown> } | null} */
  let current = null;

  async function request(p, body, signal) {
    const res = await fetch(host + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal } : { signal });
    if (!res.ok) throw new Error(`Ollama ${p}: HTTP ${res.status}`);
    return res.json();
  }
  const unload = (model) => request('/api/generate', { model, keep_alive: 0 }).catch(() => {});

  async function detect() {
    try {
      const v = await request('/api/version', null, AbortSignal.timeout(2000));
      return { installed: true, version: v.version };
    } catch {
      return { installed: false, installUrl: INSTALL_URL };
    }
  }
  const models = async () => (await request('/api/tags')).models || [];

  // tools: { schemas, run(name, args) } (src/llm/tools.js). Returns { answer, toolCalls }.
  function ask({ model, question, tools = null, system = null }) {
    if (isLive()) return Promise.reject(new Error('Ask the race is not while you race: it uses the GPU the game needs. Ask after the session.'));
    if (current) return Promise.reject(new Error('Already answering a question'));
    used = true;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: question }];
    const toolCalls = [];
    const run = async () => {
      try {
        for (let round = 0; ; round++) {
          const last = round === MAX_ROUNDS - 1;
          const res = await request('/api/chat', { model, messages, stream: false, keep_alive: WARM_WITHIN_ANSWER, ...(tools && !last ? { tools: tools.schemas } : {}) }, signal);
          const msg = res.message || {};
          const calls = msg.tool_calls || [];
          if (!calls.length || last) return { answer: msg.content || '', toolCalls };
          messages.push(msg);
          for (const c of calls) {
            const name = c.function && c.function.name;
            let args = (c.function && c.function.arguments) || {};
            if (typeof args === 'string') {
              try { args = JSON.parse(args); } catch { args = {}; }
            }
            const result = tools ? tools.run(name, args) : { error: 'No tools' };
            toolCalls.push({ name, args, result });
            messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(result) });
          }
        }
      } catch (err) {
        if (controller.signal.aborted) throw new Error('Stopped');
        if (signal.aborted) throw new Error('The model took too long to answer');
        throw err;
      } finally {
        await unload(model);
        current = null;
      }
    };
    const done = run();
    current = { controller, done };
    return done;
  }

  // The Stop button: cancel the answer; resolves once the model is unloaded.
  async function stop() {
    if (!current) return;
    const { controller, done } = current;
    controller.abort();
    await done.catch(() => {});
  }

  // A live session started: nothing of the model stays in memory while you race.
  async function sessionStarted() {
    if (!used) return;
    await stop();
    try {
      const ps = await request('/api/ps', null, AbortSignal.timeout(2000));
      await Promise.all((ps.models || []).map((m) => unload(m.name || m.model)));
    } catch { /* Ollama not running: nothing loaded */ }
  }

  // Downloads (L3) through Ollama: progress as a fraction of every layer's bytes; cancel by name.
  const pulls = new Map(); // model -> AbortController
  async function pull(model, onProgress) {
    if (isLive()) throw new Error('Downloads are not while you race: they use the disk and network the game needs. Download after the session.');
    if (pulls.has(model)) throw new Error('Already downloading');
    const controller = new AbortController();
    pulls.set(model, controller);
    const layers = new Map(); // digest -> { total, completed }
    let last = 0;
    try {
      const res = await fetch(`${host}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`Ollama /api/pull: HTTP ${res.status}`);
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const m = JSON.parse(line);
          if (m.error) throw new Error(m.error);
          if (m.digest && m.total) layers.set(m.digest, { total: m.total, completed: m.completed || 0 });
          let total = 0;
          let done = 0;
          for (const l of layers.values()) {
            total += l.total;
            done += l.completed;
          }
          // A layer met later adds to the total; the bar never moves back for it.
          const fraction = m.status === 'success' ? 1 : Math.max(last, total ? Math.min(0.99, done / total) : 0);
          last = fraction;
          onProgress({ status: m.status, fraction, completed: done, total });
        }
      }
      if (last !== 1) throw new Error('The download ended early');
    } catch (err) {
      if (controller.signal.aborted) throw new Error('Download cancelled');
      throw err;
    } finally {
      pulls.delete(model);
    }
  }
  const cancelPull = (model) => {
    const c = pulls.get(model);
    if (c) c.abort();
  };
  async function remove(model) {
    const res = await fetch(`${host}/api/delete`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) });
    if (!res.ok && res.status !== 404) throw new Error(`Ollama /api/delete: HTTP ${res.status}`);
  }

  return { detect, models, ask, stop, sessionStarted, pull, cancelPull, remove, busy: () => !!current, installUrl: INSTALL_URL };
}

module.exports = { createOllama, INSTALL_URL };
