// Live adjustment suggestions - the things a driver can change from the
// wheel or the MFD mid-race: brake bias, on-throttle differential, and ERS
// deployment. Each one says what to change, from what to what, where, and
// why, e.g. "Bias 56 -> 54%  Corner 2 (1.2 km)  FL locking 3 of 3 laps".
//
// Rules of thumb, not an optimiser:
//   front locking into a corner  -> brake bias rearward
//   rear locking                 -> brake bias forward
//   rear wheelspin on exit       -> lower on-throttle diff (smoother)
//   understeer on exit           -> higher on-throttle diff (more rotation)
//   ERS                          -> deploy to attack/defend, harvest when
//                                   alone, empty it on the last lap

const { ERS_MAX_J, lineBatteryPct } = require('../analysis/batteryProjection');
const { ATTACK_MIN_PCT } = require('../analysis/battleCall');

const ERS_MODE = ['None', 'Medium', 'Hotlap', 'Overtake'];
// Under the 2026 rules mode 3 is Boost - 'Overtake mode' is a separate system
// (Car Telemetry 2), so the tips must not mix the two up.
const ERS_MODE_2026 = ['None', 'Medium', 'Hotlap', 'Boost'];
const OVERTAKE = 3;
const BIAS_STEP = 2;
const BIAS_RANGE = [50, 70];
const DIFF_STEP = 5;
const DIFF_RANGE = [10, 100];
const GLOBAL_BIAS_CORNERS = 3; // locking in this many corners = move the base bias, not per-corner

const ATTACK_GAP_MS = 1200;
const DEFEND_GAP_MS = 1000;
const DEFEND_MIN_PCT = 25;
const DRAIN_ALERT_PCT_PER_LAP = -5;
const FULL_PCT = 95;
const LAST_LAP = 1.2; // laps left
const LAST_LAP_MIN_PCT = 20;

/** @type {(v: number, range: number[]) => number} */
const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));
const km = (m) => `${(m / 1000).toFixed(1)} km`;
const lapsTxt = (n) => `${n} lap${n === 1 ? '' : 's'}`;
const emptyIn = (n) => (n < 1 ? 'empty this lap' : `empty in ~${lapsTxt(n)}`);

function balanceSuggestions(issues, brakeBias, diff) {
  const out = [];
  const where = (i) => `Corner ${i.corner} (${km(i.distM)})`;
  const seen = (i) => `${i.laps} of the last 3 laps`;

  const frontLocks = issues.filter((i) => i.type === 'frontLock');
  if (frontLocks.length >= GLOBAL_BIAS_CORNERS && brakeBias != null) {
    const to = clamp(brakeBias - 1, BIAS_RANGE);
    out.push({
      id: 'bias-base', kind: 'bias', action: `Base bias ${brakeBias} → ${to}%`,
      where: `${frontLocks.length} corners`, why: 'Front locking all round the lap',
      radio: `Front locking in ${frontLocks.length} corners - move the base brake bias rearward, ${brakeBias} to ${to}%`, laps: Math.max(...frontLocks.map((i) => i.laps)),
    });
  }
  for (const i of issues) {
    if (i.type === 'frontLock' && frontLocks.length < GLOBAL_BIAS_CORNERS) {
      const to = brakeBias != null ? clamp(brakeBias - BIAS_STEP, BIAS_RANGE) : null;
      out.push({
        id: `bias-front-${i.corner}`, kind: 'bias', dir: -1, action: to != null ? `Bias ${brakeBias} → ${to}%` : 'Bias rearward',
        where: where(i), why: `${i.wheel || 'Front'} locking, ${seen(i)}`,
        radio: `${i.wheel || 'Front'} locking into corner ${i.corner} - bias rearward${to != null ? ` to ${to}%` : ''} for that braking zone`, laps: i.laps,
      });
    } else if (i.type === 'rearLock') {
      const to = brakeBias != null ? clamp(brakeBias + BIAS_STEP, BIAS_RANGE) : null;
      out.push({
        id: `bias-rear-${i.corner}`, kind: 'bias', dir: 1, action: to != null ? `Bias ${brakeBias} → ${to}%` : 'Bias forward',
        where: where(i), why: `Rears locking, ${seen(i)}`,
        radio: `Rears locking into corner ${i.corner} - bias forward${to != null ? ` to ${to}%` : ''} there`, laps: i.laps,
      });
    } else if (i.type === 'spin') {
      const to = diff != null ? clamp(diff - DIFF_STEP, DIFF_RANGE) : null;
      out.push({
        id: `diff-spin-${i.corner}`, kind: 'diff', dir: -1, action: to != null ? `Diff ${diff} → ${to}%` : 'Diff lower',
        where: `${where(i)} exit`, why: `Rear wheelspin, ${seen(i)}`,
        radio: `Wheelspin out of corner ${i.corner} - diff down${to != null ? ` to ${to}%` : ''}, or short-shift`, laps: i.laps,
      });
    } else if (i.type === 'understeer') {
      const to = diff != null ? clamp(diff + DIFF_STEP, DIFF_RANGE) : null;
      out.push({
        id: `diff-understeer-${i.corner}`, kind: 'diff', dir: 1, action: to != null ? `Diff ${diff} → ${to}%` : 'Diff higher',
        where: `${where(i)} exit`, why: `Understeer on the power, ${seen(i)}`,
        radio: `Understeer out of corner ${i.corner} - diff up${to != null ? ` to ${to}%` : ''} for more rotation`, laps: i.laps,
      });
    }
  }
  // One corner wanting more diff and another less (or bias both ways) means
  // the base setting is a compromise: say these are per-corner changes, so
  // they don't read as contradicting each other.
  for (const kind of ['bias', 'diff']) {
    const perCorner = out.filter((s) => s.kind === kind && s.id !== 'bias-base');
    const ups = perCorner.filter((s) => s.dir > 0);
    if (ups.length && ups.length < perCorner.length) {
      for (const s of perCorner) {
        s.where += ' only';
        s.radio += ' - just for that corner';
      }
    }
  }
  return out;
}

// Battery % change over the most recent complete green lap. Each entry is
// the battery at a crossing of the line, flagged if the lap that just ended
// ran under yellow or through the pit lane - a recharge there isn't the driver's deployment.
function batteryTrend(ersHistory) {
  for (let k = ersHistory.length - 1; k > 0; k--) {
    const a = ersHistory[k - 1];
    const b = ersHistory[k];
    if (!b.neutralised && !b.pit && b.lapNum === a.lapNum + 1) return ((b.energyJ - a.energyJ) / ERS_MAX_J) * 100;
  }
  return null;
}

// linePct: the battery at the last crossing of the line. "Enough to attack /
// defend" is judged on it: the 2026 store swings 20%+ inside a lap, and the
// live figure flipped Boost <-> save every 10-20 s in a real race.
function ersSuggestion({ pct, linePct = pct, trend, mode, gapAheadMs, gapBehindMs, lapsLeft, neutralised, lapNum, regs2026, overtakeReady = false }) {
  const top = (regs2026 ? ERS_MODE_2026 : ERS_MODE)[OVERTAKE];
  const s = (action, why, radio) => ({ id: 'ers', kind: 'ers', action, where: 'Straights', why, radio });
  // Nearest 5%: the exact figure is on the widget; the call shouldn't churn.
  // The attack / defend radio leaves it out: it changed the line every few
  // seconds of a real battle, and the why on the Adjust card has it.
  const battery = `battery ~${Math.round(pct / 5) * 5}%`;
  // "Low" is judged at the line, so it says that figure (it holds all lap).
  const atLine = `~${Math.round(linePct / 5) * 5}%${linePct === pct ? '' : ' at the line'}`;

  if (neutralised) {
    return pct < FULL_PCT ? s('ERS: None', `${neutralised} - recharge, ${battery}`, `${neutralised} - ERS to None and recharge, ${battery}`) : null;
  }
  if (lapsLeft != null && lapsLeft <= LAST_LAP && pct >= LAST_LAP_MIN_PCT && mode !== OVERTAKE) {
    const when = lapsLeft > 1 ? 'Last lap next' : 'Last lap';
    return s(`ERS: ${top}`, `${when} - empty it, ${battery}`, `${when} - empty the battery, ${top} mode, ${battery}`);
  }
  if (gapBehindMs != null && gapBehindMs < DEFEND_GAP_MS && (gapAheadMs == null || gapBehindMs < gapAheadMs)) {
    if (linePct >= DEFEND_MIN_PCT && mode !== OVERTAKE) {
      return s(`ERS: ${top}`, `Defend - car ${(gapBehindMs / 1000).toFixed(1)}s behind, ${battery}`, `Defend - ${top} on the straights`);
    }
    if (linePct < DEFEND_MIN_PCT) return s('Save for the straight', `Defend, but battery ${atLine}`, `Battery low, ${atLine} - save it for the main straight to defend`);
  }
  if (gapAheadMs != null && gapAheadMs < ATTACK_GAP_MS) {
    if (linePct >= ATTACK_MIN_PCT && mode !== OVERTAKE) {
      return s(`ERS: ${top}`, `Attack - ${(gapAheadMs / 1000).toFixed(1)}s to the car ahead, ${battery}`, `Attack - ${top} on the straights`);
    }
    // Overtake mode ready: the battle card says use it, so no "harvest" beside it.
    if (linePct < ATTACK_MIN_PCT && !overtakeReady) return s('ERS: Medium', `Harvest a lap, then attack - battery ${atLine}`, `Battery ${atLine} - harvest this lap in Medium, attack on the next`);
  }
  if (trend != null && trend <= DRAIN_ALERT_PCT_PER_LAP) {
    const lapsOfBattery = Math.floor(pct / -trend);
    if (lapsLeft == null || lapsOfBattery < lapsLeft) {
      const fix = mode >= 2 ? 'ERS: Medium' : 'ERS: None for a sector';
      return s(fix, `Dropping ${Math.abs(trend).toFixed(0)}%/lap - ${emptyIn(lapsOfBattery)}`, `Battery dropping ${Math.abs(trend).toFixed(0)}% a lap, ${emptyIn(lapsOfBattery)} - ${fix.replace(': ', ' to ')} to save it`);
    }
  }
  // A full battery on the opening lap is the plan, not waste.
  if (pct >= FULL_PCT && mode <= 1 && !(lapNum <= 1)) {
    return s('ERS: Hotlap', `Battery full - harvest going to waste`, `Battery full, you're wasting harvest - deploy more, Hotlap mode for a lap`);
  }
  return null;
}

// player: FieldModel car. Returns { current, suggestions } for the Adjust
// widget; suggestions are most important first (ERS - it's about this
// straight - then the balance issue seen most often).
function computeAdjustments({ player, issues, gapAheadMs, gapBehindMs, lapsLeft, neutralised, lapNum = null }) {
  const st = player.status;
  const brakeBias = st && st.frontBrakeBias ? st.frontBrakeBias : player.setup ? player.setup.brakeBias : null;
  const diff = player.setup ? player.setup.onThrottle : null;
  const pct = st && Number.isFinite(st.ersStoreEnergy) ? Math.max(0, Math.min(100, (st.ersStoreEnergy / ERS_MAX_J) * 100)) : null;
  const trend = batteryTrend(player.ersHistory || []);
  const linePct = lineBatteryPct(player) ?? pct;
  const mode = st ? st.ersDeployMode : null;

  const suggestions = [];
  if (pct != null) {
    const regs2026 = !!(player.telemetry2 && player.telemetry2.regulations2026);
    const overtakeReady = !!(player.telemetry2 && player.telemetry2.overtakeAvailable);
    const ers = ersSuggestion({ pct, linePct, trend, mode, gapAheadMs, gapBehindMs, lapsLeft, neutralised, lapNum, regs2026, overtakeReady });
    if (ers) suggestions.push(ers);
  }
  suggestions.push(...balanceSuggestions(issues, brakeBias, diff).sort((a, b) => b.laps - a.laps));

  return {
    current: {
      brakeBias,
      diff,
      ersMode: mode != null ? ((player.telemetry2 && player.telemetry2.regulations2026) ? ERS_MODE_2026 : ERS_MODE)[mode] || null : null,
      batteryPct: pct,
      batteryTrendPctPerLap: trend,
    },
    suggestions,
  };
}

module.exports = { computeAdjustments, batteryTrend, ERS_MODE };
