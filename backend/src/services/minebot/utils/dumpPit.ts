/**
 * A place to throw things in a tunnel. A dropped item is picked up again from within a block of the body after two seconds, so in a
 * 1x2 tunnel, a stair or a shaft (where the throw lands within reach and there is nowhere to walk far from it) drop-item refused:
 * run 20 was told "too narrow" for 49 tuff and the rest of the reply was never run. A player digs a hole: three blocks deep, next
 * to where he stands, throws into it and puts a block over it. This plans that hole; drop-item digs it, throws, and covers it.
 *
 * The hole is a column beside the body: its cells from head height down to three below the feet are air (the dug ones were stone), so
 * what is thrown into it rests three blocks down, out of reach (drop-item's existing `pit` mode finds it as it would any pit). The
 * cell at floor level is filled again with a block afterwards, so a tunnel keeps its floor.
 */
import { Vec3 } from 'vec3';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const LIQUID = new Set(['water', 'lava', 'flowing_water', 'flowing_lava', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
/** Blocks that fall into the hole when what holds them goes. */
const FALLING = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel', 'anvil']);
const isFalling = (name: string) => FALLING.has(name) || name.endsWith('_concrete_powder');
/** The deepest the hole goes below the feet (the finder wants three below the feet to be air). */
const DEPTH_BELOW_FEET = 3;
/** Most blocks dug for one hole (a wall niche takes five: head, feet and three down). */
export const MAX_PIT_DIGS = 5;
/** The lowest level a hole is dug to (bedrock lies from -64 to -60 in the overworld). */
const LOWEST_CELL_Y = -58;

type BlockLike = { name: string; boundingBox?: string; diggable?: boolean } | null | undefined;
export interface PitBody { blockAt(position: Vec3): BlockLike }

export interface DumpPitPlan {
  /** The column of the hole (x, z) and the level of the feet it was planned from. */
  column: { x: number; z: number; feetY: number };
  /** Cells to dig, top first (air already there is not listed). */
  dig: Vec3[];
  /** The cell to fill again afterwards (the floor of the column), or null when the floor was open before. */
  cap: Vec3 | null;
}

const isAir = (block: BlockLike) => !!block && AIR.has(block.name);
const isLiquid = (block: BlockLike) => !!block && LIQUID.has(block.name);

/**
 * The hole to dig from the cell the body stands in (`feet`, floored): of the four columns beside it, the one needing the fewest digs
 * (at most MAX_PIT_DIGS), none beside or under liquid, none under a falling block, none through bedrock or equipment. Null when none
 * qualifies, or when the body does not stand with air at feet and head over a solid floor.
 */
export function planDumpPit(bot: PitBody, feet: Vec3): DumpPitPlan | null {
  const standable = isAir(bot.blockAt(feet)) && isAir(bot.blockAt(feet.offset(0, 1, 0))) && !!bot.blockAt(feet.offset(0, -1, 0))
    && !isAir(bot.blockAt(feet.offset(0, -1, 0)));
  if (!standable || feet.y - DEPTH_BELOW_FEET - 1 < LOWEST_CELL_Y) return null;
  let best: { plan: DumpPitPlan; cost: number } | null = null;
  for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const x = feet.x + ox, z = feet.z + oz;
    const levels = [1, 0, -1, -2, -3].map(dy => feet.y + dy);
    const dig: Vec3[] = [];
    let ok = true;
    for (const y of levels) {
      const at = new Vec3(x, y, z);
      const block = bot.blockAt(at);
      if (!block) { ok = false; break; }
      if (isAir(block)) continue;
      // Open but not air (a plant, a torch) is left to the caller's judgement: not a place for a hole.
      if (block.boundingBox !== 'block' || block.diggable === false || block.name === 'bedrock' || PROTECTED_UTILITY_BLOCKS.has(block.name)
        || isLiquid(block) || isFalling(block.name)) { ok = false; break; }
      // What lies over a dug cell must not fall into it, and nothing wet or molten beside it may run in.
      const over = bot.blockAt(at.offset(0, 1, 0));
      if (!over || isLiquid(over) || isFalling(over.name)) { ok = false; break; }
      dig.push(at);
    }
    if (!ok || dig.length > MAX_PIT_DIGS) continue;
    // The ring round the whole column (the body's own column apart), and the cell under its bottom.
    const around: Vec3[] = [new Vec3(x, feet.y - DEPTH_BELOW_FEET - 1, z)];
    for (const y of levels) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const cell = new Vec3(x + dx, y, z + dz);
      if (cell.x === feet.x && cell.z === feet.z) continue;
      around.push(cell);
    }
    if (around.some(cell => { const block = bot.blockAt(cell); return !block || isLiquid(block); })) continue;
    // The column's own top: nothing falling over the head-height cell either.
    const top = bot.blockAt(new Vec3(x, feet.y + 2, z));
    if (top && (isLiquid(top) || isFalling(top.name))) continue;
    const floor = new Vec3(x, feet.y - 1, z);
    const cap = dig.some(cell => cell.equals(floor)) ? floor : null;
    // A column that is already open at the feet (a tunnel cell) is cheaper than a niche in a wall; fewest digs first.
    const cost = dig.length * 2 + (isAir(bot.blockAt(new Vec3(x, feet.y, z))) ? 0 : 1);
    if (!best || cost < best.cost) best = { plan: { column: { x, z, feetY: feet.y }, dig, cap }, cost };
  }
  return best?.plan ?? null;
}
