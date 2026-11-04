import { boxesOverlap, inflate, partBox, type Box, type P3 } from './dragonParts.js';
import { seatedDragonHead } from './dragonHeadModel.js';
import { Vec3 } from 'vec3';
import { dragonHazards } from './dragonDanger.js';
import { knockGeometry } from './endKnockRecord.js';

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
  // Cheap supports may be destroyed. Never depend on their shielding for SELF, including
  // observed columns left by an earlier blast. Dragon damage still traces their real shapes.
  const selfRead: BedBlockReader = p => { const b = read(p); return b?.name === 'cobblestone' ? { ...b, shapes: [] } : b; };
  const centre = bedCentre(head), exposure = bedExposure(selfRead, centre, box, [head, foot]);
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
  const head = seatedDragonHead(dragon), box = bedBodyBox(feet);
  if (!head || !Object.values(feet).every(Number.isFinite)) return false;
  const outside = (c: P3, r: number) => Number.isFinite(r) && Math.hypot(
    Math.max(box.minX - c.x, 0, c.x - box.maxX), Math.max(box.minZ - c.z, 0, c.z - box.maxZ)) > r;
  return outside(head.cloud, 7) && clouds.every(c => outside(c, Math.max(7, c.dangerRadius ?? c.radius)))
    && (['head', 'neck'] as const).every(part => !boxesOverlap(box, inflate(partBox(dragon, part), 1.1)));
}

export interface SeatedBedLayout extends DescentBedLayout { supportBlocks: P3[]; headDistance: number; headDamage: number; selfDamage: number }
/** Local, finite geometry search around the turned head, independent of fountain coordinates/seed.
 * The foot faces FROM the operating point TOWARD the pillow, matching placeBlock's look at its
 * bottom support. Columns use cobblestone; only the optional two-high screen uses obsidian.
 * This offers destinations; go and the unchanged reflexes still decide whether a walk is possible. */
export function seatedBedLayouts(dragon: SeatedBedPose, read: BedBlockReader, budget: number, cobblestoneBudget: number, health = 20, diag?: Record<string, number>, reflexBot?: any): SeatedBedLayout[] {
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
    'head_in_dragon', 'foot_in_dragon', 'support_in_dragon', 'screen_in_dragon', 'stand_in_reflex_zone']) diag[name] ??= 0;
  const pose = seatedDragonHead(dragon);
  if (!pose || !Number.isInteger(budget) || budget < 0 || !Number.isInteger(cobblestoneBudget) || cobblestoneBudget < 0 || !Number.isFinite(health)) { add('invalid_input'); return []; }
  const found: SeatedBedLayout[] = [];
  const boxes = dragonPlacementBoxes(dragon), inDragon = (cell: P3) => boxes.some(box => boxesOverlap(cellBox(cell), box));
  const dangerBot = reflexBot ?? seatedDangerReader(dragon, read);
  const standDanger = new Map<string, boolean>();
  const project = (supportBlocks: P3[], screen: P3[]): BedBlockReader => p => {
    const name = screen.some(c => key(c) === key(p)) ? 'obsidian' : supportBlocks.some(c => key(c) === key(p)) ? 'cobblestone' : null;
    return name ? { name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : read(p);
  };
  for (let x = Math.floor(pose.feet.x) - 2; x <= Math.floor(pose.feet.x) + 2; x++)
    for (let z = Math.floor(pose.feet.z) - 2; z <= Math.floor(pose.feet.z) + 2; z++)
      for (let y = Math.floor(pose.feet.y) - 2; y <= Math.floor(pose.feet.y) + 2; y++) {
        visit('head');
        const head = { x, y, z }, headDistance = distance(bedCentre(head), pose.feet);
        if (!air(read(head))) { reject('head_not_air'); continue; }
        if (inDragon(head)) { reject('head_in_dragon'); continue; }
        if (headDistance > 2.2 || bedDamage(headDistance, 1) < 50) { reject('head_far_or_weak'); continue; }
        pass('head');
        for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
          visit('foot');
          const foot = { x: x + dx, y, z: z + dz };
          if (!air(read(foot))) { reject('foot_not_air'); continue; }
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
            const standKey = key(stand);
            if (!standDanger.has(standKey)) standDanger.set(standKey, dragonHazards(dangerBot, { along: [stand] }).length > 0);
            if (standDanger.get(standKey)) { reject('stand_in_reflex_zone'); continue; }
            if (!bedOperationClear(dragon, stand)) { reject('stand_not_clear'); continue; }
            if ([head, foot].some(p => bedEyeReach(stand, p) > 4.5)) { reject('stand_out_of_reach'); continue; }
            pass('stand');
            const wall = [0, 1].map(h => ({ x: x + dx * 2 + dz * side, y: sy + h, z: z + dz * 2 - dx * side }));
            for (const walls of [[], wall]) {
              visit('screen');
              const cells = supportedBedCells([...supports, ...walls], read, 3);
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
              if (!Number.isFinite(headDamage) || headDamage < 50) { reject('head_damage_low'); continue; }
              add('accepted');
              found.push({ head, foot, stand, supportBlocks, screen, headDistance, headDamage, selfDamage,
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
