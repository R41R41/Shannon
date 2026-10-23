/**
 * The server sends a player's air supply only when it differs from the
 * default (full). Mineflayer therefore leaves bot.oxygenLevel undefined after
 * login, and keeps the pre-death value after a respawn, until the next dive.
 * Breathing safety treats a missing value as unknown, so a bot buried right
 * after joining could never be cleared from suffocation containment.
 */
export function installAirSupplyDefault(bot: { oxygenLevel?: number; on(event: 'spawn' | 'death', listener: () => void): unknown }): void {
  let died = false;
  bot.on('death', () => { died = true; });
  bot.on('spawn', () => {
    // A later metadata packet with reduced air still overwrites this.
    if (died || bot.oxygenLevel === undefined || bot.oxygenLevel === null) bot.oxygenLevel = 20;
    died = false;
  });
}

/** The air the head reads is on one scale: 0 (out of breath) to 20 (full, the bubbles). */
export const AIR_MAX = 20;
/**
 * The air supply as the one 0-20 scale (mb-llmc-cand 4, run 37: the observation said `oxygen: 400` on the surface and 20 later). Mineflayer
 * keeps `bot.oxygenLevel` as the server's air supply over 15, and a body on dry land can be sent a supply above the 300-tick maximum (1.21:
 * 6000 ticks, 400 here): that is full air, 20. Not a number, or not finite: null (unknown, never a made-up 20).
 */
export function airLevel(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(AIR_MAX, Math.round(raw)));
}
