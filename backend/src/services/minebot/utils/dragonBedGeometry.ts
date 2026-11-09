import { boxesOverlap, inflate, partBox, type Box, type P3 } from './dragonParts.js';
import { seatedDragonHead } from './dragonHeadModel.js';
import { Vec3 } from 'vec3';
import { dragonHazards } from './dragonDanger.js';
import { knockGeometry } from './endKnockRecord.js';
import { landingDragonBoxes, landingStandContacts, landingEntryDirection, landingEntryOrder, landingMiddleRing, type LandingObservation, type LandingPoint } from './dragonLandingPath.js';

type BedBlock = { name: string; boundingBox?: string; shapes?: number[][]; getProperties?: () => Record<string, unknown> } | null;
export type BedBlockReader = (p: P3) => BedBlock;
export type BedSearch<T> = Generator<void, T, void>;
/** One cooperative slice. Yield sites include every exposure ray, not just whole layouts.
 * Preparation resumes once per receipt tick; the synchronous API retains its complete result. */
export function advanceBedSearch<T>(search: BedSearch<T>, milliseconds = 2, now = () => performance.now()): IteratorResult<void, T> {
  const until = now() + Math.min(5, Math.max(0, milliseconds));
  let result: IteratorResult<void, T>;
  do { result = search.next(); } while (!result.done && now() < until);
  return result;
}
/** Shared by preparation AND all move/ready/check callbacks. Repeated calls during
 * one tick cannot multiply the budget. A firing check that cannot finish is a veto. */
export function bedTickBudget(clock: () => number, now = () => performance.now()) {
  let tick = NaN, spent = 0;
  return <T>(search: BedSearch<T>, sliceMs = 5): IteratorResult<void, T> => {
    if (tick !== clock()) { tick = clock(); spent = 0; }
    if (spent >= 5) return { done: false, value: undefined };
    const start = now();
    try { return advanceBedSearch(search, Math.min(sliceMs, 5 - spent), now); }
    finally { spent += now() - start; }
  };
}
function finishBedSearch<T>(search: BedSearch<T>): T {
  let result = search.next();
  while (!result.done) result = search.next();
  return result.value;
}
const air = (b: BedBlock) => !!b && /^(air|cave_air|void_air)$/u.test(b.name);
// Vanilla 1.21.11 data/minecraft/tags/block/replaceable.json. Placement only:
// empty collision shapes do NOT imply replaceability (torches/rails are not air).
// SnowLayerBlock.canBeReplaced for a non-snow item admits only one layer.
const replaceable = new Set(['air', 'water', 'lava', 'short_grass', 'fern', 'dead_bush', 'bush',
  'short_dry_grass', 'tall_dry_grass', 'seagrass', 'tall_seagrass', 'fire', 'soul_fire',
  'vine', 'glow_lichen', 'resin_clump', 'light', 'tall_grass', 'large_fern', 'structure_void',
  'void_air', 'cave_air', 'bubble_column', 'warped_roots', 'nether_sprouts', 'crimson_roots',
  'leaf_litter', 'hanging_roots']);
export const bedCanReplace = (b: BedBlock): boolean => !!b && (replaceable.has(b.name)
  || (b.name === 'snow' && Number(b.getProperties?.().layers) === 1));
const key = (p: P3) => `${p.x},${p.y},${p.z}`;
const faces = [[0, -1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, 1, 0]];

export const bedIsFire = (b: BedBlock): boolean => b?.name === 'fire' || b?.name === 'soul_fire';
/** The 26 neighbours of BOTH occupied body cells, including diagonals and below the feet. */
export function bedStandFires(read: BedBlockReader, stand: P3): P3[] {
  const found = new Map<string, P3>();
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 2; dy++) {
    const p = { x: Math.floor(stand.x) + dx, y: Math.floor(stand.y) + dy, z: Math.floor(stand.z) + dz };
    if (bedIsFire(read(p))) found.set(key(p), p);
  }
  return [...found.values()];
}

export type BedFireFailure = { stand: P3; fire: P3; count: number };
/** Only the explicit unsafe-fire receipt supplies a target; never parse arbitrary coordinates. */
export function bedUnsafeFire(lines: readonly string[]): P3 | null {
  for (const line of lines) {
    if (!/unsafe:.*(?:soul_)?fire/u.test(line)) continue;
    const match = /火 \((-?\d+),\s*(-?\d+),\s*(-?\d+)\) は dig/u.exec(line);
    if (match) return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
  }
  return null;
}
export function bedRecordFireFailure(history: Map<string, BedFireFailure>, stand: P3, fire: P3): BedFireFailure {
  const id = `${key(stand)}|${key(fire)}`, previous = history.get(id);
  const entry = { stand: { ...stand }, fire: { ...fire }, count: (previous?.count ?? 0) + 1 };
  history.set(id, entry); return entry;
}
export const bedFireStandExcluded = (history: Iterable<BedFireFailure>, stand: P3): boolean =>
  [...history].some(entry => entry.count >= 2 && key(entry.stand) === key(stand));

/** Order named blockers, then stand neighbours, then observed blast residue; nearest first
 * within each group. This scan offers only fire, never a solid block to dig. */
export function bedFireTargets(read: BedBlockReader, here: P3, named: readonly P3[], stands: readonly P3[], blast: P3 | null): P3[] {
  const targets = new Map<string, { p: P3; priority: number }>();
  const add = (p: P3, priority: number) => {
    if (bedIsFire(read(p)) && !targets.has(key(p))) targets.set(key(p), { p, priority });
  };
  named.forEach(p => add(p, 0));
  stands.flatMap(p => bedStandFires(read, p)).forEach(p => add(p, 1));
  if (blast) for (let dx = -6; dx <= 6; dx++) for (let dy = -6; dy <= 6; dy++) for (let dz = -6; dz <= 6; dz++) {
    const p = { x: Math.floor(blast.x) + dx, y: Math.floor(blast.y) + dy, z: Math.floor(blast.z) + dz };
    if (distance(bedCentre(p), blast) <= 6) add(p, 2);
  }
  return [...targets.values()].sort((a, b) => a.priority - b.priority || distance(here, a.p) - distance(here, b.p)).map(t => t.p);
}

/** A short cleanup walk still goes through go and its unchanged route/reflex checks. */
export function bedFireWorkCell(read: BedBlockReader, here: P3, fire: P3, safe: (p: P3) => boolean): P3 | null {
  const cells: P3[] = [];
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -2; dy <= 1; dy++) {
    const p = { x: fire.x + dx + 0.5, y: fire.y + dy, z: fire.z + dz + 0.5 };
    const cell = { x: Math.floor(p.x), y: p.y, z: Math.floor(p.z) };
    if (read({ ...cell, y: cell.y - 1 })?.boundingBox !== 'block' || !air(read(cell)) || !air(read({ ...cell, y: cell.y + 1 }))) continue;
    if (bedEyeReach(p, fire) <= 4.5 && !bedStandFires(read, p).length && safe(p)) cells.push(p);
  }
  return cells.sort((a, b) => distance(here, a) - distance(here, b))[0] ?? null;
}

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
      if (!bedCanReplace(block)) return null;
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
    const first = (box[`min${axis}`] - a[k]) / d, second = (box[`max${axis}`] - a[k]) / d;
    lo = Math.max(lo, Math.min(first, second)); hi = Math.min(hi, Math.max(first, second));
    if (lo > hi) return false;
  }
  return hi > 1e-7 && lo < 1 - 1e-7;
}

/** Vanilla's sample grid for the actual target AABB; ray tests use observed collision shapes.
 * Unknown/unloaded shapes provide no shielding. Both bed halves are removed before tracing. */
export function bedExposure(read: BedBlockReader, centre: P3, box: Box, ignore: P3[] = []): number {
  return finishBedSearch(bedExposureSearch(read, centre, box, ignore));
}
export function* bedExposureSearch(read: BedBlockReader, centre: P3, box: Box, ignore: P3[] = []): BedSearch<number> {
  const w = box.maxX - box.minX, h = box.maxY - box.minY, d = box.maxZ - box.minZ;
  if (![...Object.values(box), ...Object.values(centre)].every(Number.isFinite) || Math.min(w, h, d) <= 0) return NaN;
  const sx = 1 / (w * 2 + 1), sy = 1 / (h * 2 + 1), sz = 1 / (d * 2 + 1);
  const ox = (1 - Math.floor(1 / sx) * sx) / 2, oz = (1 - Math.floor(1 / sz) * sz) / 2;
  const skip = new Set([centre, ...ignore].map(p => key({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })));
  const cache = new Map<string, Box[]>();
  let seen = 0, total = 0;
  for (let x = 0; x <= 1 + 1e-9; x += sx) for (let y = 0; y <= 1 + 1e-9; y += sy) for (let z = 0; z <= 1 + 1e-9; z += sz) {
    yield;
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
  return finishBedSearch(bedSelfEstimateSearch(read, head, foot, feet, dimensions));
}
function* bedSelfEstimateSearch(read: BedBlockReader, head: P3, foot: P3, feet: P3, dimensions: { width?: number; height?: number } = {}) {
  const box = bedBodyBox(feet, dimensions.width, dimensions.height);
  // Cheap supports may be destroyed. Never depend on their shielding for SELF, including
  // observed columns left by an earlier blast. Dragon damage still traces their real shapes.
  const selfRead: BedBlockReader = p => { const b = read(p); return b?.name === 'cobblestone' ? { ...b, shapes: [] } : b; };
  const centre = bedCentre(head), exposure = yield* bedExposureSearch(selfRead, centre, box, [head, foot]);
  const distance = Math.hypot(feet.x - centre.x, feet.y - centre.y, feet.z - centre.z);
  return { distance, exposure, shielded: 1 - exposure, box, expected: bedDamage(distance, exposure), model: 'normal_before_armour' };
}

/** Only permanent blast-resistant collision shapes count for M2. In particular an
 * end-stone wall must not certify the second explosion. This also preserves the +1 damage. */
export function landingBedSelf(read: BedBlockReader, head: P3, foot: P3, feet: P3, dimensions: { width?: number; height?: number } = {}) {
  return finishBedSearch(landingBedSelfSearch(read, head, foot, feet, dimensions));
}
export function* landingBedSelfSearch(read: BedBlockReader, head: P3, foot: P3, feet: P3, dimensions: { width?: number; height?: number } = {}) {
  const durable: BedBlockReader = p => { const b = read(p); return b && ['obsidian', 'bedrock'].includes(b.name) ? b : { name: 'air', shapes: [] }; };
  return yield* bedSelfEstimateSearch(durable, head, foot, feet, { width: Math.max(0.6, dimensions.width ?? 0.6), height: Math.max(1.8, dimensions.height ?? 1.8) });
}

export function landingBedFireClear(read: BedBlockReader, stand: P3): boolean {
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 2; dy++) {
    const b = read({ x: Math.floor(stand.x) + dx, y: Math.floor(stand.y) + dy, z: Math.floor(stand.z) + dz });
    if (!b || bedIsFire(b)) return false;
  }
  return true;
}

export interface LandingBedLayout {
  head: P3; foot: P3; stand: P3; screen: P3[]; supports: P3[];
  headDistance: number; selfExposure: number; headDamage: number; score: number;
  region?: 'central' | 'midpoint' | 'terminal';
}

export interface LandingFountainStand {
  stand: P3; staging: P3; footing: P3[]; screen: P3[]; options: LandingBedLayout[];
}
const obsidianBlock = { name: 'obsidian', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
export const landingProjectedRead = (read: BedBlockReader, cells: readonly P3[]): BedBlockReader => {
  const built = new Set(cells.map(key));
  return p => built.has(key(p)) ? obsidianBlock : read(p);
};

/** Four column-relative stands, one metre from the column, at columnTop-3.
 * A small roof/wall attached to the column shields all bearings, before the bearing
 * is known. Only the footing and this screen are built in phase 2. */
export function* landingFountainStandSearch(target: P3, here: P3, read: BedBlockReader, budget: number, health: number,
  history: readonly LandingObservation[] = []): BedSearch<LandingFountainStand | null> {
  if (!Object.values(target).every(Number.isFinite) || !Number.isInteger(budget) || budget < 0 || !Number.isFinite(health) || health <= 5) return null;
  const ring = landingMiddleRing(target), column = { x: Math.floor(target.x), z: Math.floor(target.z) };
  const durable = (p: P3) => ['obsidian', 'bedrock'].includes(read(p)?.name ?? '');
  const bearings = [[1, 0], [0, 1], [-1, 0], [0, -1]].sort(([ax, az], [bx, bz]) =>
    Math.hypot(target.x + ax - here.x, target.z + az - here.z) - Math.hypot(target.x + bx - here.x, target.z + bz - here.z));
  for (const [dx, dz] of bearings) {
    yield;
    const stand = { x: column.x + dx + .5, y: target.y - 3, z: column.z + dz + .5 };
    if (ring.some(p => bedEyeReach(stand, p) > 4.5) || !air(read({ x: Math.floor(stand.x), y: stand.y, z: Math.floor(stand.z) }))
      || !air(read({ x: Math.floor(stand.x), y: stand.y + 1, z: Math.floor(stand.z) })) || !landingBedFireClear(read, stand)) continue;
    const below = { x: Math.floor(stand.x), y: stand.y - 1, z: Math.floor(stand.z) };
    const footing = durable(below) ? [] : supportedBedCells([below], read, 2);
    if (!footing || footing.length > 2 || (!footing.length && !durable(below)) || footing.some(p => !bedCanReplace(read(p)))) continue;
    const roof: P3[] = [];
    for (let along = -1; along <= 2; along++) for (let side = -2; side <= 2; side++) {
      // A connected twelve-cell canopy: side arms cover low-body rays from the
      // perpendicular bearings; the back cell anchors the later two-block arm.
      if (!(Math.abs(side) === 1 || (side === 0 && (along === -1 || along === 2)) || (Math.abs(side) === 2 && along === 0))) continue;
      roof.push({ x: column.x + along * dx - side * dz, y: target.y - 1, z: column.z + along * dz + side * dx });
    }
    if (roof.some(p => !durable(p) && !bedCanReplace(read(p)))) continue;
    // Anchor to the observed column, then expand one neighbour at a time.
    const remaining = roof.filter(p => !durable(p)), screen: P3[] = [];
    while (remaining.length) {
      const projected = landingProjectedRead(read, [...footing, ...screen]);
      const i = remaining.findIndex(p => bedCellSupported(projected, p));
      if (i < 0) break;
      screen.push(remaining.splice(i, 1)[0]);
    }
    if (remaining.length || footing.length + screen.length + 2 > budget) continue;
    const builtRead = landingProjectedRead(read, [...footing, ...screen]);
    const stages: P3[] = [];
    if (!footing.length) stages.push(stand);
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (let y = stand.y; y >= stand.y - 2; y--) {
      const p = { x: column.x + a + .5, y, z: column.z + b + .5 }, cell = { x: Math.floor(p.x), y, z: Math.floor(p.z) };
      if (!durable({ ...cell, y: y - 1 }) || !air(read(cell)) || !air(read({ ...cell, y: y + 1 }))
        || !landingBedFireClear(read, p) || footing.some(c => boxesOverlap(bedBodyBox(p), cellBox(c)) || bedEyeReach(p, c) > 4.5)) continue;
      stages.push(p);
    }
    const staging = stages.sort((a, b) => distance(here, a) - distance(here, b))[0];
    if (!staging || screen.some(p => bedEyeReach(stand, p) > 4.5)) continue;
    const options: LandingBedLayout[] = [];
    for (const head of ring) {
      yield;
      const self = yield* landingBedSelfSearch(builtRead, head, head, stand);
      if (self.exposure !== 0 || self.expected > 6 || self.expected + 4 >= health) continue;
      for (const [fx, fz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const foot = { x: head.x + fx, y: head.y, z: head.z + fz };
        if (distance(bedCentre(foot), target) >= distance(bedCentre(head), target) || !bedCanReplace(read(head)) || !bedCanReplace(read(foot))
          || [head, foot, { ...foot, y: foot.y - 1 }].some(p => bedEyeReach(stand, p) > 4.5)) continue;
        const supports = [head, foot].map(p => ({ ...p, y: p.y - 1 }));
        const pending = supports.filter(p => !['obsidian', 'bedrock'].includes(builtRead(p)?.name ?? ''));
        if (pending.length > 2 || pending.some(p => !bedCanReplace(builtRead(p)))) continue;
        const ordered: P3[] = [];
        for (let i = 0; i < pending.length; i++) {
          const p = pending.find(p => !ordered.some(c => key(c) === key(p)) && bedCellSupported(landingProjectedRead(builtRead, ordered), p));
          if (p) ordered.push(p);
        }
        if (ordered.length !== pending.length) continue;
        options.push({ head, foot, stand, supports: ordered, screen: [...roof, ...footing], region: 'midpoint',
          headDistance: 0, headDamage: 0, selfExposure: 0, score: 0 });
        break;
      }
    }
    // Coverage, rather than one lucky approach direction, is a phase-2 requirement.
    if (options.length === ring.length) return { stand, staging, footing, screen, options };
  }
  return yield* landingCompactStandSearch(target, here, read, budget, health, history);
}

/** A small, observed-side alternative when the all-bearing canopy does not fit.
 * Phase-2 packet history orders spatial candidates only; no future path or r253
 * timing enters the search. Entry and every burst still recheck the real path.
 * Footing, BOTH bed supports and their observed support chains share ONE budget. */
export function* landingCompactStandSearch(target: P3, here: P3, read: BedBlockReader, budget: number, health: number,
  history: readonly LandingObservation[]): BedSearch<LandingFountainStand | null> {
  if (![...Object.values(target), ...Object.values(here), health].every(Number.isFinite) || health <= 5
    || !Number.isInteger(budget) || budget < 0 || history.at(-1)?.phase !== 2) return null;
  const materials = Math.min(12, budget);
  const durable = (p: P3) => ['obsidian', 'bedrock'].includes(read(p)?.name ?? '');
  const column = { x: Math.floor(target.x), z: Math.floor(target.z) };
  const direction = landingEntryDirection(history, target)?.direction;
  if (!direction) return null;
  const heads = [-1, 0].flatMap(dy => landingEntryOrder(landingMiddleRing(target).map(p => ({ head: { ...p, y: p.y + dy } })), history, target));
  const offsets = [[-1, 0], [0, -1], [1, 0], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
  const bedAxes = [[1, 0], [0, 1], [-1, 0], [0, -1]].sort(([ax, az], [bx, bz]) =>
    Math.abs(ax * direction.x + az * direction.z) - Math.abs(bx * direction.x + bz * direction.z));
  for (const { head } of heads) for (const [fx, fz] of bedAxes) {
    yield;
    const foot = { x: head.x + fx, y: head.y, z: head.z + fz };
    if (![head, foot].every(p => bedCanReplace(read(p)))
      || [head, foot].some(p => p.x === column.x && p.z === column.z)) continue;
    const tops = [head, foot].map(p => ({ ...p, y: p.y - 1 }));
    if (tops.some(p => !durable(p) && !bedCanReplace(read(p)))) continue;
    for (const drop of [3, 4]) for (const [sx, sz] of offsets) {
      yield;
      const stand = { x: head.x + sx + .5, y: head.y - drop, z: head.z + sz + .5 };
      const cell = { x: Math.floor(stand.x), y: stand.y, z: Math.floor(stand.z) };
      if (!air(read(cell)) || !air(read({ ...cell, y: cell.y + 1 })) || !landingBedFireClear(read, stand)
        || [head, foot, tops[1]].some(p => bedEyeReach(stand, p) > 4.5)) continue;
      const below = { ...cell, y: cell.y - 1 };
      const footing = durable(below) ? [] : supportedBedCells([below], read, 2);
      if (!footing || footing.length > materials || (!footing.length && !durable(below))
        || footing.some(p => !bedCanReplace(read(p)))) continue;
      const foundation = landingProjectedRead(read, footing);
      const screen = supportedBedCells(tops, foundation, 4);
      if (!screen) continue;
      const construction = [...new Map([...footing, ...screen].map(p => [key(p), p])).values()];
      if (construction.length > materials || construction.some(p => p.x === column.x && p.z === column.z)
        || construction.some(p => [head, foot].some(b => key(b) === key(p))
          || boxesOverlap(bedBodyBox(stand), cellBox(p)) || bedEyeReach(stand, p) > 4.5)) continue;
      const built = landingProjectedRead(read, construction);
      const self = yield* landingBedSelfSearch(built, head, foot, stand);
      if (self.exposure !== 0 || !Number.isFinite(self.expected) || self.expected > 6 || self.expected + 4 >= health) continue;
      // A new floor goes in from a real neighbouring durable floor. Never assume
      // an arrival route, support in unread cells, or permission to dig end stone.
      const stages: P3[] = [];
      if (!footing.length) stages.push(stand);
      else for (let x = cell.x - 2; x <= cell.x + 2; x++) for (let z = cell.z - 2; z <= cell.z + 2; z++) for (let y = stand.y; y >= stand.y - 2; y--) {
        yield;
        const p = { x: x + .5, y, z: z + .5 }, at = { x, y, z };
        if (!durable({ ...at, y: y - 1 }) || !air(read(at)) || !air(read({ ...at, y: y + 1 })) || !landingBedFireClear(read, p)
          || footing.some(c => boxesOverlap(bedBodyBox(p), cellBox(c)) || bedEyeReach(p, c) > 4.5)) continue;
        stages.push(p);
      }
      const staging = stages.sort((a, b) => distance(a, here) - distance(b, here))[0];
      if (!staging) continue;
      const layout: LandingBedLayout = { head, foot, stand, supports: tops,
        screen: [...new Map([...construction, below].map(p => [key(p), p])).values()], region: 'midpoint',
        selfExposure: self.exposure, headDistance: 0, headDamage: 0, score: distance(stand, here) + construction.length * .05 };
      // All supports are included in phase-2 construction; entry never reserves
      // a hidden second material budget for this compact option.
      const plan = { stand, staging, footing, screen: screen.filter(p => !footing.some(f => key(f) === key(p))), options: [layout] };
      yield* appendCompactHeightOption(plan, target, read, materials, health);
      return plan;
    }
  }
  return null;
}

/** Keep the first compact side/stand and its shared construction unchanged. The
 * other existing height is an optional, separately built blueprint, never a firing
 * authorization or an automatic height change. Its supports may occupy the lower
 * bed cells, so they must NOT enter the shared screen or the first option. */
function* appendCompactHeightOption(plan: LandingFountainStand, target: P3, read: BedBlockReader,
  materials: number, health: number): BedSearch<void> {
  const first = plan.options[0], stand = plan.stand;
  const y = first.head.y === target.y - 1 ? target.y : target.y - 1;
  // Preserve the original two heights AND stand drops; do not add a drop5.
  if (![target.y - 1, target.y].includes(first.head.y) || ![3, 4].includes(y - stand.y)) return;
  const head = { ...first.head, y }, foot = { ...first.foot, y };
  yield;
  if (![head, foot].every(p => bedCanReplace(read(p)))
    || [head, foot, { ...foot, y: y - 1 }].some(p => bedEyeReach(stand, p) > 4.5)) return;
  const base = [...plan.footing, ...plan.screen], projected = landingProjectedRead(read, base);
  const tops = [head, foot].map(p => ({ ...p, y: p.y - 1 }));
  if (tops.some(p => !['obsidian', 'bedrock'].includes(projected(p)?.name ?? '') && !bedCanReplace(projected(p)))) return;
  const extra = supportedBedCells(tops, projected, 4);
  if (!extra) return;
  const construction = [...new Map([...base, ...extra].map(p => [key(p), p])).values()];
  if (construction.length > materials || construction.some(p => p.x === Math.floor(target.x) && p.z === Math.floor(target.z))
    || construction.some(p => [head, foot].some(b => key(b) === key(p))
      || boxesOverlap(bedBodyBox(stand), cellBox(p)) || bedEyeReach(stand, p) > 4.5)) return;
  const self = yield* landingBedSelfSearch(landingProjectedRead(read, construction), head, foot, stand);
  if (self.exposure !== 0 || !Number.isFinite(self.expected) || self.expected > 6 || self.expected + 4 >= health) return;
  plan.options.push({ ...first, head, foot, supports: [...new Map([...extra, ...tops].map(p => [key(p), p])).values()],
    screen: [...first.screen], selfExposure: self.exposure });
}

/** One bounded search at entry, checking at most twenty ring cells. Unfinished work
 * is a veto, never resumed with a later direction. Use projected 1..2 supports only. */
export function* landingEntryPillowSearch(plan: LandingFountainStand, history: readonly LandingObservation[], target: P3,
  path: readonly LandingPoint[], read: BedBlockReader, health: number,
  dimensions: { width?: number; height?: number; position?: P3 } = {}, materials = 2): BedSearch<LandingBedLayout | null> {
  const feet = dimensions.position ?? plan.stand;
  if (distance(feet, plan.stand) > 1) return null;
  for (const c of landingEntryOrder(plan.options, history, target)) {
    yield;
    const pending = c.supports.filter(p => !['obsidian', 'bedrock'].includes(read(p)?.name ?? ''));
    if (pending.length > materials || pending.some(p => !bedCanReplace(read(p)))) continue;
    if (pending.some((p, i) => !bedCellSupported(landingProjectedRead(read, pending.slice(0, i)), p))) continue;
    const projected = landingProjectedRead(read, c.supports);
    if (!(yield* landingBedRefusalSearch(c, feet, path, projected, health, .5, dimensions))) return c;
  }
  return null;
}

/** Scene-only destination guard. A durable reflex can still enter a crater on its
 * own; rejecting the destination cannot change that reflex's controls. */
export function bedWaitGroundSafe(read: BedBlockReader, feet: P3, blasts: readonly P3[] = []): boolean {
  if (!Object.values(feet).every(Number.isFinite) || blasts.some(p => Math.hypot(p.x - feet.x, p.z - feet.z) <= 3)) return false;
  const y = Math.floor(feet.y);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const x = Math.floor(feet.x) + dx, z = Math.floor(feet.z) + dz;
    // Same-level full floor, open above: rejects both a pit bottom and a ledge.
    const floor = read({ x, y: y - 1, z });
    if (floor?.boundingBox !== 'block' || !floor.shapes?.some(s => s.length === 6 && s.every((v, i) => v === (i < 3 ? 0 : 1)))
      || !air(read({ x, y, z }))) return false;
  }
  return true;
}

/** The full 45-ray, reach, fire, durable footing and flight-box checks are also run at dispatch,
 * at the actor's REAL position. A nominal stand tolerance alone cannot prove zero exposure. */
export function landingBedRefusal(layout: LandingBedLayout, feet: P3, path: readonly LandingPoint[], read: BedBlockReader,
  health: number, error = 0.5, dimensions: { width?: number; height?: number } = {}): string | null {
  return finishBedSearch(landingBedRefusalSearch(layout, feet, path, read, health, error, dimensions));
}
export function* landingBedRefusalSearch(layout: LandingBedLayout, feet: P3, path: readonly LandingPoint[], read: BedBlockReader,
  health: number, error = 0.5, dimensions: { width?: number; height?: number } = {}, diagnostic?: { self?: ReturnType<typeof landingBedSelf> }): BedSearch<string | null> {
  if (!Number.isFinite(health) || !Object.values(feet).every(Number.isFinite)) return 'landing_estimate_unknown';
  if (!path.length || !Number.isFinite(error) || error < 0) return 'landing_prediction_missing';
  if ([layout.head, layout.foot].some(p => !bedCanReplace(read(p)))) return 'landing_bed_cells_not_replaceable';
  if ([layout.head, layout.foot].some(p => bedEyeReach(feet, p) > 4.5)
    || bedEyeReach(feet, { ...layout.foot, y: layout.foot.y - 1 }) > 4.5) return 'landing_out_of_reach';
  const cell = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) };
  if (!air(read(cell)) || !air(read({ ...cell, y: cell.y + 1 }))) return 'landing_stand_not_open';
  if (!['bedrock', 'obsidian'].includes(read({ ...cell, y: cell.y - 1 })?.name ?? '')) return 'landing_footing_not_durable';
  if (!landingBedFireClear(read, feet)) return 'landing_fire_or_unloaded_neighbour';
  if ([...layout.supports, ...layout.screen].some(p => !['obsidian', 'bedrock'].includes(read(p)?.name ?? ''))) return 'landing_shield_missing';
  const body = bedBodyBox(feet, Math.max(0.6, dimensions.width ?? 0.6), Math.max(1.8, dimensions.height ?? 1.8));
  if (landingStandContacts(path, body, error).some(c => c.blocking)) return 'landing_stand_in_dragon';
  // Include new/existing supports: an arm intersecting a part is not an admissible layout.
  const occupied = [layout.head, layout.foot, ...layout.supports, ...layout.screen].map(p => cellBox(p));
  if (path.some(p => landingDragonBoxes(p).slice(0, 3).some((box, i) => occupied.some(cell => boxesOverlap(cell, i < 2 ? inflate(box, -1.1) : box))))) return 'landing_build_in_dragon';
  const self = yield* landingBedSelfSearch(read, layout.head, layout.foot, feet, dimensions);
  const refusal = !Number.isFinite(self.expected) || self.expected > 6 || self.expected + 4 >= health ? 'self_damage'
    : self.exposure !== 0 ? 'landing_exposure_not_zero' : null;
  // Reuse the completed result, after deciding. No additional ray, yield or budget call; a diagnostic sink cannot alter the refusal.
  try { if (diagnostic) diagnostic.self = self; } catch { /* diagnostic only */ }
  return refusal;
}

/** Bounded, translation-invariant search in the observed fountain. The spatial corridor is
 * a phase-2 preparation hypothesis; observed heads and near forecasts authorize bursts. All new
 * supports AND screens are obsidian; never add a block to the central heightmap column.
 * Return a row of pillows sharing a stand/build, so repeats require no walking/construction. */
export function landingBedLayouts(target: P3, corridor: readonly LandingPoint[], read: BedBlockReader,
  budget: number, health = 20, endHead?: P3): LandingBedLayout[] {
  return finishBedSearch(landingBedLayoutSearch(target, corridor, read, budget, health, endHead));
}
export function* landingBedLayoutSearch(target: P3, corridor: readonly LandingPoint[], read: BedBlockReader,
  budget: number, health = 20, endHead?: P3): BedSearch<LandingBedLayout[]> {
  if (!corridor.length || !Object.values(target).every(Number.isFinite) || !Number.isInteger(budget) || budget < 0) return [];
  const durable = (p: P3) => ['bedrock', 'obsidian'].includes(read(p)?.name ?? '');
  const pillows = new Map<string, P3>();
  for (const p of corridor) for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) for (const dy of endHead ? [-1, 0] : [-1]) {
    yield;
    const head = { x: Math.floor(p.head.x) + dx, y: Math.floor(p.head.y) + dy, z: Math.floor(p.head.z) + dz };
    if (Math.hypot(head.x + 0.5 - target.x, head.z + 0.5 - target.z) <= (endHead ? 8 : 4)
      && head.y >= target.y - (endHead ? 1 : 0) && head.y <= target.y + 3 && bedCanReplace(read(head))) pillows.set(key(head), head);
  }
  const found: LandingBedLayout[] = [];
  const limit = endHead ? 16 : 48;
  const region = (head: P3): NonNullable<LandingBedLayout['region']> => {
    if (!endHead) return 'central';
    const along = ((head.x + 0.5 - target.x) * (endHead.x - target.x) + (head.z + 0.5 - target.z) * (endHead.z - target.z)) / 6.5;
    return along > 4.875 ? 'terminal' : along > 1.625 ? 'midpoint' : 'central';
  };
  // Reserve capacity for every region: central candidates must not exhaust the cap
  // before the terminal pillows are even inspected. Safety conditions are identical.
  for (const head of [...pillows.values()].sort((a, b) => distance(bedCentre(a), target) - distance(bedCentre(b), target))) {
    yield;
    const family = region(head);
    if (found.filter(c => c.region === family).length >= limit) continue;
    const near = corridor.filter(p => distance(p.head, bedCentre(head)) <= 2);
    if (!near.length) continue;
    orientations: for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
      const foot = { x: head.x + dx, y: head.y, z: head.z + dz };
      if (!bedCanReplace(read(foot))) continue;
      const supports = [head, foot].map(p => ({ ...p, y: p.y - 1 }));
      for (const along of [1, 2, 3]) for (const side of [-1, 0, 1]) for (let y = Math.floor(target.y) - 4; y < target.y; y++) {
        yield;
        // The family cap used to be checked only after all safety/exposure work.
        if (found.filter(c => c.region === family).length >= limit) break orientations;
        const stand = { x: head.x + dx * along + dz * side + 0.5, y, z: head.z + dz * along - dx * side + 0.5 };
        const cell = { x: Math.floor(stand.x), y, z: Math.floor(stand.z) };
        if (Math.hypot(stand.x - target.x, stand.z - target.z) > (endHead ? 8 : 4) || !durable({ ...cell, y: y - 1 })
          || !air(read(cell)) || !air(read({ ...cell, y: y + 1 })) || bedStandFires(read, stand).length
          || [head, foot, supports[1]].some(p => bedEyeReach(stand, p) > 4.5)) continue;
        for (const wall of [[], bedWallCells(head, stand, y, y + 2, 1), bedWallCells(head, stand, y, y + 2, 3)]) {
          const targets = [...supports, ...wall];
          // No excavating end stone to replace it, no hypothetical shield from fragile solids.
          if (targets.some(p => !bedCanReplace(read(p)) && !durable(p))) continue;
          const screen = supportedBedCells(targets, read, 4);
          if (!screen || screen.length > budget || screen.some(p => p.x === Math.floor(target.x) && p.z === Math.floor(target.z))
            || screen.some(p => bedEyeReach(stand, p) > 4.5 || [head, foot].some(b => key(b) === key(p)) || boxesOverlap(bedBodyBox(stand), cellBox(p)))) continue;
          const projected: BedBlockReader = p => screen.some(c => key(c) === key(p))
            ? { name: 'obsidian', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : read(p);
          const candidate = { head, foot, stand, supports, screen, selfExposure: 0, headDistance: 0, headDamage: 0, score: 0 };
          if (yield* landingBedRefusalSearch(candidate, stand, near, projected, health)) continue;
          let best = { distance: Infinity, damage: -Infinity };
          for (const p of near) {
            const d = distance(p.head, bedCentre(head));
            const damage = bedDamage(d, yield* bedExposureSearch(projected, bedCentre(head), p.headBox, [head, foot]));
            if (damage > best.damage) best = { distance: d, damage };
          }
          if (best.damage < 50.75) continue;
          if (found.filter(c => c.region === family).length >= limit) break;
          found.push({ ...candidate, region: family, headDistance: best.distance, headDamage: best.damage, score: best.distance + screen.length * 0.05 });
          break;
        }
      }
    }
  }
  return found.sort((a, b) => a.score - b.score);
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
const cellBox = (p: P3): Box => ({ minX: p.x, minY: p.y, minZ: p.z, maxX: p.x + 1, maxY: p.y + 1, maxZ: p.z + 1 });
const dragonPlacementBoxes = (dragon: SeatedBedPose): Box[] => {
  const pose = seatedDragonHead(dragon);
  return pose ? [pose.box, partBox(dragon, 'neck'), partBox(dragon, 'body')].map(box => inflate(box, 0.15)) : [];
};
/** Full placement voxel, with 0.15 m round the observed seated parts. Unknown pose fails closed. */
export function bedCellInDragon(dragon: SeatedBedPose, cell: P3): boolean {
  const boxes = dragonPlacementBoxes(dragon);
  return !boxes.length || boxes.some(box => boxesOverlap(cellBox(cell), box));
}
export function bedLayoutDragonRefusal(dragon: SeatedBedPose, layout: Pick<SeatedBedLayout, 'head' | 'foot' | 'screen' | 'supportBlocks'>): string | null {
  if (bedCellInDragon(dragon, layout.head)) return 'head_in_dragon';
  if (bedCellInDragon(dragon, layout.foot)) return 'foot_in_dragon';
  const supports = [layout.head, layout.foot].map(p => ({ ...p, y: p.y - 1 }));
  if ([...supports, ...layout.supportBlocks].some(p => bedCellInDragon(dragon, p))) return 'support_in_dragon';
  if (layout.screen.some(p => bedCellInDragon(dragon, p))) return 'screen_in_dragon';
  return null;
}

/** Pose-only searches adapt their supplied observation to the existing reflex reader. Live callers
 * pass their real bot, preserving clouds, fireball landings and phase clocks. No danger formula here. */
function seatedDangerReader(dragon: SeatedBedPose, read: BedBlockReader) {
  const position = new Vec3(dragon.position.x, dragon.position.y, dragon.position.z);
  return { game: { dimension: 'the_end' }, entity: { position },
    entities: { 1: { id: 1, name: 'ender_dragon', position, yaw: dragon.yaw, metadata: { 16: dragon.phase } } },
    blockAt: (p: P3) => read(p) };
}

/** Keep the entire player's horizontal box outside the future radius-five flame, throughout 7+5.
 * Plan with the UNCHANGED reflex's seven-metre minimum too, so it need not eject us mid-build.
 * Existing clouds retain their observed danger radius (at least seven). Height is deliberately not
 * used to claim shelter: the next cloud's ground height is not known. Walls do not stop breath. */
export function bedOperationClear(dragon: SeatedBedPose, feet: P3, clouds: readonly BedCloud[] = []): boolean {
  return bedOperationHazards(dragon, feet, clouds).length === 0;
}
/** Explain the existing veto with exactly the same radii/boxes. Wing overlaps are
 * reported separately by the caller: the seated reflex does not veto them. */
export function bedOperationHazards(dragon: SeatedBedPose, feet: P3, clouds: readonly BedCloud[] = []): string[] {
  const head = seatedDragonHead(dragon), box = bedBodyBox(feet);
  if (!head || !Object.values(feet).every(Number.isFinite)) return ['pose_unknown'];
  const outside = (c: P3, r: number) => Number.isFinite(r) && Math.hypot(
    Math.max(box.minX - c.x, 0, c.x - box.maxX), Math.max(box.minZ - c.z, 0, c.z - box.maxZ)) > r;
  const hazards: string[] = [];
  if (!outside(head.cloud, 7)) hazards.push('breath_forecast');
  if (!clouds.every(c => outside(c, Math.max(7, c.dangerRadius ?? c.radius)))) hazards.push('breath');
  for (const part of ['head', 'neck'] as const) if (boxesOverlap(box, inflate(partBox(dragon, part), 1.1))) hazards.push(part);
  return hazards;
}

export function bedApproachGate(input: { now: number; startTick: number; windowOpen: boolean; samePerch: boolean; clearHazards: readonly string[] }) {
  const tickLimitExceeded = input.now - input.startTick >= 100;
  const clearNowFalse = input.clearHazards.length > 0;
  const causes = [!input.samePerch ? 'perch_changed' : null, !input.windowOpen ? 'window_closed' : null,
    tickLimitExceeded ? 'approach_tick_limit' : null, clearNowFalse ? 'clear_now_false' : null].filter((s): s is string => s !== null);
  return { allowed: causes.length === 0, elapsedTicks: input.now - input.startTick, remainingApproachTicks: Math.max(0, 100 - (input.now - input.startTick)),
    tickLimitExceeded, clearNowFalse, clearHazards: [...input.clearHazards], causes };
}

/** Nominal walking time plus the existing observation delay and four ticks of margin.
 * It is a retry admission estimate, never permission to extend the 100-tick deadline. */
export const bedApproachRetryTicks = (here: P3, stand: P3): number => Math.ceil(distance(here, stand) / 4.317 * 20) + 8;
export function bedNextLayout(candidates: readonly SeatedBedLayout[], here: P3, excluded: ReadonlySet<string>,
  clear: (stand: P3) => boolean, pending: { foot: P3; head: P3 } | null = null): SeatedBedLayout | null {
  return candidates.filter(l => !excluded.has(key(l.stand)) && clear(l.stand)
    && (!pending || (key(l.foot) === key(pending.foot) && key(l.head) === key(pending.head))))
    .sort((a, b) => b.headDamage - a.headDamage || a.screen.length - b.screen.length || a.supportBlocks.length - b.supportBlocks.length
      || distance(a.stand, here) - distance(b.stand, here))[0] ?? null;
}

export interface SeatedBedLayout extends DescentBedLayout { supportBlocks: P3[]; headDistance: number; headDamage: number; selfDamage: number; fireToClear?: P3[] }
/** Local, finite geometry search around the turned head, independent of fountain coordinates/seed.
 * The foot faces FROM the operating point TOWARD the pillow, matching placeBlock's look at its
 * bottom support. Columns use cobblestone; only the optional two-high screen uses obsidian.
 * This offers destinations; go and the unchanged reflexes still decide whether a walk is possible. */
export function seatedBedLayouts(dragon: SeatedBedPose, read: BedBlockReader, budget: number, cobblestoneBudget: number, health = 20, diag?: Record<string, number>, reflexBot?: any, standHints?: P3[],
  damageRange = { min: 50, max: Infinity, distance: 2.2 }): SeatedBedLayout[] {
  if (!Number.isFinite(damageRange.min) || damageRange.min < 0 || !(damageRange.max >= damageRange.min)
    || !Number.isFinite(damageRange.distance) || damageRange.distance <= 0) return [];
  // Counts are a search tree, not a Cartesian product: every visited node is rejected,
  // expanded into the next stage, or accepted. Thus candidates = rejected + expanded + accepted.
  const add = (name: string) => { if (diag) diag[name] = (diag[name] ?? 0) + 1; };
  const visit = (stage: string) => { add('candidates'); add(`${stage}_candidates`); };
  const pass = (stage: string) => { add('expanded'); add(`${stage}_passed`); };
  const reject = (reason: string) => { add('rejected'); add(reason); };
  if (diag) for (const name of ['candidates', 'rejected', 'expanded', 'accepted', 'head_candidates', 'head_passed',
    'foot_candidates', 'foot_passed', 'stand_candidates', 'stand_passed', 'screen_candidates', 'head_not_air', 'head_far_or_weak',
    'foot_not_air', 'stand_not_open', 'stand_no_floor', 'stand_not_clear', 'stand_out_of_reach', 'screen_unsupported',
    'screen_over_budget', 'support_over_budget', 'screen_conflict', 'screen_out_of_reach', 'self_damage_too_high', 'head_damage_low',
    'head_in_dragon', 'foot_in_dragon', 'support_in_dragon', 'screen_in_dragon', 'stand_in_reflex_zone', 'stand_next_to_fire']) diag[name] ??= 0;
  const pose = seatedDragonHead(dragon);
  if (!pose || !Number.isInteger(budget) || budget < 0 || !Number.isInteger(cobblestoneBudget) || cobblestoneBudget < 0 || !Number.isFinite(health)) { add('invalid_input'); return []; }
  const found: SeatedBedLayout[] = [];
  const boxes = dragonPlacementBoxes(dragon), inDragon = (cell: P3) => boxes.some(box => boxesOverlap(cellBox(cell), box));
  const dangerBot = reflexBot ?? seatedDangerReader(dragon, read);
  const standDanger = new Map<string, boolean>();
  // Placement cells may be planned after extinguishing fire. Standing cells always use
  // the real reader, and live callers must confirm these fires gone BEFORE any placement.
  const buildRead: BedBlockReader = p => bedIsFire(read(p)) ? { name: 'air', boundingBox: 'empty', shapes: [] } : read(p);
  const project = (supportBlocks: P3[], screen: P3[]): BedBlockReader => p => {
    const name = screen.some(c => key(c) === key(p)) ? 'obsidian' : supportBlocks.some(c => key(c) === key(p)) ? 'cobblestone' : null;
    return name ? { name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : read(p);
  };
  for (let x = Math.floor(pose.feet.x) - 2; x <= Math.floor(pose.feet.x) + 2; x++)
    for (let z = Math.floor(pose.feet.z) - 2; z <= Math.floor(pose.feet.z) + 2; z++)
      for (let y = Math.floor(pose.feet.y) - 2; y <= Math.floor(pose.feet.y) + 2; y++) {
        visit('head');
        const head = { x, y, z }, headDistance = distance(bedCentre(head), pose.feet);
        if (!air(buildRead(head))) { reject('head_not_air'); continue; }
        if (inDragon(head)) { reject('head_in_dragon'); continue; }
        if (headDistance > damageRange.distance || bedDamage(headDistance, 1) < damageRange.min) { reject('head_far_or_weak'); continue; }
        pass('head');
        for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
          visit('foot');
          const foot = { x: x + dx, y, z: z + dz };
          if (!air(buildRead(foot))) { reject('foot_not_air'); continue; }
          if (inDragon(foot)) { reject('foot_in_dragon'); continue; }
          pass('foot');
          const supports = [head, foot].map(p => ({ ...p, y: y - 1 }));
          // Cover the integer cells within eye reach, including shelves level with/above the
          // pillow and deeper footing. Exact reach below rejects the unused bounding cells.
          for (const along of [2, 3, 4]) for (let side = 2 - along; side <= along - 2; side++) for (let sy = y + 2; sy >= y - 5; sy--) {
            visit('stand'); // |side| < along - 1: unambiguous cardinal placement yaw
            const stand = { x: x + dx * along + dz * side + 0.5, y: sy, z: z + dz * along - dx * side + 0.5 };
            const cell = { x: Math.floor(stand.x), y: sy, z: Math.floor(stand.z) };
            if (!air(read(cell)) || !air(read({ ...cell, y: sy + 1 }))) { reject('stand_not_open'); continue; }
            if (read({ ...cell, y: sy - 1 })?.boundingBox !== 'block') { reject('stand_no_floor'); continue; }
            standHints?.push(stand);
            if (bedStandFires(read, stand).length) { reject('stand_next_to_fire'); continue; }
            const standKey = key(stand);
            if (!standDanger.has(standKey)) standDanger.set(standKey, dragonHazards(dangerBot, { along: [stand] }).length > 0);
            if (standDanger.get(standKey)) { reject('stand_in_reflex_zone'); continue; }
            if (!bedOperationClear(dragon, stand)) { reject('stand_not_clear'); continue; }
            if ([head, foot].some(p => bedEyeReach(stand, p) > 4.5)) { reject('stand_out_of_reach'); continue; }
            pass('stand');
            const wall = [0, 1].map(h => ({ x: x + dx * 2 + dz * side, y: sy + h, z: z + dz * 2 - dx * side }));
            for (const walls of [[], wall]) {
              visit('screen');
              const cells = supportedBedCells([...supports, ...walls], buildRead, 3);
              if (!cells) { reject('screen_unsupported'); continue; }
              // Only the explicitly requested wall voxels are blast-resistant. Any foundations
              // needed below them are cheap support too. Existing solids consume neither budget.
              const wallKeys = new Set(walls.map(key));
              const screen = cells.filter(p => wallKeys.has(key(p))), supportBlocks = cells.filter(p => !wallKeys.has(key(p)));
              if ([...supports, ...supportBlocks].some(inDragon)) { reject('support_in_dragon'); continue; }
              if (screen.some(inDragon)) { reject('screen_in_dragon'); continue; }
              if (screen.length > budget) {
                reject('screen_over_budget'); add(`screen_over_budget_required_${screen.length}`);
                if (diag) {
                  diag.screen_over_budget_required_min = Math.min(diag.screen_over_budget_required_min ?? Infinity, screen.length);
                  diag.screen_over_budget_required_max = Math.max(diag.screen_over_budget_required_max ?? 0, screen.length);
                }
                continue;
              }
              if (supportBlocks.length > cobblestoneBudget) { reject('support_over_budget'); continue; }
              if (cells.some(p => [head, foot].some(c => key(c) === key(p))
                || boxesOverlap(bedBodyBox(stand), { minX: p.x, minY: p.y, minZ: p.z, maxX: p.x + 1, maxY: p.y + 1, maxZ: p.z + 1 }))) { reject('screen_conflict'); continue; }
              if (cells.some(p => bedEyeReach(stand, p) > 4.5)) { reject('screen_out_of_reach'); continue; }
              const projected = project(supportBlocks, screen);
              const selfDamage = bedSelfEstimate(projected, head, foot, stand).expected;
              if (!Number.isFinite(selfDamage) || selfDamage > 6 || selfDamage + 4 >= health) { reject('self_damage_too_high'); continue; }
              const headDamage = bedDamage(headDistance, bedExposure(projected, bedCentre(head), pose.box, [head, foot]));
              if (!Number.isFinite(headDamage) || headDamage < damageRange.min || headDamage > damageRange.max) { reject('head_damage_low'); continue; }
              add('accepted');
              found.push({ head, foot, stand, supportBlocks, screen, headDistance, headDamage, selfDamage,
                fireToClear: [head, foot, ...cells].filter(p => bedIsFire(read(p))),
                score: -headDamage + screen.length * 0.25 + supportBlocks.length * 0.01 + Math.abs(side) * 0.1 });
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

/** r212/r214 pushBox overlaps reached 8–11 m from the body; r220 died at takeoff
 * after a five-second go stopped short. Keep 3 m beyond that observed reach.
 * Horizontal distance prevents a launch's height from counting as an evacuation. */
export const BED_LEAVE_DISTANCE = 14;
export function bedLeaveState(dragon: SeatedBedPose, feet: P3, current: SeatedBedPose | null = null) {
  const bodyDistance = Math.hypot(feet.x - dragon.position.x, feet.z - dragon.position.z);
  // Reuse the recorder's exact pushBox (partBox -> inflate(4,2,4) -> shift(0,-2,0)).
  // dragonHazards intentionally omits wings; neither its reflex nor its thresholds change.
  const poses = current ? [dragon, current] : [dragon];
  const wingPushOverlap = poses.some(pose => knockGeometry(feet, pose).parts.some(part => part.pushOverlap));
  return { bodyDistance, wingPushOverlap, safe: Number.isFinite(bodyDistance) && bodyDistance >= BED_LEAVE_DISTANCE && !wingPushOverlap };
}

/** Destinations only: go/reflexes retain ownership of the route. Enumerate near the
 * anchor, even when the actor is still beside the dragon, and prefer the farthest
 * observed open floor outside clouds and BOTH the seated/current wing push boxes. */
export function bedLeaveCell(dragon: SeatedBedPose, anchors: readonly P3[], here: P3, read: BedBlockReader,
  clouds: readonly BedCloud[] = [], reflexBot?: any, current: SeatedBedPose | null = null): P3 | null {
  const dangerBot = reflexBot ?? seatedDangerReader(dragon, read);
  return anchors.flatMap(anchor => [anchor, ...bedOpenWaitCells(anchor, anchor, read)]).filter(feet => {
    const cell = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) };
    return read({ ...cell, y: cell.y - 1 })?.name === 'end_stone'
      && Array.from({ length: 7 }, (_, h) => air(read({ ...cell, y: cell.y + h }))).every(Boolean)
      && bedLeaveState(dragon, feet, current).safe
      && !clouds.some(c => Math.hypot(c.x - feet.x, c.z - feet.z) <= Math.max(7, c.dangerRadius ?? c.radius) + 0.5)
      && dragonHazards(dangerBot, { along: [feet] }).length === 0;
  }).sort((a, b) => bedLeaveState(dragon, b).bodyDistance - bedLeaveState(dragon, a).bodyDistance
    || distance(here, a) - distance(here, b))[0] ?? null;
}

/** Allow slower routes/interruptions without the former five-second cutoff; all
 * values are inside go's 5..120 s contract. A failed receipt never proves distance. */
export const bedLeaveSeconds = (here: P3, to: P3): number => Math.min(20, Math.max(10, Math.ceil(distance(here, to) / 2) + 5));
