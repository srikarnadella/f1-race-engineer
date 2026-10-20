const { SEVERITY, CATEGORY } = require('./cards');
const { computeAdjustments } = require('../adjustments');

/** @typedef {import('./cards').RuleContext} RuleContext */

const ERS_SETTLE_MS = 5000;

// A new ERS tip (or none) replaces the one on screen only after it has
// held for ERS_SETTLE_MS; the tip on screen keeps its latest text.
function settleErs(mem, tip, now) {
  const key = tip ? tip.action : null;
  const shownKey = mem.ersShown ? mem.ersShown.action : null;
  if (key === shownKey) {
    mem.ersCandidate = { key, since: now };
    mem.ersShown = tip;
    return mem.ersShown;
  }
  if (mem.ersCandidate.key !== key) mem.ersCandidate = { key, since: now };
  if (now - mem.ersCandidate.since >= ERS_SETTLE_MS) mem.ersShown = tip;
  return mem.ersShown;
}

// --- Live adjustments: brake bias, diff, ERS ---
// Balance issues count in any session (practice is where they're fixed);
// the ERS attack/defend calls only mean something wheel-to-wheel.
/** @param {RuleContext} ctx */
function adjustments({ fieldModel, player, racing, greenRacing, onTrack, ahead, gapBehindNow, lapsLeft, neutralised, redFlag, playerOnTrack, finished, mem, out, upsert, expire, clock }) {
  const wheelToWheel = racing && greenRacing;
  const adjust = computeAdjustments({
    player,
    issues: fieldModel.getPlayerBalanceIssues(),
    gapAheadMs: wheelToWheel && onTrack(ahead) && player.lapData.deltaToCarInFrontInMS > 0 ? player.lapData.deltaToCarInFrontInMS : null,
    gapBehindMs: wheelToWheel && gapBehindNow > 0 ? gapBehindNow : null,
    lapsLeft,
    neutralised: racing ? neutralised : null,
    lapNum: player.lapData.currentLapNum,
  });
  out.adjust = adjust;
  // ERS advice is about a race, and must hold still long enough to act on:
  // in a real race it flipped Overtake/Medium/save every couple of seconds
  // as gaps and charge hovered around the thresholds.
  const ersRaw = racing && !redFlag ? adjust.suggestions.find((s) => s.kind === 'ers') || null : null;
  const ersSteady = settleErs(mem, ersRaw, clock());
  adjust.suggestions = [...(ersSteady ? [ersSteady] : []), ...adjust.suggestions.filter((s) => s.kind !== 'ers')];
  // At most one of each on the radio, so tips never crowd out race calls.
  const ersTip = adjust.suggestions.find((s) => s.kind === 'ers');
  const balanceTip = adjust.suggestions.find((s) => s.kind !== 'ers');
  /** @type {[string, any][]} */
  const tips = [['ers', ersTip], ['balance', balanceTip]];
  for (const [id, tip] of tips) {
    if (tip && playerOnTrack && !finished) {
      upsert(id, { severity: SEVERITY.INFO, category: CATEGORY.CAR, message: tip.radio, expiresAtMs: clock() + 5000 });
    } else {
      expire(id);
    }
  }
}

module.exports = { adjustments };
