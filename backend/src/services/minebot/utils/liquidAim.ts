import { Vec3 } from 'vec3';

/** How far from the eyes the server lets a bucket take liquid (block interaction range, with a little kept back). */
export const LIQUID_REACH = 4.3;

interface AimBot { entity: { position: Vec3 }; blockAt(position: Vec3): any }

// Places in the cell to look at: the surface first, then lower down and towards each side. From a pocket
// dug into a ceiling the surface and the centre are behind the ceiling's edge and the bottom of the cell is not.
const CANDIDATES: Array<[number, number, number]> = [[0.5, 0.9, 0.5], [0.5, 0.5, 0.5], [0.5, 0.9, 0.15], [0.5, 0.9, 0.85], [0.15, 0.9, 0.5],
  [0.85, 0.9, 0.5], [0.5, 0.1, 0.5], [0.5, 0.1, 0.15], [0.5, 0.1, 0.85], [0.15, 0.1, 0.5], [0.85, 0.1, 0.5]];

/**
 * The solid blocks the straight line from `from` to `to` passes through, short of the cell `target`, nearest first (`first`: only the first).
 * Every cell on the line is visited (a walk over the grid, not samples along it): a sample every 0.2 blocks steps over the corner of a block
 * the line clips, and the server's own ray does not.
 * A line that crosses two or three cell borders at the same instant (a source one block aside on both horizontal axes, aimed at its middle from
 * the middle of a cell: run 9, 11 refusals in a tunnel) goes between the cells beside its path, and which of them the server's ray enters first is
 * not the body's to say: every cell beside such a crossing counts, so the line is clear only when all of them are.
 */
function solidsBetween(bot: Pick<AimBot, 'blockAt'>, from: Vec3, to: Vec3, target: Vec3, first: boolean): Array<{ name: string; at: Vec3 }> {
  const found: Array<{ name: string; at: Vec3 }> = [];
  const delta = to.minus(from);
  const cell = from.floored();
  const step = new Vec3(Math.sign(delta.x), Math.sign(delta.y), Math.sign(delta.z));
  const next = (origin: number, d: number, at: number) => d === 0 ? Infinity : ((d > 0 ? at + 1 : at) - origin) / d;
  let tx = next(from.x, delta.x, cell.x), ty = next(from.y, delta.y, cell.y), tz = next(from.z, delta.z, cell.z);
  const dx = delta.x === 0 ? Infinity : Math.abs(1 / delta.x), dy = delta.y === 0 ? Infinity : Math.abs(1 / delta.y), dz = delta.z === 0 ? Infinity : Math.abs(1 / delta.z);
  const solid = (at: Vec3) => {
    if (at.equals(target) || found.some(entry => entry.at.equals(at))) return false;
    let block: any = null;
    try { block = bot.blockAt(at); } catch { block = null; }
    if (block && block.boundingBox === 'block') { found.push({ name: String(block.name), at: at.clone() }); return true; }
    return false;
  };
  for (let guard = 0; guard < 64; guard++) {
    if (cell.equals(target)) return found;
    if (guard > 0 && solid(cell) && first) return found;
    const t = Math.min(tx, ty, tz);
    if (t > 1) return found;
    const axes = ([['x', tx], ['y', ty], ['z', tz]] as const).filter(([, value]) => Math.abs(value - t) < 1e-9).map(([axis]) => axis);
    if (axes.length > 1) {
      // Every cell reached by crossing some, but not all, of the borders met at this instant.
      for (let mask = 1; mask < (1 << axes.length) - 1; mask++) {
        const beside = cell.clone();
        axes.forEach((axis, index) => { if (mask & (1 << index)) beside[axis] += step[axis]; });
        if (solid(beside) && first) return found;
      }
    }
    for (const axis of axes) {
      cell[axis] += step[axis];
      if (axis === 'x') tx += dx; else if (axis === 'y') ty += dy; else tz += dz;
    }
  }
  return found;
}

/** The first solid block on the line from `from` to `to`, short of the cell `target` (see `solidsBetween`). */
export function firstSolidBetween(bot: Pick<AimBot, 'blockAt'>, from: Vec3, to: Vec3, target: Vec3): { name: string; at: Vec3 } | null {
  return solidsBetween(bot, from, to, target, true)[0] ?? null;
}

/** Every solid block on the line from `from` to `to`, short of the cell `target`, nearest first (a wall to open is the one block the line has). */
export function allSolidsBetween(bot: Pick<AimBot, 'blockAt'>, from: Vec3, to: Vec3, target: Vec3): Array<{ name: string; at: Vec3 }> {
  return solidsBetween(bot, from, to, target, false);
}

/** Blocks the bucket's ray passes: nothing is there, or only liquid. Every other block (grass, flowers, snow, rails... which a body walks through) stops the server's ray: it is cast against outlines, not collision. */
const RAY_PASSES = new Set(['air', 'cave_air', 'void_air', 'water', 'bubble_column']);
/** The world as the server's ray sees it. */
export function rayView(bot: { entity: { position: Vec3 }; blockAt(at: Vec3): any }): { entity: { position: Vec3 }; blockAt(at: Vec3): any } {
  return { get entity() { return bot.entity; }, blockAt: (at: Vec3) => {
    const block = bot.blockAt(at) as any;
    return block && block.boundingBox === 'empty' && !RAY_PASSES.has(block.name) ? { ...block, boundingBox: 'block' } : block;
  } };
}

/**
 * The points on the liquid source at `pos` that the eyes can reach in a straight line: within the server's
 * reach, with nothing solid on the way. Other liquid on the way is no obstacle (the first source the ray
 * meets is the one taken, and it is the same liquid). In the order they are worth trying.
 */
export function liquidAimPoints(bot: AimBot, pos: Vec3, reach = LIQUID_REACH): { points: Vec3[]; reason?: string } {
  const eyes = bot.entity.position.offset(0, 1.62, 0);
  const points: Vec3[] = [];
  let reason = '';
  for (const [ox, oy, oz] of CANDIDATES) {
    const point = pos.offset(ox, oy, oz);
    const span = eyes.distanceTo(point);
    if (span > reach) { reason ||= `目から${span.toFixed(1)}m（届くのは${reach}mまで）`; continue; }
    const blocked = firstSolidBetween(bot, eyes, point, pos);
    if (!blocked) { points.push(point); continue; }
    reason = `${blocked.name}(${blocked.at.x},${blocked.at.y},${blocked.at.z})が視線を遮っています`;
  }
  return points.length ? { points } : { points, reason: reason || '視線が通りません' };
}

export function liquidAim(bot: AimBot, pos: Vec3, reach = LIQUID_REACH): { point?: Vec3; reason?: string } {
  const { points, reason } = liquidAimPoints(bot, pos, reach);
  return points.length ? { point: points[0] } : { reason };
}
