const { SEVERITY, CATEGORY } = require('./cards');
const { CHEAP_STOP_MIN_LAPS_LEFT } = require('./strategy');

/** @typedef {import('./cards').RuleContext} RuleContext */

// Damage costing less than this a lap is within lap-to-lap noise.
const DAMAGE_NOISE_MS = 150;
const DAMAGE_ADVISORY_MS = 500;
// A front wing this broken is worth a stop before it's even measured.
const WING_HEAVY_PCT = 50;
const DAMAGE_STAGES = ['damage:measuring', 'damage:cost'];

// --- Damage: what it's costing, measured from your mini-sectors ---
// One card per stage ("measuring", then the figure), so each is said once
// and the number can firm up on screen without being read out again.
/** @param {RuleContext} ctx */
function damage({ analysis, playerOnTrack, finished, racing, lapsLeft, out, upsert, expire, clock }) {
  const dmg = analysis && analysis.damage;
  let damageBox = null;
  let damageCard = null;
  if (dmg && playerOnTrack && !finished) {
    const what = dmg.parts.map((x) => `${x.label.toLowerCase()} ${x.pct}%`).join(', ');
    const loss = dmg.lossPerLapMs;
    const heavyWing = dmg.parts.some((x) => x.fixable && x.pct >= WING_HEAVY_PCT);
    if (loss == null) {
      damageCard = { id: 'damage:measuring', message: `Damage: ${what} - ${dmg.basis === 'no-baseline' ? 'no clean lap before it to measure against' : 'measuring what it costs'}` };
      if (racing && heavyWing && dmg.basis === 'no-baseline' && (lapsLeft == null || lapsLeft > CHEAP_STOP_MIN_LAPS_LEFT)) damageBox = 'Heavy front wing damage - box for a new nose';
    } else if (loss < DAMAGE_NOISE_MS) {
      damageCard = { id: 'damage:cost', message: `Damage: ${what} - not costing lap time` };
    } else {
      const where = dmg.where.length ? `, most of it at corner${dmg.where.length > 1 ? 's' : ''} ${dmg.where.join(' and ')}` : '';
      const flag = dmg.toFlagMs ? ` (~${Math.round(dmg.toFlagMs / 1000)}s to the flag)` : '';
      let verdict = '';
      if (dmg.fix) {
        if (dmg.fix.pays && dmg.fix.stopAnyway) verdict = ' - change the nose at your stop';
        else if (dmg.fix.pays) verdict = ` - a new nose costs ~${Math.round(dmg.fix.costMs / 1000)}s: box`;
        else verdict = ` - a new nose costs ~${Math.round(dmg.fix.costMs / 1000)}s: stay out`;
      }
      if (racing && dmg.fix && dmg.fix.pays && !dmg.fix.stopAnyway) damageBox = `Front wing costing ~${(loss / 1000).toFixed(1)}s a lap - a new nose pays back`;
      damageCard = { id: 'damage:cost', severity: loss >= DAMAGE_ADVISORY_MS ? SEVERITY.ADVISORY : SEVERITY.INFO, message: `Damage costing ~${(loss / 1000).toFixed(1)}s a lap${dmg.basis === 'partial' ? ' (early read)' : ''}${where}${flag}${verdict}` };
    }
  }
  for (const id of DAMAGE_STAGES) if (!damageCard || damageCard.id !== id) expire(id);
  if (damageCard) {
    upsert(damageCard.id, { severity: damageCard.severity || (damageBox ? SEVERITY.ADVISORY : SEVERITY.INFO), category: CATEGORY.CAR, message: damageCard.message, expiresAtMs: clock() + 5000 });
  }
  out.damageBox = damageBox;
}

module.exports = { damage };
