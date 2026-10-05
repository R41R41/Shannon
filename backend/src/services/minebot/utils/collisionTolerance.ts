import { createRequire } from 'node:module';

/**
 * Touching is not overlapping. The physics library decides whether a block
 * stops the body with exact comparisons: a block clips a move only when the
 * body lies wholly on one side of it. A body standing flush against a block
 * is stored as a centre and a half-width, and for block faces on a few planes
 * (x or z = ±2, ±32, ±512, where the spacing of floating-point numbers
 * changes) centre ± 0.3 lands one bit past the face. The body then counts as
 * already inside the block, nothing clips the move, and the client walks into
 * a wall it can see. The server, which allows a tolerance, refuses every such
 * step and puts the body back: the corrections that froze L26 and ran to the
 * hundreds from L31 to L46, always at coordinates like x=-2.3, z=32.3 or
 * z=-512.3, in worlds that had nothing else in common.
 *
 * The same tolerance as the game itself uses: faces within 1e-7 of each other
 * are touching, sideways as well as ahead (so a body sliding along such a
 * wall is not caught on the next block of it either).
 */
export const COLLISION_EPSILON = 1e-7;

type Box = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
const AXES = [
  { name: 'computeOffsetX', min: 'minX', max: 'maxX', side: [['minY', 'maxY'], ['minZ', 'maxZ']] },
  { name: 'computeOffsetY', min: 'minY', max: 'maxY', side: [['minX', 'maxX'], ['minZ', 'maxZ']] },
  { name: 'computeOffsetZ', min: 'minZ', max: 'maxZ', side: [['minX', 'maxX'], ['minY', 'maxY']] },
] as const;

let original: Record<string, unknown> | null = null;

function collisionBox(): { prototype: Record<string, any> } {
  return createRequire(import.meta.url)('prismarine-physics/lib/aabb.js');
}

export function installCollisionTolerance(): void {
  const proto = collisionBox().prototype;
  if (original) return;
  original = Object.fromEntries(AXES.map(axis => [axis.name, proto[axis.name]]));
  for (const axis of AXES) {
    // `this` is the block's box, `other` the body's; the return value is how far the body may move along the axis.
    proto[axis.name] = function (this: Box, other: Box, offset: number): number {
      for (const [low, high] of axis.side) {
        if (!((other as any)[high] > (this as any)[low] + COLLISION_EPSILON && (other as any)[low] < (this as any)[high] - COLLISION_EPSILON)) return offset;
      }
      if (offset > 0 && other[axis.max] <= this[axis.min] + COLLISION_EPSILON) return Math.min(Math.max(0, this[axis.min] - other[axis.max]), offset);
      if (offset < 0 && other[axis.min] >= this[axis.max] - COLLISION_EPSILON) return Math.max(Math.min(0, this[axis.max] - other[axis.min]), offset);
      return offset;
    };
  }
}

/** Put the library's own comparisons back (tests and lab comparisons only). */
export function uninstallCollisionTolerance(): void {
  if (!original) return;
  const proto = collisionBox().prototype;
  for (const axis of AXES) proto[axis.name] = original[axis.name];
  original = null;
}
