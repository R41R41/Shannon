import { Vec3 } from 'vec3';

/** How far from the eyes the server lets a bucket take liquid (block interaction range, with a little kept back). */
export const LIQUID_REACH = 4.3;

interface AimBot { entity: { position: Vec3 }; blockAt(position: Vec3): any }

// Places in the cell to look at: the surface first, then lower down and towards each side. From a pocket
// dug into a ceiling the surface and the centre are behind the ceiling's edge and the bottom of the cell is not.
const CANDIDATES: Array<[number, number, number]> = [[0.5, 0.9, 0.5], [0.5, 0.5, 0.5], [0.5, 0.9, 0.15], [0.5, 0.9, 0.85], [0.15, 0.9, 0.5],
  [0.85, 0.9, 0.5], [0.5, 0.1, 0.5], [0.5, 0.1, 0.15], [0.5, 0.1, 0.85], [0.15, 0.1, 0.5], [0.85, 0.1, 0.5]];

/**
 * The first solid block the straight line from `from` to `to` passes through, short of the cell `target`.
 * Every cell on the line is visited (a walk over the grid, not samples along it): a sample every 0.2 blocks
 * steps over the corner of a block the line clips, and the server's own ray does not.
 */
export function firstSolidBetween(bot: Pick<AimBot, 'blockAt'>, from: Vec3, to: Vec3, target: Vec3): { name: string; at: Vec3 } | null {
  const delta = to.minus(from);
  const cell = from.floored();
  const step = new Vec3(Math.sign(delta.x), Math.sign(delta.y), Math.sign(delta.z));
  const next = (origin: number, d: number, at: number) => d === 0 ? Infinity : ((d > 0 ? at + 1 : at) - origin) / d;
  let tx = next(from.x, delta.x, cell.x), ty = next(from.y, delta.y, cell.y), tz = next(from.z, delta.z, cell.z);
  const dx = delta.x === 0 ? Infinity : Math.abs(1 / delta.x), dy = delta.y === 0 ? Infinity : Math.abs(1 / delta.y), dz = delta.z === 0 ? Infinity : Math.abs(1 / delta.z);
  for (let guard = 0; guard < 64; guard++) {
    if (cell.equals(target)) return null;
    if (guard > 0) {
      let block: any = null;
      try { block = bot.blockAt(cell); } catch { block = null; }
      if (block && block.boundingBox === 'block') return { name: String(block.name), at: cell.clone() };
    }
    const t = Math.min(tx, ty, tz);
    if (t > 1) return null;
    if (tx === t) { cell.x += step.x; tx += dx; } else if (ty === t) { cell.y += step.y; ty += dy; } else { cell.z += step.z; tz += dz; }
  }
  return null;
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
