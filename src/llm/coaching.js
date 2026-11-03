// Coaching rules for Ask the race: what to change, corner by corner, from the telemetry, each with
// the number it rests on. The engine decides; the model only explains. Rules of thumb from
// comparing a lap with your own best lap, not an optimiser: your best lap shows what you can do.
const MIN_LOSS_S = 0.03; // less than this through a corner isn't worth a word
const CANDIDATES = 3; // lift-and-coast suggestions

// corners: lapCompare's, for lap `lap` against your best lap `best` (+ = this lap lost / later).
function adviseCorners(corners, { best, lap }) {
  const out = [];
  for (const c of corners) {
    if (!(c.timeS >= MIN_LOSS_S)) continue;
    const tips = [];
    if (c.brakePointM != null && c.brakePointM <= -8 && !(c.apexKmh > 3)) tips.push(`brake ${Math.abs(c.brakePointM)} m later, as on lap ${best}`);
    if (c.apexKmh != null && c.apexKmh <= -4) tips.push(`carry ${Math.abs(c.apexKmh)} km/h more to the apex (${c.refApexKmh} km/h on lap ${best})`);
    if (c.throttleM != null && c.throttleM >= 10) tips.push(`get to full throttle ${c.throttleM} m sooner after the apex`);
    if (c.coastM != null && c.coastM - (c.refCoastM || 0) >= 20) tips.push(`you coasted ${c.coastM} m before braking; keep the throttle open to the brake point`);
    if (!tips.length && c.exitKmh <= -4) tips.push(`your exit was ${Math.abs(c.exitKmh)} km/h down: a straighter, earlier throttle on the way out`);
    if (!tips.length) continue;
    out.push({ corner: c.corner, atKm: +(c.atM / 1000).toFixed(1), lostS: +c.timeS.toFixed(2), text: `Corner ${c.corner} (${(c.atM / 1000).toFixed(1)} km), ${c.timeS.toFixed(2)} s lost on lap ${lap}: ${tips.join('; ')}.` });
  }
  return out.sort((a, b) => b.lostS - a.lostS);
}

// Lift and coast saves fuel where the engine has been working longest: the braking zones after
// the longest flat-out runs. zones: lapCorners' for one lap.
function liftAndCoast(zones, { lap, fuelPerLapKg = null }) {
  const candidates = [...zones].sort((a, b) => b.flatOutM - a.flatOutM).slice(0, CANDIDATES).sort((a, b) => a.atM - b.atM).map((z) => ({
    corner: z.corner,
    atKm: +(z.atM / 1000).toFixed(1),
    flatOutM: z.flatOutM,
    text: `Corner ${z.corner} (${(z.atM / 1000).toFixed(1)} km): ${z.flatOutM} m flat out before it, braking from ${z.entryKmh} km/h; ${z.coastM >= 10 ? `you already coast ${z.coastM} m there` : 'you don\'t coast there now'}.`,
  }));
  const coasting = zones.filter((z) => z.coastM >= 10);
  return {
    lap,
    candidates,
    summary: `${fuelPerLapKg != null ? `You used ${fuelPerLapKg.toFixed(1)} kg a lap. ` : ''}On lap ${lap} you coasted before ${coasting.length ? coasting.map((z) => `corner ${z.corner} (${z.coastM} m)`).join(', ') : 'no corner'}. To save fuel, lift before the braking zones after the longest flat-out runs: the corners below. Each lift costs a little time, so only where you need the fuel.`,
  };
}

module.exports = { adviseCorners, liftAndCoast };
