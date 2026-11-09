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

/** shaftStepRefusal's answer said exactly: which block is where (coordinates, and how far under or beside the feet), for whoever is told why the shaft stopped. */
export function explainShaftRefusal(bot: ShaftBody, feet: Vec3, why: string): string {
  const name = (x: number, y: number, z: number) => bot.blockAt(new Vec3(x, y, z))?.name ?? '未読み込み';
  const floor = { x: feet.x, y: feet.y - 1, z: feet.z }, under = { x: feet.x, y: feet.y - 2, z: feet.z };
  const text = (cell: { x: number; y: number; z: number }, label: string) => `${label}(${cell.x},${cell.y},${cell.z})は${name(cell.x, cell.y, cell.z)}`;
  switch (why) {
    case 'floor_not_diggable': case 'floor_protected': return `${text(floor, '足元の')}（真下1マス。掘れない・壊さない決まりのブロック）`;
    case 'no_rock_under': return `${text(under, '足元の2マス下の')}（真下2マス。岩でない・液体・立てない床）`;
    case 'falling_under': return `${text(under, '足元の2マス下の')}（真下2マス。落ちるブロック）`;
    case 'liquid_beside': {
      for (const [dx, dz] of SIDES) {
        const side = { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz };
        if (LIQUIDS.has(name(side.x, side.y, side.z))) return `${text(side, '下りる先の横の')}（足元の下の${dx > 0 ? '東' : dx < 0 ? '西' : dz > 0 ? '南' : '北'}隣。液体）`;
      }
      return '下りる先の横に液体があります';
    }
    default: return why;
  }
}

/** A floor counts as a perch in the air when at least this many of its four sides are open down to the ground this far or more. */
const PERCH_DROP = 4;
const PERCH_SIDES = 3;
const GROUND_SCAN = 48;
/** Still water this deep under a perch's side takes a fall from any height. */
const POOL_DEPTH = 2;

/**
 * end1109 S9 (h32b, 17:12 to the end): a go laid a stair 16 high into the open air and stopped on it; the head's stair down took one step to a ledge on the
 * pillar's side (no face to lay the next step on: no_floor, "another shape, or lay a foothold"), and the head, told nothing of the shaft, waited out the
 * night on the ledge, 0 m/s for seven minutes. A player on a column of their own blocks digs down through it. When the feet stand on a perch in the air,
 * the way down said exactly: the shaft from here, or from the column beside (the top of the pillar a ledge hangs on), or back the way laid; null when the
 * body is not on a perch.
 */
export function airPerchHint(bot: ShaftBody, feet: Vec3): string | null {
  const floor = bot.blockAt(feet.offset(0, -1, 0));
  if (!floor || floor.boundingBox !== 'block') return null;
  let open = 0, ground: number | null = null;
  let pool: { at: Vec3; depth: number } | null = null;
  for (const [dx, dz] of SIDES) {
    const side = bot.blockAt(feet.offset(dx, -1, dz));
    if (!side || side.boundingBox === 'block' || LIQUIDS.has(side.name)) continue;
    for (let d = 2; d <= GROUND_SCAN; d++) {
      const block = bot.blockAt(feet.offset(dx, -d, dz));
      if (!block) break;
      if (block.boundingBox !== 'block' && !LIQUIDS.has(block.name)) continue;
      if (d - 1 >= PERCH_DROP) {
        open++; ground = Math.max(ground ?? -Infinity, feet.y - d + 1);
        let depth = 0;
        while (depth < POOL_DEPTH && bot.blockAt(feet.offset(dx, -d - depth, dz))?.name === 'water') depth++;
        if (depth >= POOL_DEPTH && !pool) pool = { at: feet.offset(dx, -d, dz), depth };
      }
      break;
    }
  }
  if (open < PERCH_SIDES || ground === null) return null;
  const drop = feet.y - ground;
  // end1109s10 S9 (262 to 634 s): a go laid a stair 24 over a sea and stopped on it; told only to dig a shaft or walk back, the head
  // tried the go again three times (search_timeout) and waited a minute before a slip dropped it into the water unhurt. Water breaks
  // any fall, and a go with waterOk may drop into it from any height: the one step off is named first.
  if (pool) return `宙の足場（落差 ${drop}）: 隣の下 (${pool.at.x},${pool.at.y},${pool.at.z}) は深さ ${pool.depth} 以上の水。水に落ちれば傷を受けない: go ${pool.at.x},${pool.at.y},${pool.at.z} waterOk range=1 で飛び降りる`;
  if (shaftStepRefusal(bot, feet) === null) return `宙の足場（落差 ${drop}）: ここから vertical down shape=shaft toY=${ground} で真下へ下りられる`;
  for (const [dx, dz] of SIDES) {
    for (const dy of [0, -1, 1]) {
      const cell = feet.offset(dx, dy, dz);
      const at = bot.blockAt(cell), above = bot.blockAt(cell.offset(0, 1, 0));
      if (!at || !above || at.boundingBox === 'block' || above.boundingBox === 'block') continue;
      if (shaftStepRefusal(bot, cell) === null) return `宙の足場（落差 ${drop}）: 隣の (${cell.x},${cell.y},${cell.z}) へ移り vertical down shape=shaft toY=${ground} で下りる`;
    }
  }
  return `宙の足場（落差 ${drop}）で真下の列は固くない: 置いてきた足場を go で戻り地面へ`;
}
