import { Vec3 } from 'vec3';

/**
 * The block and face a ray from the eyes first meets, as the server's own ray for a filled bucket does: liquids are gone through, any
 * block with a collision box stops it. A water bucket poured at the face of a block lands in the cell in front of the face the
 * server's ray hits, not in the one aimed at: a lava probe (2026-10-20) emptied its bucket twenty times one cell off from where it
 * aimed, with the lava beside it untouched, because a nearer block's top was in the way of the line.
 *
 * Grid traversal (Amanatides and Woo) over whole cells; non-full shapes count as their cell.
 */
export interface RayHit { cell: Vec3; face: Vec3 }

/**
 * Blocks with no collision box that still stop the server's ray (it traces outlines, not collisions): a bucket aimed past a torch, a
 * ladder or a tuft of grass empties into that cell.
 */
const OUTLINE_ONLY = /(ladder|torch|button|lever|_sign|rail|short_grass|tall_grass|fern|vine|sapling|flower|dandelion|poppy|tulip|orchid|allium|bluet|daisy|_mushroom|carpet|^snow$|pressure_plate|tripwire|redstone_wire|repeater|comparator|candle|lily_pad|seagrass|kelp|cobweb|_coral)/;

export function rayFace(blockAt: (position: Vec3) => { name?: string; boundingBox?: string } | null, from: Vec3, to: Vec3, maxDistance = 5.5): RayHit | null {
  const direction = to.minus(from);
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (length === 0) return null;
  const d = direction.scaled(1 / length);
  const cell = from.floored();
  const step = new Vec3(Math.sign(d.x), Math.sign(d.y), Math.sign(d.z));
  const boundary = (origin: number, unit: number, at: number) => unit > 0 ? (at + 1 - origin) / unit : unit < 0 ? (at - origin) / unit : Infinity;
  let tMaxX = boundary(from.x, d.x, cell.x), tMaxY = boundary(from.y, d.y, cell.y), tMaxZ = boundary(from.z, d.z, cell.z);
  const tDeltaX = d.x !== 0 ? Math.abs(1 / d.x) : Infinity, tDeltaY = d.y !== 0 ? Math.abs(1 / d.y) : Infinity, tDeltaZ = d.z !== 0 ? Math.abs(1 / d.z) : Infinity;
  for (let i = 0; i < 64; i++) {
    let face: Vec3, t: number;
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) { cell.x += step.x; t = tMaxX; tMaxX += tDeltaX; face = new Vec3(-step.x, 0, 0); }
    else if (tMaxY <= tMaxZ) { cell.y += step.y; t = tMaxY; tMaxY += tDeltaY; face = new Vec3(0, -step.y, 0); }
    else { cell.z += step.z; t = tMaxZ; tMaxZ += tDeltaZ; face = new Vec3(0, 0, -step.z); }
    if (t > maxDistance) return null;
    const block = blockAt(cell.clone());
    if (!block) return null;
    if ((block.boundingBox && block.boundingBox !== 'empty') || OUTLINE_ONLY.test(block.name ?? '')) return { cell: cell.clone(), face };
  }
  return null;
}

/** Points on a block's face to aim at: its middle, then four points inset from its corners. */
export function facePoints(block: Vec3, face: Vec3): Vec3[] {
  const centre = block.offset(0.5, 0.5, 0.5).plus(face.scaled(0.5));
  const axes = face.x !== 0 ? [new Vec3(0, 1, 0), new Vec3(0, 0, 1)] : face.y !== 0 ? [new Vec3(1, 0, 0), new Vec3(0, 0, 1)] : [new Vec3(1, 0, 0), new Vec3(0, 1, 0)];
  const points = [centre];
  for (const a of [-0.3, 0.3]) for (const b of [-0.3, 0.3]) points.push(centre.plus(axes[0].scaled(a)).plus(axes[1].scaled(b)));
  return points;
}
