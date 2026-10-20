import { Vec3 } from 'vec3';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';

/**
 * A step of a descent taken straight down: the block under the feet is dug and the body drops one block onto the rock under it.
 *
 * A stair digs three blocks for each level (the head and the feet of the next column, and the step under them); straight down digs
 * one. Measured on the lab copy of run 19's world (2026-10-20), a stair went 24 levels through stone in 58.9 s, 2.45 s a level, 70% of
 * it digging; the descent to the diamonds (y -58, half of it deepslate at twice the dig time) is about 120 levels.
 *
 * The danger a person fears in digging straight down is what lies below unseen. The body sees it: every block of the loaded chunks is
 * known. So a level is taken straight down only onto solid rock one block under (a fall of one, never into a cave or a ravine), with no
 * liquid beside the cell it drops into or under it, and not onto magma or powder snow. The dig itself is held to the rules of every
 * dig (lava it would let loose, a hostile it would let in). Anything else is a stair step, as before.
 */

const LIQUIDS = new Set(['water', 'lava', 'flowing_water', 'flowing_lava', 'bubble_column']);
const BAD_FLOORS = new Set(['magma_block', 'powder_snow', 'pointed_dripstone', 'campfire', 'soul_campfire']);
/** Blocks that fall: the floor dug from over one sets it falling into whatever is under it, the body on top. */
const FALLING = /^(gravel|sand|red_sand|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/;
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

interface ShaftBlock { name: string; boundingBox?: string; diggable?: boolean }
interface ShaftBody { blockAt(position: Vec3): ShaftBlock | null }

/** Why the block under `feet` may not be dug for a drop straight down, or null when it may. */
export function shaftStepRefusal(bot: ShaftBody, feet: Vec3): string | null {
  const floorAt = feet.offset(0, -1, 0);
  const floor = bot.blockAt(floorAt);
  const under = bot.blockAt(feet.offset(0, -2, 0));
  if (!floor || floor.boundingBox !== 'block' || floor.diggable === false) return 'floor_not_diggable';
  if (PROTECTED_UTILITY_BLOCKS.has(floor.name) || floor.name === 'bedrock') return 'floor_protected';
  if (!under || under.boundingBox !== 'block' || LIQUIDS.has(under.name) || BAD_FLOORS.has(under.name)) return 'no_rock_under';
  if (FALLING.test(under.name)) return 'falling_under';
  for (const [dx, dz] of SIDES) {
    // The cell dropped into: no liquid beside it (the level under it is asked at the next step, from there).
    const side = bot.blockAt(feet.offset(dx, -1, dz));
    if (!side) return 'unloaded';
    if (LIQUIDS.has(side.name)) return 'liquid_beside';
  }
  return null;
}
