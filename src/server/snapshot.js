const { nameOf } = require('../state/raceAnalysis');

// Flattens FieldModel + InsightEngine + RaceAnalysis into the one JSON
// object the dashboard renders. The dashboard never diffs or remembers
// race state - it re-renders whatever arrives, so this is the entire wire
// contract (PROJECT_SPEC §6).

// No packets for this long = the game is paused, in a menu, or closed.
const STALE_AFTER_MS = 2000;
const NEARBY_EACH_SIDE = 2;

// `raceAnalysis` keeps per-session memory (measured pit losses), so it is a
// required, long-lived instance rather than something built per call.
// `focus` (optional, from state/focus.js) picks the screen for auto-switch.
function buildSnapshot(fieldModel, insightEngine, raceAnalysis, focus = null) {
  const playerIdx = fieldModel.playerIndex();
  // Analysis first: some radio calls (undercut window, cheap stop under a
  // safety car) are judgements on the rejoin prediction and pit loss.
  const analysis = playerIdx == null ? null : raceAnalysis.compute();
  const insights = insightEngine.evaluate(analysis);

  if (playerIdx == null) {
    return { connected: false, updatedAtMs: Date.now(), session: null, player: null, nearby: [], field: [], analysis: null, insights, strategy: null };
  }

  const player = fieldModel.getCar(playerIdx);
  const delta = fieldModel.getPlayerDelta();
  const { field, playerPaceMs, pitLoss, rejoin, options, pitTiming, damage, penalties, tyreTemps, racePlan, quali, weather, battle, tyreModel, regs2026, overtake } = analysis;
  // The raw 64-slot forecast and the marshal zones stay server-side;
  // `analysis.weather` and the flag calls carry the part that matters.
  const { forecast, marshalZones, ...session } = fieldModel.getSession() || {};

  // Two ahead, two behind - "everyone around me" without the whole grid.
  const me = field.findIndex((c) => c.isPlayer);
  const nearby = me === -1
    ? []
    : field.slice(Math.max(0, me - NEARBY_EACH_SIDE), me + NEARBY_EACH_SIDE + 1).filter((c) => !c.isPlayer);

  const lastPacketAtMs = fieldModel.getLastPacketAtMs();
  return {
    // Last known state is still sent while stale, so the dashboard can show
    // "paused" over it rather than blanking.
    connected: lastPacketAtMs != null && Date.now() - lastPacketAtMs < STALE_AFTER_MS,
    updatedAtMs: Date.now(),
    session: fieldModel.getSession() ? session : null,
    // Only what the dashboard or the capture analyzer reads - raw HUD values
    // (temps, RPM, damage...) stay in FieldModel for the models to use.
    player: player.lapData
      ? {
          name: nameOf(player, 'You'),
          position: player.lapData.carPosition,
          currentLapNum: player.lapData.currentLapNum,
          lastLapTimeInMS: player.lapData.lastLapTimeInMS,
          bestLapTimeInMS: delta.bestLapTimeInMS,
          deltaToBestMs: delta.deltaToBestMs,
          previousLapTimeInMS: delta.previousLapTimeInMS,
          deltaToLastMs: delta.deltaToLastMs,
          liveMiniSectors: delta.miniSectors,
          paceMs: playerPaceMs,
          lapDistance: player.lapData.lapDistance,
          pitStatus: player.lapData.pitStatus,
          numPitStops: player.lapData.numPitStops,
          speed: player.telemetry ? player.telemetry.speed : null,
          fuelInTank: player.status ? player.status.fuelInTank : null,
          fuelRemainingLaps: player.status ? player.status.fuelRemainingLaps : null,
          // Visual compound (16 soft / 17 medium / 18 hard / 7 inter / 8 wet) -
          // what the driver thinks in, rather than the C1-C6 actual compound.
          tyreCompound: player.status ? player.status.visualTyreCompound : null,
          tyresAgeLaps: player.status ? player.status.tyresAgeLaps : null,
          tyresWear: player.damage ? player.damage.tyresWear : null,
        }
      : null,
    nearby,
    field,
    analysis: { pitLoss, rejoin, options, pitTiming, damage, penalties, tyreTemps, racePlan, quali, weather, battle, tyreModel, regs2026, overtake },
    insights,
    strategy: insightEngine.getStrategy(),
    adjust: insightEngine.getAdjust(),
    focus: focus ? focus({ strategy: insightEngine.getStrategy(), analysis, sessionOver: !!fieldModel.getClassification() }) : null,
  };
}

module.exports = { buildSnapshot };
