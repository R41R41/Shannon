import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';

const require = createRequire(import.meta.url);
const installedMineflayerVersion: string = require('mineflayer/package.json').version;

function numericVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

function atLeast(version: string, minimum: [number, number, number]): boolean {
  const parts = numericVersion(version);
  if (!parts) return false;
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== minimum[i]) return parts[i] > minimum[i];
  }
  return true;
}

/**
 * Mineflayer 4.38.0 added this packet to its spawn path. Earlier Mineflayer
 * versions leave 1.21.4+ servers ignoring initial block/item interactions
 * until the server's loaded-state timeout expires. Keep the compatibility
 * packet scoped to those versions so a future dependency update will not
 * send it twice.
 */
export function needsPlayerLoadedHandshake(
  minecraftVersion: string,
  mineflayerVersion: string = installedMineflayerVersion,
): boolean {
  return atLeast(minecraftVersion, [1, 21, 4])
    && !atLeast(mineflayerVersion, [4, 38, 0]);
}

export function installPlayerLoadedHandshake(
  bot: Pick<Bot, 'version' | 'on' | '_client'>,
  mineflayerVersion: string = installedMineflayerVersion,
): void {
  // Register before any consumer waits for spawn. This mirrors Mineflayer's
  // upstream fix and also covers a later respawn into a new world. Mineflayer
  // can assign bot.version after createBot returns, so inspect it at spawn.
  bot.on('spawn', () => {
    if (needsPlayerLoadedHandshake(bot.version, mineflayerVersion)) {
      bot._client.write('player_loaded', {});
    }
  });
}
