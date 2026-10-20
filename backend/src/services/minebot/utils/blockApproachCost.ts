import { Vec3 } from 'vec3';

/**
 * Cheap, deliberately conservative ranking proxy for a block whose actual
 * path has not been computed yet.  Vertical travel commonly needs stairs,
 * support blocks or tunnelling, so one vertical metre costs more than one
 * horizontal metre.  This only orders known candidates: it never declares a
 * lower cave unreachable or replaces pathfinder's real route validation.
 */
export function estimateBlockApproachCost(
  from: { x: number; y: number; z: number },
  block: { x: number; y: number; z: number },
  exposed = true,
): number {
  const dx = from.x - (block.x + 0.5);
  const dy = from.y - (block.y + 0.5);
  const dz = from.z - (block.z + 0.5);
  return Math.hypot(dx, dy * 2, dz) + (exposed ? 0 : 8);
}

/** Metres of walking that one solid cell on the straight line costs: a tunnel through it digs about two blocks (head and feet). */
export const SOLID_CELL_METRES = 6;
/** The straight line is read this far at most: beyond, the geometry alone ranks. */
const LINE_LIMIT = 40;

interface LineBot { blockAt(position: any): { boundingBox?: string } | null }

/**
 * Solid cells the straight line from the eyes to a block passes through (the block's own cell not counted): 0 for an ore in sight across
 * a cave, several for one buried in the rock. Sampled every half block, each cell counted once. Unknown (unloaded) cells count as solid.
 */
export function solidCellsBetween(bot: LineBot, eyes: { x: number; y: number; z: number }, block: { x: number; y: number; z: number }): number {
  const tx = block.x + 0.5, ty = block.y + 0.5, tz = block.z + 0.5;
  const length = Math.hypot(tx - eyes.x, ty - eyes.y, tz - eyes.z);
  if (!(length > 0)) return 0;
  const steps = Math.ceil(Math.min(length, LINE_LIMIT) * 2);
  // The body's own cells (eyes and feet) are where it stands, never rock to dig.
  const ex = Math.floor(eyes.x), ey = Math.floor(eyes.y), ez = Math.floor(eyes.z);
  const seen = new Set<string>([`${ex},${ey},${ez}`, `${ex},${ey - 1},${ez}`]);
  let solid = 0;
  for (let i = 1; i < steps; i++) {
    const t = i / (length * 2);
    const x = Math.floor(eyes.x + (tx - eyes.x) * t), y = Math.floor(eyes.y + (ty - eyes.y) * t), z = Math.floor(eyes.z + (tz - eyes.z) * t);
    if (x === block.x && y === block.y && z === block.z) break;
    const key = `${x},${y},${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let cell: { boundingBox?: string } | null = null;
    try { cell = bot.blockAt(new Vec3(x, y, z)); } catch { cell = null; }
    if (!cell || cell.boundingBox === 'block') solid++;
  }
  return solid;
}

/**
 * The ranking of a mine-block candidate from where the body stands: the distance (height counted twice, as above) and the rock to be
 * tunnelled to it on the straight line. An ore in sight is taken before one a few blocks nearer inside the wall: in the lab copy of
 * run 19's world, ten iron took 146 s, most of it digging stone towards ores chosen by distance (2026-10-20).
 */
export function minedApproachCost(bot: LineBot, eyes: { x: number; y: number; z: number }, block: { x: number; y: number; z: number; exposed?: boolean }): number {
  const dx = eyes.x - (block.x + 0.5), dy = eyes.y - 1.62 - (block.y + 0.5), dz = eyes.z - (block.z + 0.5);
  // A face open to the air (a cave wall) keeps its own small lead, as in estimateBlockApproachCost.
  return Math.hypot(dx, dy * 2, dz) + SOLID_CELL_METRES * solidCellsBetween(bot, eyes, block) + (block.exposed === false ? 8 : 0);
}
