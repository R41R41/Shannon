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
 * The nearest cell on dry land to stand on, for a body in the water that is to go on from land: a solid floor, two open cells above it,
 * neither the water nor a cell beside lava. Looked for within `radius` cells flat and a few levels up and down from the swimmer; of equal
 * distance, the one most in the direction of travel. Null when none is known (the route search then swims out as before).
 */
export function nearestDryStand(bot: SwimmerBot, towardX: number, towardZ: number, radius = 8): Vec3 | null {
  const position = bot.entity.position;
  const cell = position.floored();
  const heading = Math.atan2(towardZ - position.z, towardX - position.x);
  const candidates: Array<{ at: Vec3; feet: Vec3; score: number }> = [];
  try {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const flat = Math.hypot(dx, dz);
        if (flat > radius) continue;
        for (let dy = -3; dy <= 3; dy++) {
          const feet = new Vec3(cell.x + dx, cell.y + dy, cell.z + dz);
          const floor = bot.blockAt(feet.offset(0, -1, 0), false);
          if (!solid(floor) || !open(bot.blockAt(feet, false)) || !open(bot.blockAt(feet.offset(0, 1, 0), false))) continue;
          const turn = flat === 0 ? 0 : Math.abs(Math.atan2(Math.sin(Math.atan2(dz, dx) - heading), Math.cos(Math.atan2(dz, dx) - heading)));
          candidates.push({ at: feet.offset(0.5, 0, 0.5), feet, score: flat + Math.abs(dy) * 1.5 + turn });
        }
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    // A stand at the water's edge starts a tunnel beside the water, which a tunnel is not cut beside (liquid_beside): of the stands,
    // one with no water within two cells is worth a few cells more walking (the lab: a stair begun at the shore was refused).
    let best: { at: Vec3; score: number } | null = null;
    for (const entry of candidates.slice(0, 250)) {
      const score = entry.score + (liquidWithin(bot, entry.feet, 2) ? SHORE_PENALTY : 0);
      if (!best || score < best.score) best = { at: entry.at, score };
    }
    return best?.at ?? null;
  } catch { return null; }
}

/** Walking this much further (in cells) is preferred to a stand with water within two cells of it. */
const SHORE_PENALTY = 6;

/** Water or lava within `reach` cells of the feet cell, flat, and from two cells under to one over. */
function liquidWithin(bot: SwimmerBot, feet: Vec3, reach: number): boolean {
  for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) for (let dy = -2; dy <= 1; dy++) {
    const block = bot.blockAt(feet.offset(dx, dy, dz), false);
    if (holdsWater(block) || block?.name === 'lava') return true;
  }
  return false;
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
