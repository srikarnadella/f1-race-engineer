// What every rule in this folder shares: card severities and categories, and
// the per-tick context insightEngine.js hands each rule. A rule reads the
// context, puts cards up or takes them down, and leaves what the headline call
// needs in `out`. Rules run in the order of RULES in insightEngine.js; a few
// read what an earlier one left in `ctx` (see the fields marked "set by").

/** @type {{ INFO: 'info', ADVISORY: 'advisory', CRITICAL: 'critical' }} */
const SEVERITY = { INFO: 'info', ADVISORY: 'advisory', CRITICAL: 'critical' };
const CATEGORY = { PACE: 'pace', STRATEGY: 'strategy', HEALTH: 'health', FLAG: 'flag', CAR: 'car' };

/**
 * @typedef {'info' | 'advisory' | 'critical'} Severity
 *
 * @typedef {object} CardInput
 * @property {Severity} severity
 * @property {string} category
 * @property {string} message
 * @property {number} [expiresAtMs]
 * @property {boolean} [battle] set on a card the battle call speaks on
 *
 * @typedef {CardInput & { id: string, createdAtMs: number, textAtMs: number }} Card
 *
 * @typedef {object} CallInputs what the rules leave for the headline call and the strategy numbers
 * @property {number | null} lapsToCliff
 * @property {boolean} tyresReachFlag
 * @property {number | null} fuelMarginLaps
 * @property {number | null} fuelSavePct
 * @property {object | null} battle the settled battle call (ATTACK / DEFEND / CLOSE IN / CLEAR / HOLD)
 * @property {object | null} adjust computeAdjustments() with the settled ERS tip
 * @property {string | null} undercutOn the car the undercut is on
 * @property {string | null} pitWindow
 * @property {string | null} cheapStop
 * @property {string | null} weatherBox
 * @property {number | null} rainSoonLaps
 * @property {number | null} rainInLaps
 * @property {string | null} damageBox
 * @property {string | null} penaltyBox
 *
 * @typedef {object} SessionMemory what the rules remember across ticks, reset with the session
 * @property {'surplus' | 'laps-of-fuel' | null} fuelReading
 * @property {number} lastEventSeq the newest event already turned into a card
 * @property {number | null} qualiBestMs the best lap last announced
 * @property {boolean} qualiSeen
 * @property {number} trackLimitsSaid the player's track-limit warnings already on the radio
 * @property {boolean} startSaid
 * @property {object | null} ersShown
 * @property {{ key: string | null, since: number }} ersCandidate
 * @property {Set<number>} announcedRetirements
 *
 * @typedef {object} RuleContext
 * @property {() => number} clock
 * @property {any} fieldModel
 * @property {any} analysis RaceAnalysis.compute()'s result, or null
 * @property {number} playerIdx
 * @property {any} player
 * @property {any[]} ordered
 * @property {any} ahead
 * @property {any} behind
 * @property {any} session
 * @property {number | null} finished resultStatus once the player is past the flag (or out)
 * @property {boolean} racing
 * @property {number | null} lapsLeft
 * @property {boolean} redFlag
 * @property {string | null} neutralised 'Red flag', 'Safety car', 'VSC' or null
 * @property {(c: any) => boolean} onTrack
 * @property {boolean} playerOnTrack
 * @property {number | null} myTyreAge
 * @property {boolean} greenRacing
 * @property {boolean} pastLap1
 * @property {number | null} gapAheadNow
 * @property {number | null} gapBehindNow
 * @property {any} bc the battle call from the analysis, before it's settled
 * @property {Card | undefined} prevDefend the defend card as the tick began
 * @property {boolean} battleDefending
 * @property {any} aheadRow
 * @property {any} behindRow
 * @property {any} q qualifying analysis (not in a race), or null
 * @property {{ avgWear: number, ratePerLap: number | null } | null} wear
 * @property {(c: any) => string} nameOf
 * @property {boolean} [optsSettled] set by scOptions
 * @property {boolean} [trackLimitNew] set by penalties
 * @property {(id: string, card: CardInput) => void} upsert
 * @property {(id: string) => void} expire
 * @property {(id: string, key: string) => boolean} settled
 * @property {(id: string) => Card | undefined} card
 * @property {SessionMemory} mem
 * @property {CallInputs} out
 */

module.exports = { SEVERITY, CATEGORY };
