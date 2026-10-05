import { Vec3 } from 'vec3';
import { actionDelay } from '../execution/observedWait.js';
import { holdsWater } from './waterBlocks.js';

interface SwimmerBot {
  entity: { position: Vec3; isInWater?: boolean; onGround?: boolean };
  blockAt(position: Vec3, extraInfos?: boolean): any;
  lookAt(point: Vec3, force?: boolean): Promise<unknown> | unknown;
  setControlState(control: any, state: boolean): void;
}

const solid = (block: any) => !!block && block.boundingBox === 'block';
const open = (block: any) => !!block && block.boundingBox !== 'block' && !holdsWater(block) && block.name !== 'lava';
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

/**
 * A bank beside the swimmer that a body at the waterline can climb: a solid
 * block at the level of the water it floats in, with two open cells above.
 * Of several, the one most in the direction of travel.
 */
/**
 * The level of the water the body floats in or bobs just above: a body
 * treading water leaves it for a moment about once a second, so "in water"
 * alone misses half the time. Null when it stands on ground or has no water
 * under it.
 */
export function waterLevelUnderBody(bot: SwimmerBot): number | null {
  const entity = bot.entity;
  if (!entity?.position || typeof bot.blockAt !== 'function' || (entity.onGround === true && entity.isInWater !== true)) return null;
  const cell = entity.position.floored();
  try {
    for (const dy of [1, 0, -1]) if (holdsWater(bot.blockAt(cell.offset(0, dy, 0), false))) return cell.y + dy;
  } catch { /* an unreadable world offers no bank */ }
  return null;
}

export function climbableBank(bot: SwimmerBot, towardX: number, towardZ: number): Vec3 | null {
  const position = bot.entity.position;
  const cell = position.floored();
  const level = waterLevelUnderBody(bot);
  if (level === null) return null;
  const heading = Math.atan2(towardZ - position.z, towardX - position.x);
  let best: { at: Vec3; turn: number } | null = null;
  for (const [dx, dz] of SIDES) {
    const bank = new Vec3(cell.x + dx, level, cell.z + dz);
    if (!solid(bot.blockAt(bank, false)) || !open(bot.blockAt(bank.offset(0, 1, 0), false)) || !open(bot.blockAt(bank.offset(0, 2, 0), false))) continue;
    // The body rises through its own column: that must be open above the water too.
    if (!open(bot.blockAt(new Vec3(cell.x, level + 1, cell.z), false))) continue;
    const turn = Math.abs(Math.atan2(Math.sin(Math.atan2(dz, dx) - heading), Math.cos(Math.atan2(dz, dx) - heading)));
    if (!best || turn < best.turn) best = { at: bank.offset(0.5, 1, 0.5), turn };
  }
  return best?.at ?? null;
}

/**
 * Out of the water onto a bank at the waterline, the way a player does it:
 * swim up and forward at the edge. The pathfinder plans no step up out of a
 * liquid, so a bot floating in a hole in the ice (or any pool with banks one
 * block above its floor of water) could not leave it at all, and took the
 * only route the pathfinder offered: down, under the ice (paid run L25).
 */
export async function swimOntoBank(bot: SwimmerBot, towardX: number, towardZ: number, timeoutMs = 3000): Promise<boolean> {
  const bank = climbableBank(bot, towardX, towardZ);
  if (!bank) return false;
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      await bot.lookAt(new Vec3(bank.x, bot.entity.position.y + 1.62, bank.z), true);
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      await actionDelay(bot, 50);
      if (bot.entity.isInWater !== true && bot.entity.onGround === true) return true;
    }
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
  }
  return bot.entity.isInWater !== true && bot.entity.onGround === true;
}
