const { SEVERITY, CATEGORY } = require('./cards');

/** @typedef {import('./cards').RuleContext} RuleContext */

const CLOSING_WINDOW_S = 30;
const CLOSING_THRESHOLD_MS_PER_LAP = -150;
// Below this you're already in the fight (DRS range) - "closing by 2.1s/lap,
// gap 0.2s" in a live race told the driver nothing.
const CLOSING_MIN_GAP_MS = 1000;
// Faster than this is a broken reading, not pace: a gap measured across a
// pit stop or a safety car came out as "closing by 166.3s/lap".
const CLOSING_MAX_MS_PER_LAP = 5000;
const FALLBACK_LAP_MS = 90000;

// Gap change per lap to the car ahead, from FieldModel's game-time samples.
// Negative = closing. Null until there's a full window of green history: the
// field bunching up behind a safety car / VSC isn't pace.
function closingRateMsPerLap(car, paceMs) {
  const h = car.gapAheadHistory;
  if (h.length < 2) return null;
  const now = h[h.length - 1];
  let then = null;
  for (let i = h.length - 2; i >= 0; i--) {
    if (h[i].neutralised) break;
    if (now.t - h[i].t >= CLOSING_WINDOW_S) {
      then = h[i];
      break;
    }
  }
  if (!then || now.neutralised) return null;
  // Clean pace, not the last lap: that can be a safety-car or pit lap.
  const lapMs = paceMs || (car.lapData.currentLapNum > 2 && car.lapData.lastLapTimeInMS) || FALLBACK_LAP_MS; // not lap 1's time
  return ((now.gapMs - then.gapMs) / (now.t - then.t)) * (lapMs / 1000);
}

// --- Pace vs car ahead: is the gap closing? ---
// Compares the gap now with the gap ~30s of game time ago and expresses
// it per lap, which is how an engineer would call it on the radio.
/** @param {RuleContext} ctx */
function closingAhead({ player, analysis, racing, greenRacing, pastLap1, onTrack, ahead, upsert, expire, clock }) {
  const closingRate = closingRateMsPerLap(player, analysis && analysis.playerPaceMs);
  // Not on lap 1: the start scrambles every gap.
  if (!(racing && greenRacing && pastLap1)) expire('closing-ahead');
  if (racing && greenRacing && pastLap1 && onTrack(ahead) && closingRate != null) {
    if (closingRate <= CLOSING_THRESHOLD_MS_PER_LAP && closingRate >= -CLOSING_MAX_MS_PER_LAP && player.lapData.deltaToCarInFrontInMS >= CLOSING_MIN_GAP_MS) {
      upsert('closing-ahead', {
        severity: SEVERITY.INFO,
        category: CATEGORY.PACE,
        message: `Closing on P${ahead.lapData.carPosition} by ${(Math.abs(closingRate) / 1000).toFixed(1)}s/lap - gap ${(player.lapData.deltaToCarInFrontInMS / 1000).toFixed(1)}s`,
        expiresAtMs: clock() + 10000,
      });
    } else {
      expire('closing-ahead');
    }
  }
}

// --- Pace vs car behind: is it a threat? ---
// The gap is reported by the chasing car, about the gap to us. Exactly 0
// means "no timing yet" (grid, first sector), not a car in our gearbox.
// Never critical: the driver already has mirrors and the HUD's proximity
// arrows, and a full-width red banner mid-battle is a distraction. The
// interrupt is kept for things the driver can't see from the cockpit.
// Not on lap 1 either: the whole field is nose to tail, and one real start
// named eleven different "right behind you" cars in under a minute.
// The battle call's DEFEND speaks on this same card (battleCall), so the
// driver hears one defend call, not two that take turns - 45 of 55 key
// calls in a real race were the pair. While it holds the card, it owns it.
/** @param {RuleContext} ctx */
function underAttack({ racing, greenRacing, pastLap1, gapBehindNow, battleDefending, analysis, behind, upsert, expire, clock }) {
  if (!(racing && greenRacing && pastLap1)) expire('under-attack');
  if (!(racing && greenRacing && pastLap1 && gapBehindNow > 0 && !battleDefending)) return;
  if (gapBehindNow < 1000) {
    // The overtake model (trained on recorded races) says how likely a
    // pass actually is; "likely" escalates the call even outside 0.5s.
    const threat = analysis && analysis.battle && analysis.battle.defend;
    const likely = threat && threat.level === 'high';
    const fc = analysis && analysis.battle && analysis.battle.defendForecast;
    const watch = fc && fc.where ? `, watch corner ${fc.where.corner}` : '';
    upsert('under-attack', {
      severity: gapBehindNow < 500 || likely ? SEVERITY.ADVISORY : SEVERITY.INFO,
      category: CATEGORY.PACE,
      // Named, and "right behind" inside half a second: the exact gap
      // changed the text 250 times in one real race without telling the
      // driver anything new (the Battle card has the number).
      message: `${behind.participant && behind.participant.name ? behind.participant.name : `P${behind.lapData.carPosition}`} ${gapBehindNow < 500 ? 'is right behind you' : `is ${(gapBehindNow / 1000).toFixed(1)}s behind`} - defend${likely ? ', pass likely' : ''}${watch}`,
      expiresAtMs: clock() + 8000,
    });
  } else {
    expire('under-attack');
  }
}

// --- ATTACK / DEFEND: the one battle call (analysis/battleCall.js) ---
// Settled like the other who-and-where calls, and the single voice of
// the battle: when it's active, the older separate "defend" and "best
// chance" calls stand down so nothing is said twice. DEFEND takes over
// the defend card ('under-attack') rather than adding one.
/** @param {RuleContext} ctx */
function battleCall({ racing, greenRacing, bc, prevDefend, battleDefending, settled, card, out, upsert, expire, clock }) {
  out.battle = null;
  if (racing && greenRacing && bc && (bc.mode === 'ATTACK' || bc.mode === 'DEFEND' || bc.mode === 'CLOSE IN')
    && settled('battle-call', `${bc.mode}:${bc.target}`)) {
    out.battle = bc;
    const text = bc.mode === 'ATTACK' ? `Attack ${bc.target} - ${bc.reason}` : bc.mode === 'DEFEND' ? `Defend from ${bc.target} - ${bc.reason}` : `Close in on ${bc.target} - ${bc.reason}`;
    const id = bc.mode === 'DEFEND' ? 'under-attack' : 'battle-call';
    expire(id === 'under-attack' ? 'battle-call' : 'under-attack');
    upsert(id, { severity: bc.mode === 'CLOSE IN' ? SEVERITY.INFO : SEVERITY.ADVISORY, category: CATEGORY.PACE, message: text, expiresAtMs: clock() + 4000, battle: true });
  } else if (!bc || bc.mode === 'CLEAR' || bc.mode === 'HOLD' || !(racing && greenRacing)) {
    expire('battle-call');
    if (prevDefend && prevDefend.battle) expire('under-attack');
  }
  if (card('battle-call') || battleDefending || (out.battle && out.battle.mode === 'DEFEND')) {
    expire('attack-chance');
  }
  if (bc && (bc.mode === 'CLEAR' || bc.mode === 'HOLD')) out.battle = bc;
}

// --- Attack forecast: when and where the car behind will come at you,
// and your best chance on the car ahead (analysis/attackForecast.js) ---
/** @param {RuleContext} ctx */
function attackForecast({ racing, greenRacing, analysis, ahead, behind, lapsLeft, nameOf, settled, card, upsert, expire, clock }) {
  const km = (m) => `${(m / 1000).toFixed(1)} km`;
  const dfc = analysis && analysis.battle && analysis.battle.defendForecast;
  // Only what happens before the flag: "in ~2 laps" with one to go was said on a real last lap.
  const beforeFlag = (fc) => lapsLeft == null || fc.when.laps < lapsLeft;
  if (racing && greenRacing && behind && dfc && dfc.where && dfc.when.laps > 0 && dfc.when.laps <= 3 && beforeFlag(dfc)
    && settled('attack-warning', `${behind.carIndex}:${dfc.where.corner}`)) {
    upsert('attack-warning', {
      severity: SEVERITY.INFO,
      category: CATEGORY.PACE,
      message: `${nameOf(behind)} closing ${dfc.closingSPerLap.toFixed(1)}s/lap - expect an attack into corner ${dfc.where.corner} (${km(dfc.where.atM)}) ${dfc.when.text}`,
      expiresAtMs: clock() + 5000,
    });
  } else {
    expire('attack-warning');
  }
  const afc = analysis && analysis.battle && analysis.battle.attackForecast;
  if (racing && greenRacing && ahead && afc && afc.where && afc.when.laps <= 2 && beforeFlag(afc) && !card('battle-call') && !(card('under-attack') || {}).battle
    && settled('attack-chance', `${ahead.carIndex}:${afc.where.corner}`)) {
    const gain = afc.candidates && afc.candidates[0] && afc.candidates[0].gainS >= 0.02 ? ` - you gain ${afc.candidates[0].gainS.toFixed(2)}s on the run to it` : '';
    upsert('attack-chance', {
      severity: SEVERITY.INFO,
      category: CATEGORY.PACE,
      message: `Best chance on ${nameOf(ahead)}: into corner ${afc.where.corner} (${km(afc.where.atM)})${gain}`,
      expiresAtMs: clock() + 5000,
    });
  } else {
    expire('attack-chance');
  }
}

// --- 2026: Overtake mode earned on the car ahead ---
/** @param {RuleContext} ctx */
function overtakeReady({ racing, greenRacing, analysis, onTrack, ahead, player, upsert, expire, clock }) {
  const ot = analysis && analysis.overtake;
  if (racing && greenRacing && ot && ot.available && onTrack(ahead) && player.lapData.deltaToCarInFrontInMS > 0 && player.lapData.deltaToCarInFrontInMS < 1500) {
    const name = ahead.participant && ahead.participant.name ? ahead.participant.name : `P${ahead.lapData.carPosition}`;
    upsert('overtake-ready', { severity: SEVERITY.INFO, category: CATEGORY.PACE, message: `Overtake mode available on ${name} - use it on the straight`, expiresAtMs: clock() + 4000 });
  } else {
    expire('overtake-ready');
  }
}

module.exports = { closingAhead, underAttack, battleCall, attackForecast, overtakeReady };
