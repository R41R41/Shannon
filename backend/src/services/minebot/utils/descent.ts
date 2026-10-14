import { Vec3 } from 'vec3';
import { holdsWater } from './waterBlocks.js';

/**
 * Getting down from a height the route planner will not leave. It allows a drop of four blocks and digs
 * downwards, so a body on a lone block with more air than that around and beneath it has no route anywhere,
 * and every move ends at once with "no path" (common run 7: a jungle tree, a branch log 12 blocks up, ten
 * minutes and eleven moves). A person climbs down the vines, jumps into the water, or takes the fall.
 */
export interface DescentBlock { name: string; boundingBox: string }
export interface DescentBot {
  entity?: { position: Vec3 };
  health?: number;
  blockAt(position: Vec3): DescentBlock | null;
}
export interface DescentOption {
  /** Unit step from the body's cell to the cell it steps off into. */
  dx: number; dz: number;
  /** Blocks fallen onto the landing, counting from the last climbable passed (a fall resets on vines). */
  drop: number;
  /** Fall damage on that landing, and if every climbable on the way were missed. */
  damage: number; worstDamage: number;
  landing: string; landingY: number;
  via: 'climbable' | 'water' | 'fall';
}

const CARDINALS = [{ dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 }];
// Scaffolding is solid from above: it is landed on, not slid down.
const CLIMBABLE = new Set(['vine', 'ladder', 'weeping_vines', 'weeping_vines_plant', 'twisting_vines',
  'twisting_vines_plant', 'cave_vines', 'cave_vines_plant']);
// Landings that hurt beyond the fall: a fall onto dripstone does about twice its height plus four.
const HARMFUL = new Set(['lava', 'fire', 'soul_fire', 'campfire', 'soul_campfire', 'magma_block', 'pointed_dripstone',
  'sweet_berry_bush', 'wither_rose', 'powder_snow', 'cactus']);
const SCAN_DEPTH = 64;

/** Vanilla fall damage: one point per block fallen beyond three. */
export const fallDamage = (drop: number) => Math.max(0, Math.ceil(drop - 3));
const passable = (block: DescentBlock | null) => !!block && block.boundingBox === 'empty' && !HARMFUL.has(block.name);
/** Water the body sinks into: a waterlogged block (roots, leaves, slabs) is landed on, above its water. */
const openWater = (block: DescentBlock) => block.boundingBox === 'empty' && holdsWater(block as any);
const harmfulBeside = (bot: DescentBot, x: number, y: number, z: number) =>
  CARDINALS.some(({ dx, dz }) => { const block = bot.blockAt(new Vec3(x + dx, y, z + dz)); return !!block && HARMFUL.has(block.name); });

/**
 * Every way off the body's cell, best first: least damage, then not onto leaves, then the shortest drop. A
 * neighbour level with the body (drop 0) is a walk and is included, so a caller can tell a ledge from a perch.
 */
export function planDescent(bot: DescentBot): DescentOption[] {
  if (!bot.entity) return [];
  const feet = bot.entity.position.floored();
  // On footing lower than a block (a path, farmland, soul sand) the floored cell is that block: the feet are above it.
  if (bot.blockAt(feet)?.boundingBox === 'block') feet.y += 1;
  const options: DescentOption[] = [];
  for (const { dx, dz } of CARDINALS) {
    const x = feet.x + dx, z = feet.z + dz;
    if (!passable(bot.blockAt(new Vec3(x, feet.y, z))) || !passable(bot.blockAt(new Vec3(x, feet.y + 1, z)))) continue;
    let fallFrom = feet.y, climbed = false, option: DescentOption | null = null;
    for (let depth = 1; depth <= SCAN_DEPTH && !option; depth++) {
      const y = feet.y - depth, block = bot.blockAt(new Vec3(x, y, z));
      // Unloaded below: no landing is known, so this way is not taken.
      if (!block) break;
      if (HARMFUL.has(block.name)) break;
      const worstDamage = fallDamage(feet.y - (y + 1));
      if (openWater(block)) {
        // Missing a pool one block wide lands beside it, about at its surface: that is the worst case.
        option = { dx, dz, drop: fallFrom - (y + 1), damage: 0, worstDamage, landing: block.name, landingY: y, via: 'water' };
      } else if (CLIMBABLE.has(block.name) && block.name !== 'scaffolding') { fallFrom = y; climbed = true; }
      else if (block.boundingBox === 'block') {
        const drop = fallFrom - (y + 1);
        option = { dx, dz, drop, damage: fallDamage(drop), worstDamage, landing: block.name, landingY: y, via: climbed ? 'climbable' : 'fall' };
      }
    }
    // Fire or lava beside where the body comes to rest is a step away from it.
    if (option && !harmfulBeside(bot, x, option.landingY + 1, z) && !harmfulBeside(bot, x, option.landingY, z)) options.push(option);
  }
  return options.sort((a, b) => a.damage - b.damage || Number(a.landing.endsWith('leaves')) - Number(b.landing.endsWith('leaves'))
    || a.drop - b.drop);
}

/** The most fall damage a descent may take: the body keeps at least eight health (four hearts) after it. */
export function descentAllowance(health: number, requested?: number): number {
  const keep = Math.max(0, health - 8);
  return requested === undefined ? keep : Math.max(0, Math.min(requested, keep));
}

/**
 * True when the body stands where the route planner sees no way down: no neighbour to step onto within the four
 * blocks it may drop, though a descent exists. Said with a move's "no path" so the planner reaches for climb-down.
 */
export function strandedOnHeight(bot: DescentBot): DescentOption | null {
  const options = planDescent(bot);
  // The planner neither climbs down vines nor drops more than four into water: it sees each way's whole height.
  const plannerDrop = (option: DescentOption) => bot.entity!.position.floored().y - (option.landingY + 1);
  if (!options.length || options.some(option => plannerDrop(option) <= 4)) return null;
  return options[0];
}
