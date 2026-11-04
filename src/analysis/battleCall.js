// ATTACK / DEFEND / CLOSE IN / CLEAR - what to do about the cars either side,
// right now. Built from the gaps, the closing rates (clean-lap pace), the
// overtake model's pass and threat chances, 2026 Overtake mode, battery, and
// the attack forecast's corner.

const IN_RANGE_S = 1.0;
const CLEAR_S = 2.0;
// This close it's a fight whatever the trend or model says (and early in a
// stint there's no clean-lap trend yet).
const TOUCHING_S = 0.6;
// Battery at the line to attack on - the ERS card's "harvest this lap" below it, so the two agree.
const ATTACK_MIN_PCT = 40;

const levelRank = { low: 0, medium: 1, high: 2 };

// The pass chance in words, with the range the model's noisy inputs allow (analysis battle.attack.range):
// "medium" alone when the whole range is one level, "low to high" when it spans them. soft: the call
// rests on a chance that could be a different level.
function chanceWords(c) {
  const r = c && c.range;
  if (!c || !r || r.levelLo === r.levelHi) return { text: c ? c.level : '', soft: false };
  return { text: `${r.levelLo} to ${r.levelHi}`, soft: true };
}
// Two chances whose ranges overlap can't be told apart: the sandwich call between them is a toss-up.
const overlap = (x, y) => !!(x && y && x.range && y.range && x.range.lo <= y.range.hi && y.range.lo <= x.range.hi);

// a: the snapshot's analysis; ahead/behind: field rows; player: snapshot player.
// lapsLeft: to the flag - a forecast past it is no forecast.
/** @param {{ [k: string]: any, battle?: any, lapsLeft?: number | null }} args */
function battleCall({ ahead, behind, gapAheadS, gapBehindS, battle = {}, overtakeAvailable, batteryPct, neutralised, lapsLeft = null }) {
  if (neutralised) return null;
  const attackP = battle.attack ? battle.attack.p : 0;
  const threatP = battle.defend ? battle.defend.p : 0;
  const atkLevel = battle.attack ? levelRank[battle.attack.level] : 0;
  const defLevel = battle.defend ? levelRank[battle.defend.level] : 0;
  const closingAhead = ahead && ahead.gapTrendMsPerLap != null ? -ahead.gapTrendMsPerLap / 1000 : 0; // + = you're catching
  const closingBehind = behind && behind.gapTrendMsPerLap != null ? -behind.gapTrendMsPerLap / 1000 : 0; // + = they're catching
  const corner = (fc) => (fc && fc.where ? ` into corner ${fc.where.corner}` : '');
  const name = (row) => (row ? row.name : '');

  const canAttack = ahead && !ahead.pitStatus && gapAheadS > 0 && gapAheadS <= IN_RANGE_S
    && (atkLevel >= 1 || overtakeAvailable || closingAhead >= 0.2 || gapAheadS <= TOUCHING_S) && !(batteryPct != null && batteryPct < ATTACK_MIN_PCT && !overtakeAvailable);
  const mustDefend = behind && !behind.pitStatus && gapBehindS > 0 && gapBehindS <= IN_RANGE_S
    && (defLevel >= 1 || closingBehind >= 0.2 || behind.overtakeAvailable || gapBehindS <= TOUCHING_S);

  if (canAttack && mustDefend) {
    // Sandwiched: go for it only when the chance ahead beats the threat
    // behind and there's battery to do it; otherwise protect the place.
    const confidence = overlap(battle.attack, battle.defend) ? 'soft' : 'firm';
    if (attackP >= threatP && (batteryPct == null || batteryPct >= ATTACK_MIN_PCT)) {
      return { mode: 'ATTACK', target: name(ahead), reason: `${name(behind)} close behind - make it stick${corner(battle.attackForecast)}`, confidence };
    }
    return { mode: 'DEFEND', target: name(behind), reason: `cover first, ${name(ahead)} is within reach after${corner(battle.defendForecast) ? ` - watch${corner(battle.defendForecast)}` : ''}`, confidence };
  }
  if (canAttack) {
    const words = chanceWords(battle.attack);
    const onChance = !overtakeAvailable && atkLevel >= 1;
    const why = overtakeAvailable ? 'Overtake mode ready' : atkLevel >= 1 ? `pass chance ${words.text}` : closingAhead >= 0.2 ? `catching ${closingAhead.toFixed(1)}s/lap` : `${gapAheadS.toFixed(1)}s ahead`;
    return { mode: 'ATTACK', target: name(ahead), reason: `${why}${corner(battle.attackForecast)}`, confidence: onChance && words.soft ? 'soft' : 'firm' };
  }
  if (mustDefend) {
    const words = chanceWords(battle.defend);
    const onChance = !behind.overtakeAvailable && defLevel >= 1;
    const why = behind.overtakeAvailable ? 'they have Overtake mode' : defLevel >= 1 ? `threat ${words.text}` : closingBehind >= 0.2 ? `catching ${closingBehind.toFixed(1)}s/lap` : `${gapBehindS.toFixed(1)}s behind`;
    return { mode: 'DEFEND', target: name(behind), reason: `${why}${corner(battle.defendForecast) ? ` - watch${corner(battle.defendForecast)}` : ''}`, confidence: onChance && words.soft ? 'soft' : 'firm' };
  }
  if (ahead && gapAheadS > IN_RANGE_S && closingAhead >= 0.15 && battle.attackForecast && battle.attackForecast.when.laps > 0 && !(lapsLeft != null && battle.attackForecast.when.laps >= lapsLeft)) {
    return { mode: 'CLOSE IN', target: name(ahead), reason: `in range ${battle.attackForecast.when.text}` };
  }
  if ((!ahead || gapAheadS > CLEAR_S) && (!behind || gapBehindS > CLEAR_S)) {
    return { mode: 'CLEAR', target: null, reason: 'nobody within 2s - manage tyres and battery' };
  }
  // Near the car ahead but the battery's too low to attack. To 2 s, not 1: a gap
  // hovering at 1.0 s flipped the card every few seconds.
  if (ahead && !ahead.pitStatus && gapAheadS > 0 && gapAheadS <= CLEAR_S && batteryPct != null && batteryPct < ATTACK_MIN_PCT) {
    return { mode: 'HOLD', target: null, reason: `${name(ahead)} ahead - harvest, attack when the battery's back` };
  }
  const gaps = [ahead && gapAheadS != null ? `${gapAheadS.toFixed(1)}s to ${name(ahead)}` : null, behind && gapBehindS != null ? `${gapBehindS.toFixed(1)}s to ${name(behind)}` : null].filter(Boolean);
  const closing = closingAhead >= 0.15 || closingBehind >= 0.15;
  return { mode: 'HOLD', target: null, reason: gaps.length ? `${gaps.join(', ')}${closing ? '' : ' - not closing either way'}` : 'hold position' };
}

module.exports = { battleCall, ATTACK_MIN_PCT };
