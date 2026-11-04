import { boxesOverlap, inflate, partBox, type Box, type P3 } from './dragonParts.js';
import { seatedDragonHead } from './dragonHeadModel.js';

type BedBlock = { name: string; boundingBox?: string; shapes?: number[][] } | null;
export type BedBlockReader = (p: P3) => BedBlock;
const air = (b: BedBlock) => !!b && /^(air|cave_air|void_air)$/u.test(b.name);
const key = (p: P3) => `${p.x},${p.y},${p.z}`;
const faces = [[0, -1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, 1, 0]];

/** Match the place hand's solid-face rule. An unloaded cell or a liquid is never support. */
export function bedCellSupported(read: BedBlockReader, p: P3): boolean {
  return faces.some(([x, y, z]) => read({ x: p.x + x, y: p.y + y, z: p.z + z })?.boundingBox === 'block');
}

/** Extend each requested screen/support cell down to observed support, then order bottom first.
 * Planned blocks support later blocks only in this geometry result; callers must observe each placement before continuing. */
export function supportedBedCells(targets: P3[], read: BedBlockReader, maxDrop = 16): P3[] | null {
  const planned = new Map<string, P3>();
  const projected: BedBlockReader = p => planned.has(key(p)) ? { name: 'obsidian', boundingBox: 'block' } : read(p);
  for (const target of [...targets].sort((a, b) => a.y - b.y)) {
    const column: P3[] = [];
    let anchored = false;
    for (let y = target.y; y >= target.y - maxDrop; y--) {
      const p = { ...target, y }, block = projected(p);
      if (block?.boundingBox === 'block') { anchored = true; break; }
      if (!air(block)) return null;
      column.push(p);
      if (bedCellSupported(projected, p)) { anchored = true; break; }
    }
    if (!anchored) return null;
    for (const p of column.reverse()) planned.set(key(p), p);
  }
  const cells = [...planned.values()].sort((a, b) => a.y - b.y);
  const confirmed = new Set<string>();
  const ordered: BedBlockReader = p => confirmed.has(key(p)) ? { name: 'obsidian', boundingBox: 'block' } : read(p);
  for (const p of cells) {
    if (!bedCellSupported(ordered, p)) return null;
    confirmed.add(key(p));
  }
  return cells;
}

/** The bed scene's placement: 2.2 blocks past the head, on a supporting column. Geometry only. */
export function perchBedFoot(head: P3, outward: P3, y: number): P3 {
  return { x: Math.floor(head.x + outward.x * 2.2), y: Math.floor(y), z: Math.floor(head.z + outward.z * 2.2) };
}

/** A one-block-thick obsidian screen between the bed and the standing point, built bottom first.
 * Width is the caller's material choice; it is never evidence that the screen stops the blast. */
export function bedWallCells(foot: P3, stand: P3, bottom: number, top: number, width: number): P3[] {
  const alongZ = Math.abs(stand.z - foot.z - 0.5) >= Math.abs(stand.x - foot.x - 0.5);
  const middle = alongZ ? Math.floor((foot.z + 0.5 + stand.z) / 2) : Math.floor((foot.x + 0.5 + stand.x) / 2);
  const cells: P3[] = [];
  for (let y = Math.floor(bottom); y <= Math.floor(top); y++) for (let i = -Math.floor((width - 1) / 2); i <= Math.ceil((width - 1) / 2); i++) {
    cells.push(alongZ ? { x: foot.x + i, y, z: middle } : { x: middle, y, z: foot.z + i });
  }
  return cells;
}

/** 1.21.11 power-five damage is floating point, including the +1 at zero exposure.
 * Normal, before armour: deliberately an upper bound for the iron-clad player's loss. */
export function bedDamage(distance: number, exposure: number): number {
  if (!Number.isFinite(distance) || !Number.isFinite(exposure) || distance < 0 || exposure < 0 || exposure > 1) return NaN;
  if (distance > 10) return 0;
  const q = (1 - distance / 10) * exposure;
  return 35 * (q * q + q) + 1;
}

function intersects(a: P3, b: P3, box: Box): boolean {
  let lo = 0, hi = 1;
  for (const axis of ['X', 'Y', 'Z'] as const) {
    const k = axis.toLowerCase() as keyof P3, d = b[k] - a[k];
    if (Math.abs(d) < 1e-12) { if (a[k] < box[`min${axis}`] || a[k] > box[`max${axis}`]) return false; continue; }
    const t = [(box[`min${axis}`] - a[k]) / d, (box[`max${axis}`] - a[k]) / d].sort((x, y) => x - y);
    lo = Math.max(lo, t[0]); hi = Math.min(hi, t[1]);
    if (lo > hi) return false;
  }
  return hi > 1e-7 && lo < 1 - 1e-7;
}

/** Vanilla's sample grid for the actual target AABB; ray tests use observed collision shapes.
 * Unknown/unloaded shapes provide no shielding. Both bed halves are removed before tracing. */
export function bedExposure(read: BedBlockReader, centre: P3, box: Box, ignore: P3[] = []): number {
  const w = box.maxX - box.minX, h = box.maxY - box.minY, d = box.maxZ - box.minZ;
  if (![...Object.values(box), ...Object.values(centre)].every(Number.isFinite) || Math.min(w, h, d) <= 0) return NaN;
  const sx = 1 / (w * 2 + 1), sy = 1 / (h * 2 + 1), sz = 1 / (d * 2 + 1);
  const ox = (1 - Math.floor(1 / sx) * sx) / 2, oz = (1 - Math.floor(1 / sz) * sz) / 2;
  const skip = new Set([centre, ...ignore].map(p => key({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })));
  const cache = new Map<string, Box[]>();
  let seen = 0, total = 0;
  for (let x = 0; x <= 1 + 1e-9; x += sx) for (let y = 0; y <= 1 + 1e-9; y += sy) for (let z = 0; z <= 1 + 1e-9; z += sz) {
    const to = { x: box.minX + w * x + ox, y: box.minY + h * y, z: box.minZ + d * z + oz };
    let blocked = false;
    // Every cell intersecting the segment's bounds, with exact slab intersection (no ray-step holes).
    for (let bx = Math.floor(Math.min(centre.x, to.x)); bx <= Math.floor(Math.max(centre.x, to.x)) && !blocked; bx++)
      for (let by = Math.floor(Math.min(centre.y, to.y)); by <= Math.floor(Math.max(centre.y, to.y)) && !blocked; by++)
        for (let bz = Math.floor(Math.min(centre.z, to.z)); bz <= Math.floor(Math.max(centre.z, to.z)) && !blocked; bz++) {
          const p = { x: bx, y: by, z: bz }, k = key(p);
          if (skip.has(k) || !intersects(centre, to, { minX: bx, minY: by, minZ: bz, maxX: bx + 1, maxY: by + 1, maxZ: bz + 1 })) continue;
          let boxes = cache.get(k);
          if (!boxes) {
            boxes = (read(p)?.shapes ?? []).filter(s => s.length === 6 && s.every(Number.isFinite)).map(s =>
              ({ minX: bx + s[0], minY: by + s[1], minZ: bz + s[2], maxX: bx + s[3], maxY: by + s[4], maxZ: bz + s[5] }));
            cache.set(k, boxes);
          }
          blocked = boxes.some(b => intersects(centre, to, b));
        }
    total++; if (!blocked) seen++;
  }
  return seen / total;
}

export const bedCentre = (p: P3): P3 => ({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 });
export const bedEyeReach = (feet: P3, cell: P3): number => Math.hypot(feet.x - cell.x - 0.5, feet.y + 1.62 - cell.y - 0.5, feet.z - cell.z - 0.5);
export const bedBodyBox = (p: P3, width = 0.6, height = 1.8): Box =>
  ({ minX: p.x - width / 2, minY: p.y, minZ: p.z - width / 2, maxX: p.x + width / 2, maxY: p.y + height, maxZ: p.z + width / 2 });

export function bedSelfEstimate(read: BedBlockReader, head: P3, foot: P3, feet: P3, dimensions: { width?: number; height?: number } = {}) {
  const box = bedBodyBox(feet, dimensions.width, dimensions.height);
  const centre = bedCentre(head), exposure = bedExposure(read, centre, box, [head, foot]);
  const distance = Math.hypot(feet.x - centre.x, feet.y - centre.y, feet.z - centre.z);
  return { distance, exposure, shielded: 1 - exposure, box, expected: bedDamage(distance, exposure), model: 'normal_before_armour' };
}

export interface DescentBedLayout { foot: P3; head: P3; stand: P3; screen: P3[]; score: number }
/** Geometry only: pillow over the OBSERVED pillar, foot/support toward a low operating point.
 * No requirement to reach the moving head or the perched strike window. At most four obsidian. */
export function descentBedLayouts(perch: P3, yaw: number, read: BedBlockReader, budget: number): DescentBedLayout[] {
  if (![...Object.values(perch), yaw, budget].every(Number.isFinite)) return [];
  const head = { x: Math.floor(perch.x), y: Math.floor(perch.y), z: Math.floor(perch.z) };
  if (!air(read(head)) || read({ ...head, y: head.y - 1 })?.name !== 'bedrock') return [];
  const out: DescentBedLayout[] = [];
  for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
    const foot = { x: head.x + dx, y: head.y, z: head.z + dz };
    if (!air(read(foot))) continue;
    // Support doubles as a blast screen. Extend its small wall sideways, never into the bed.
    const support = { ...foot, y: foot.y - 1 };
    const targets = [support, { x: support.x + dz, y: support.y, z: support.z - dx }];
    const screen = supportedBedCells(targets, read, 3);
    if (!screen || screen.length > Math.min(4, budget)) continue;
    const projected: BedBlockReader = p => screen.some(c => key(c) === key(p))
      ? { name: 'obsidian', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : read(p);
    for (let along = 2; along <= 4; along++) for (const side of [0, -1, 1]) for (let y = head.y - 1; y >= head.y - 4; y--) {
      const cell = { x: head.x + dx * along + dz * side, y, z: head.z + dz * along - dx * side };
      if (!air(projected(cell)) || !air(projected({ ...cell, y: y + 1 })) || projected({ ...cell, y: y - 1 })?.boundingBox !== 'block') continue;
      const stand = { x: cell.x + 0.5, y, z: cell.z + 0.5 };
      // Placement's facing is set by looking from stand at foot's support. Keep the cardinal direction unambiguous.
      if (Math.abs(side) >= along - 1 || [foot, head, ...screen].some(p => bedEyeReach(stand, p) > 4.5)) continue;
      if (bedSelfEstimate(projected, head, foot, stand).expected > 6) continue;
      out.push({ foot, head, stand, screen, score: 1 - (dx * Math.sin(yaw) + dz * Math.cos(yaw)) + Math.abs(side) + along * 0.1 });
    }
  }
  return out.sort((a, b) => a.score - b.score);
}

export type SeatedBedPose = { position: P3; yaw: number; phase: number | null };
export type BedCloud = { x: number; y: number; z: number; radius: number; dangerRadius?: number };
const distance = (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Keep the entire player's horizontal box outside the future radius-five flame, throughout 7+5.
 * Plan with the UNCHANGED reflex's seven-metre minimum too, so it need not eject us mid-build.
 * Existing clouds retain their observed danger radius (at least seven). Height is deliberately not
 * used to claim shelter: the next cloud's ground height is not known. Walls do not stop breath. */
export function bedOperationClear(dragon: SeatedBedPose, feet: P3, clouds: readonly BedCloud[] = []): boolean {
  const head = seatedDragonHead(dragon), box = bedBodyBox(feet);
  if (!head || !Object.values(feet).every(Number.isFinite)) return false;
  const outside = (c: P3, r: number) => Number.isFinite(r) && Math.hypot(
    Math.max(box.minX - c.x, 0, c.x - box.maxX), Math.max(box.minZ - c.z, 0, c.z - box.maxZ)) > r;
  return outside(head.cloud, 7) && clouds.every(c => outside(c, Math.max(7, c.dangerRadius ?? c.radius)))
    && (['head', 'neck'] as const).every(part => !boxesOverlap(box, inflate(partBox(dragon, part), 1.1)));
}

export interface SeatedBedLayout extends DescentBedLayout { headDistance: number; headDamage: number; selfDamage: number }
/** Local, finite geometry search around the turned head, independent of fountain coordinates/seed.
 * The foot faces FROM the operating point TOWARD the pillow, matching placeBlock's look at its
 * bottom support. Supports and an optional two-high screen share the actual obsidian budget.
 * This offers destinations; go and the unchanged reflexes still decide whether a walk is possible. */
export function seatedBedLayouts(dragon: SeatedBedPose, read: BedBlockReader, budget: number, health = 20): SeatedBedLayout[] {
  const pose = seatedDragonHead(dragon);
  if (!pose || !Number.isInteger(budget) || budget < 0 || !Number.isFinite(health)) return [];
  const found: SeatedBedLayout[] = [];
  const project = (cells: P3[]): BedBlockReader => p => cells.some(c => key(c) === key(p))
    ? { name: 'obsidian', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : read(p);
  for (let x = Math.floor(pose.feet.x) - 2; x <= Math.floor(pose.feet.x) + 2; x++)
    for (let z = Math.floor(pose.feet.z) - 2; z <= Math.floor(pose.feet.z) + 2; z++)
      for (let y = Math.floor(pose.feet.y) - 2; y <= Math.floor(pose.feet.y); y++) {
        const head = { x, y, z }, headDistance = distance(bedCentre(head), pose.feet);
        if (!air(read(head)) || headDistance > 2.2 || bedDamage(headDistance, 1) < 50) continue;
        for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
          const foot = { x: x + dx, y, z: z + dz };
          if (!air(read(foot))) continue;
          const supports = [head, foot].map(p => ({ ...p, y: y - 1 }));
          for (const along of [2, 3, 4]) for (const side of [0, -1, 1]) for (let sy = y - 1; sy >= y - 3; sy--) {
            if (Math.abs(side) >= along - 1) continue; // unambiguous cardinal placement yaw
            const stand = { x: x + dx * along + dz * side + 0.5, y: sy, z: z + dz * along - dx * side + 0.5 };
            const cell = { x: Math.floor(stand.x), y: sy, z: Math.floor(stand.z) };
            if (!air(read(cell)) || !air(read({ ...cell, y: sy + 1 })) || read({ ...cell, y: sy - 1 })?.boundingBox !== 'block'
              || !bedOperationClear(dragon, stand) || [head, foot].some(p => bedEyeReach(stand, p) > 4.5)) continue;
            const wall = [0, 1].map(h => ({ x: x + dx * 2 + dz * side, y: sy + h, z: z + dz * 2 - dx * side }));
            for (const targets of [supports, [...supports, ...wall]]) {
              const screen = supportedBedCells(targets, read, 3);
              if (!screen || screen.length > budget || screen.some(p => [head, foot].some(c => key(c) === key(p))
                || boxesOverlap(bedBodyBox(stand), { minX: p.x, minY: p.y, minZ: p.z, maxX: p.x + 1, maxY: p.y + 1, maxZ: p.z + 1 })
                || bedEyeReach(stand, p) > 4.5)) continue;
              const projected = project(screen);
              const selfDamage = bedSelfEstimate(projected, head, foot, stand).expected;
              if (!Number.isFinite(selfDamage) || selfDamage > 6 || selfDamage + 4 >= health) continue;
              const headDamage = bedDamage(headDistance, bedExposure(projected, bedCentre(head), pose.box, [head, foot]));
              if (headDamage < 50) continue;
              found.push({ head, foot, stand, screen, headDistance, headDamage, selfDamage,
                score: -headDamage + screen.length * 0.25 + Math.abs(side) * 0.1 });
            }
          }
        }
      }
  return found.sort((a, b) => a.score - b.score);
}

/** Open waiting destinations around the observed waiting anchor. Move every sixty ticks; never
 * invent a floor, wait under a roof, or repeatedly select the occupied destination. */
export function bedOpenWaitCells(anchor: P3, here: P3, read: BedBlockReader): P3[] {
  const cells: P3[] = [];
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const dy of [0, -1, 1]) {
    const cell = { x: Math.floor(anchor.x) + dx, y: Math.floor(anchor.y) + dy, z: Math.floor(anchor.z) + dz };
    const feet = { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, d = distance(here, feet);
    if (d < 2 || d > 5 || read({ ...cell, y: cell.y - 1 })?.name !== 'end_stone') continue;
    if (!Array.from({ length: 7 }, (_, h) => ({ ...cell, y: cell.y + h })).every(p => air(read(p)))) continue;
    cells.push(feet);
  }
  return cells.sort((a, b) => Math.abs(distance(here, a) - 3) - Math.abs(distance(here, b) - 3));
}
