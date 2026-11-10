import { eyeHeight } from './bodyPose.js';
import { holdsWater } from './waterBlocks.js';

/**
 * How long a block takes to dig, as the game counts it (run 6, 2026-11-11: stone dug by a body standing in a flooded shaft was estimated 26 s and
 * the dig was cut as "not enough air", while the same block took 1.3 s with the head in the air).
 *
 * mineflayer's `bot.digTime` slows a dig fivefold whenever any part of the body touches water (`entity.isInWater`). The game slows it fivefold only when
 * the EYES are in water (and no aqua affinity) and fivefold again when the feet are off the ground. A body wading with its head in the air was
 * told a dig takes five times what it does, mineflayer's dig() waited that long, and the breathing gate refused work that fits the air by far.
 * This reads the block's own time with the game's two conditions.
 */

/** True when the eye is inside a water cell (the game's isEyeInFluid(WATER); a cell counts whole, which errs to the slower, safe side). */
export function eyeInWater(bot: any): boolean {
  const p = bot?.entity?.position;
  if (!p || typeof bot.blockAt !== 'function') return false;
  try {
    return holdsWater(bot.blockAt({ x: Math.floor(p.x), y: Math.floor(p.y + eyeHeight(bot)), z: Math.floor(p.z) } as any));
  } catch { return false; }
}

/**
 * True when a dig would be slowed by the game's water rules: the eyes in water, or the feet off the ground. A body that only wades with its head in the air is not
 * slowed, so it keeps the tool that wears least.
 */
export function digSlowed(bot: any): boolean {
  return eyeInWater(bot) || bot?.entity?.onGround === false;
}

/** The enchantments of the tool in hand and of the helmet (aqua affinity is the helmet's), as mineflayer collects them. */
function enchantsOf(bot: any): unknown[] {
  let enchants: unknown[] = [];
  try { enchants = [...(bot.heldItem?.enchants ?? [])]; } catch { enchants = []; }
  try {
    const slot = bot.getEquipmentDestSlot?.('head');
    const helmet = slot === undefined ? null : bot.inventory?.slots?.[slot];
    if (helmet?.enchants) enchants = enchants.concat(helmet.enchants);
  } catch { /* no helmet read */ }
  return enchants;
}

/** The block's dig time in ms with the tool in hand, by the game's rules (eyes in water, feet off the ground). Infinity when it cannot be dug. */
export function vanillaDigMs(bot: any, block: any): number {
  const held = bot.heldItem;
  return Number(block.digTime(held ? held.type : null, bot.game?.gameMode === 'creative', eyeInWater(bot), bot.entity?.onGround === false, enchantsOf(bot), bot.entity?.effects));
}

/**
 * Makes `bot.digTime` (and with it the wait inside mineflayer's dig) follow the game's rules. A tick (50 ms) is added when the estimate is shortened,
 * so a finish is never sent before the server's own count. Idempotent; the old function is kept for a block it cannot read.
 */
export function installVanillaDigTime(bot: any): void {
  if (!bot || bot.digTimeVanilla === true || typeof bot.digTime !== 'function') return;
  const original = bot.digTime.bind(bot);
  bot.digTime = (block: any) => {
    const old = Number(original(block));
    try {
      if (typeof block?.digTime !== 'function' || !bot.entity) return old;
      // Only the water rule is corrected; a body on dry ground reads exactly as before.
      if (bot.entity.isInWater !== true) return old;
      const fixed = vanillaDigMs(bot, block);
      if (!Number.isFinite(fixed)) return old;
      return fixed < old ? fixed + 50 : fixed;
    } catch { return old; }
  };
  bot.digTimeVanilla = true;
}
