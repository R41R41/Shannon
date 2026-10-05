import { Vec3 } from 'vec3';

/**
 * Whether the eyes can see a point, and which point of a body they can see.
 *
 * The server takes a blow at anything within three blocks, wall or no wall: it measures the distance and does
 * not ask what is in between. A person cannot strike what they cannot point at, and a body that struck through
 * rock would be doing what no player can. So a blow from a held position is struck only at a point of the
 * target that the eyes see, by the real shapes of the blocks on the way: a slab fills half its cell, and the
 * gap under it is a gap.
 *
 * It is also what makes a slit worth building. A mob knows of the body by a line from its eyes to the body's
 * eyes, and nothing else; the body may strike any part of the mob it can see. Through a gap whose upper edge is
 * below the line between the two pairs of eyes, the body sees the mob's legs and the mob sees nothing.
 */
interface SightBot {
  entity?: { position: Vec3 };
  world?: { raycast?(from: Vec3, direction: Vec3, range: number): { intersect?: Vec3; position?: Vec3 } | null };
}

const EYES = 1.62;

/** Nothing solid on the straight line from the eyes to the point. With no world to ask (a test body), taken as clear. */
export function seesPoint(bot: SightBot, point: Vec3, eyes = bot.entity?.position.offset(0, EYES, 0)): boolean {
  if (!eyes) return false;
  const line = point.minus(eyes);
  const distance = line.norm();
  if (distance < 0.05) return true;
  const raycast = bot.world?.raycast;
  if (typeof raycast !== 'function') return true;
  let hit: { intersect?: Vec3 } | null = null;
  try { hit = raycast.call(bot.world, eyes, line.scaled(1 / distance), distance); } catch { return false; }
  return !hit || !hit.intersect || hit.intersect.distanceTo(eyes) >= distance - 0.02;
}

/**
 * The nearest point of a target's body that the eyes can see and a blow can reach, or null. Points are taken
 * up and down the body and across it; the nearest that can be seen is the one to strike at.
 */
export function visiblePointOn(bot: SightBot, target: { position: Vec3; height?: number; width?: number }, reach = 3): Vec3 | null {
  const eyes = bot.entity?.position.offset(0, EYES, 0);
  if (!eyes) return null;
  const height = target.height ?? 1.8, half = ((target.width ?? 0.6) / 2) * 0.8;
  const points: Vec3[] = [];
  for (let up = 0.1; up < height; up += 0.2) {
    for (const [dx, dz] of [[0, 0], [half, 0], [-half, 0], [0, half], [0, -half]]) points.push(target.position.offset(dx, up, dz));
  }
  return points.map(point => ({ point, distance: point.distanceTo(eyes) })).filter(entry => entry.distance <= reach)
    .sort((a, b) => a.distance - b.distance).find(entry => seesPoint(bot, entry.point, eyes))?.point ?? null;
}
