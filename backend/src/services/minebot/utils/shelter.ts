import type { Vec3 } from 'vec3';

interface ShelterBody {
  entity?: { position: Vec3; isInWater?: boolean };
  blockAt(position: Vec3): { boundingBox?: string } | null;
}

/**
 * Whether the body stands closed in: the cells of its feet and head free, a
 * solid floor, a solid roof, and solid walls on all four sides at both
 * levels. Mobs cannot reach in, and nothing outside has a line to it.
 */
export function isSealedIn(bot: ShelterBody): boolean {
  const entity = bot.entity;
  if (!entity || entity.isInWater) return false;
  const feet = entity.position.floored();
  const solid = (dx: number, dy: number, dz: number) => {
    try { return bot.blockAt(feet.offset(dx, dy, dz))?.boundingBox === 'block'; } catch { return false; }
  };
  if (solid(0, 0, 0) || solid(0, 1, 0) || !solid(0, 2, 0) || !solid(0, -1, 0)) return false;
  return [0, 1].every(dy => solid(1, dy, 0) && solid(-1, dy, 0) && solid(0, dy, 1) && solid(0, dy, -1));
}
