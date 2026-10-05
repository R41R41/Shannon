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
