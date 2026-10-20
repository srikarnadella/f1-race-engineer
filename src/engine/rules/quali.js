const { SEVERITY, CATEGORY } = require('./cards');
const { standing } = require('../calls');

/** @typedef {import('./cards').RuleContext} RuleContext */

// --- Qualifying / practice: traffic on the road, a new best ---
/** @param {RuleContext} ctx */
function quali({ q, mem, settled, upsert, expire, clock }) {
  const tr = q && q.traffic;
  const inTheWay = tr && (tr.ahead || tr.behind);
  if (inTheWay && settled('traffic', inTheWay.name)) {
    upsert('traffic', {
      severity: SEVERITY.INFO,
      category: CATEGORY.PACE,
      message: tr.ahead
        // The gap ticks on the This lap panel; here it would rewrite the card every tick.
        ? `Traffic: ${tr.ahead.name} on ${tr.ahead.status === 'out' ? 'an out lap' : tr.ahead.status === 'in' ? 'an in lap' : 'a slow lap'} up the road`
        : `${tr.behind.name} on a push lap behind - let them by`,
      expiresAtMs: clock() + 4000,
    });
  } else if (!inTheWay) {
    expire('traffic');
  }
  // A first time or a quicker one - but not the time already set when the dashboard joined.
  if (q && mem.qualiSeen && q.bestMs && (mem.qualiBestMs == null || q.bestMs < mem.qualiBestMs)) {
    const m = Math.floor(q.bestMs / 60000);
    upsert('quali-best', {
      severity: SEVERITY.INFO,
      category: CATEGORY.PACE,
      message: `Best lap ${m}:${((q.bestMs % 60000) / 1000).toFixed(3).padStart(6, '0')} - ${standing(q)}`,
      expiresAtMs: clock() + 10000,
    });
  }
  if (q) {
    mem.qualiSeen = true;
    if (q.bestMs) mem.qualiBestMs = q.bestMs;
  }
}

module.exports = { quali };
