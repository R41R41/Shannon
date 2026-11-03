import { blastAt } from './crystalBlast.js';
import { cloudReaches } from './dragonDanger.js';
import { bedCellSupported, supportedBedCells, type BedBlockReader } from './dragonBedGeometry.js';
import { boxDistance, boxesOverlap, bodyBoxAt, flameCloudCentre, inflate, isPerched, partBox, shift, type P3 } from './dragonParts.js';
import { STRIKE_REACH } from './dragonState.js';

/** Geometry for a lab HEAD to consider, never a building or fighting policy in the body. */
export interface NookWorld {
  perch?: P3;
  dragon?: { position: P3; yaw: number; phase: number | null };
  dragonBreath?: Array<P3 & { radius: number }>;
}
export interface NookCell extends P3 { block: 'cobblestone' | 'obsidian'; role: 'floor' | 'scaffold' | 'roof' | 'bed_support' | 'screen' }
export interface DragonNook {
  kind: 'raised_canopy'; stand: P3; strike: P3; rise: number;
  cells: NookCell[]; requiredCells: P3[]; dig: P3[]; headReach: number;
  window: { walkMeters: number; walkSeconds: number; firstBlowSeconds: number; minimumSeconds: number; fits: boolean };
  bed: { foot: P3; partner: P3; expectedDamage: number; wallBottom: number; wallTop: number; wallHeight: number } | null;
  /** A roof stops a projectile, not a cloud. These are limits, not an exemption for the reflex. */
  protection: { flameGround: number; roofY: number; fireballReflex: 'unchanged'; unconditionalSafety: false };
}
const key = (p: P3) => `${p.x},${p.y},${p.z}`;
const air = (b: ReturnType<BedBlockReader>) => !!b && /^(air|cave_air|void_air)$/u.test(b.name);
const cube = (block: string) => ({ name: block, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] });
const distance = (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Same boxes and stopping clearance (1.5 m) as the existing perch/reflex calculations. No wall blocks contact damage. */
function contactClear(dragon: NonNullable<NookWorld['dragon']>, feet: P3): boolean {
  const boxes = [inflate(partBox(dragon, 'head'), 2.6), inflate(partBox(dragon, 'neck'), 2.6),
    ...(['wing1', 'wing2'] as const).map(part => inflate(shift(inflate(partBox(dragon, part), 4, 2, 4), 0, -2, 0), 1.6))];
  return !boxes.some(box => boxesOverlap(bodyBoxAt(feet), box));
}
function ground(read: BedBlockReader, x: number, z: number, top: number): number | null {
  for (let y = Math.floor(top); y >= top - 16; y--) {
    const b = read({ x, y, z });
    if (!b) return null;
    if (b.boundingBox === 'block') return b.name === 'end_stone' ? y + 1 : null;
    if (!air(b)) return null;
  }
  return null;
}

/** Bounded, read-only design from a loaded perch, a sitting dragon and terrain. No coordinates, seed cases, I/O or action selection.
 * The open sides intentionally do NOT claim immunity to lateral fireballs. The existing reflex remains authoritative. */
export function dragonNook(world: NookWorld, read: BedBlockReader, withBed = false): { plan: DragonNook | null; reason: string | null } {
  const dragon = world.dragon;
  if (!world.perch || !dragon || !isPerched(dragon.phase) || ![world.perch, dragon.position].every(p => [p.x, p.y, p.z].every(Number.isFinite)) || !Number.isFinite(dragon.yaw)) {
    return { plan: null, reason: 'observed_perch_and_sitting_dragon_required' };
  }
  const head = partBox(dragon, 'head'), flame = flameCloudCentre(dragon);
  // Never infer unknown ground, nor change the height at the future flame's column with our construction.
  const flameGround = ground(read, Math.floor(flame.x), Math.floor(flame.z), flame.y);
  if (flameGround === null) return { plan: null, reason: 'flame_ground_unobserved' };
  const candidates: Array<{ stand: P3; rise: number; headReach: number }> = [];
  for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
    const x = Math.floor((head.minX + head.maxX) / 2) + dx, z = Math.floor((head.minZ + head.maxZ) / 2) + dz;
    const base = ground(read, x, z, world.perch.y);
    if (base === null) continue;
    for (const rise of [1, 2]) {
      const stand = { x: x + 0.5, y: base + rise, z: z + 0.5 };
      const headReach = boxDistance({ ...stand, y: stand.y + 1.62 }, head);
      if (headReach > STRIKE_REACH || !contactClear(dragon, stand) || cloudReaches({ ...flame, y: flameGround }, 7, stand, 1.5) ||
        (world.dragonBreath ?? []).some(c => cloudReaches(c, c.radius, stand, 1.5))) continue;
      candidates.push({ stand, rise, headReach });
    }
  }
  // Prefer the outer side of the head: the roof/scaffold then also stay away from the dragon's central body while building.
  const outward = (p: P3) => (p.x - dragon.position.x) * Math.sin(dragon.yaw) + (p.z - dragon.position.z) * Math.cos(dragon.yaw);
  candidates.sort((a, b) => a.rise - b.rise || outward(b.stand) - outward(a.stand) || a.headReach - b.headReach);
  for (const candidate of candidates) {
    const { stand, rise, headReach } = candidate, x = Math.floor(stand.x), z = Math.floor(stand.z), roofY = stand.y + 5;
    const cells: NookCell[] = [], planned = new Map<string, NookCell>();
    const projected: BedBlockReader = p => planned.has(key(p)) ? cube(planned.get(key(p))!.block) : read(p);
    const add = (targets: P3[], block: NookCell['block'], role: NookCell['role']) => {
      const supported = supportedBedCells(targets, projected, 3);
      if (!supported) return false;
      for (const p of supported) {
        const cell = { ...p, block, role }; cells.push(cell); planned.set(key(p), cell);
      }
      return true;
    };
    const floor: P3[] = [], roof: P3[] = [];
    for (let ix = -1; ix <= 1; ix++) for (let iz = -1; iz <= 1; iz++) {
      floor.push({ x: x + ix, y: stand.y - 1, z: z + iz }); roof.push({ x: x + ix, y: roofY, z: z + iz });
    }
    if (floor.some(p => p.x === Math.floor(flame.x) && p.z === Math.floor(flame.z)) || !add(floor, 'cobblestone', 'floor')) continue;
    const scaffold = Array.from({ length: 5 }, (_, i) => ({ x: x - 1, y: stand.y + i, z: z - 1 }));
    if (!add(scaffold, 'cobblestone', 'scaffold') || !add(roof, 'obsidian', 'roof')) continue;
    // Do not build into the stance, a low ceiling, the fountain, liquids or unobserved terrain.
    if (![0, 1].every(dy => air(projected({ x, y: stand.y + dy, z })))) continue;
    let bed: DragonNook['bed'] = null;
    if (withBed) {
      const hx = (head.minX + head.maxX) / 2, hz = (head.minZ + head.maxZ) / 2;
      const alongX = Math.abs(hx - stand.x) >= Math.abs(hz - stand.z);
      const step = alongX ? { x: Math.sign(hx - stand.x), z: 0 } : { x: 0, z: Math.sign(hz - stand.z) };
      const foot = { x: Math.floor(hx) - step.x, y: Math.floor(head.minY), z: Math.floor(hz) - step.z };
      const partner = { x: foot.x + step.x, y: foot.y, z: foot.z + step.z };
      if (![foot, partner].every(p => air(projected(p))) || distance(stand, { x: foot.x + 0.5, y: foot.y + 0.5 - 1.62, z: foot.z + 0.5 }) > 5) continue;
      if (!add([foot, partner].map(p => ({ ...p, y: p.y - 1 })), 'cobblestone', 'bed_support')) continue;
      const middle = alongX ? Math.floor((stand.x + foot.x + 0.5) / 2) : Math.floor((stand.z + foot.z + 0.5) / 2);
      const screen = Array.from({ length: 3 }, (_, i) => alongX ? { x: middle, y: stand.y + i, z } : { x, y: stand.y + i, z: middle });
      if (screen.some(p => (p.x === x && p.z === z) || [foot, partner].some(b => key(b) === key(p))) || !add(screen, 'obsidian', 'screen')) continue;
      // The scaffold will be gone when the bed is used. It must not count as blast shielding.
      const projectedBot = { blockAt: (p: P3) => planned.get(key(p))?.role === 'scaffold' ? { name: 'air', boundingBox: 'empty', shapes: [] } : projected(p), health: 20, game: { difficulty: 'normal' },
        inventory: { slots: { 5: { name: 'iron_helmet' }, 6: { name: 'iron_chestplate' }, 7: { name: 'iron_leggings' }, 8: { name: 'iron_boots' } } } };
      const estimates = [foot, partner].map(p => blastAt(projectedBot, { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }, stand, 5, [foot, partner]));
      const expectedDamage = Math.max(...estimates.map(e => e.expected));
      if (!Number.isFinite(expectedDamage) || expectedDamage > 4 || !estimates.every(e => e.safe)) continue;
      bed = { foot, partner, expectedDamage, wallBottom: stand.y, wallTop: stand.y + 2, wallHeight: 3 };
    }
    if (cells.filter(p => p.block === 'cobblestone').length > 64 || cells.filter(p => p.block === 'obsidian').length > 12) continue;
    // Final structure after removing the temporary column. A new cloud at another height is always checked anew by the reflex.
    const dig = cells.filter(c => c.role === 'scaffold').map(({ x, y, z }) => ({ x, y, z })).reverse();
    const finalRead: BedBlockReader = p => dig.some(s => key(s) === key(p)) ? { name: 'air', boundingBox: 'empty' } : projected(p);
    if ((world.dragonBreath ?? []).some(c => cloudReaches(c, c.radius, stand, 1.5)) || !air(finalRead({ x, y: stand.y, z }))) continue;
    return { reason: null, plan: { kind: 'raised_canopy', stand, strike: { ...stand }, rise, cells, requiredCells: [...floor, ...roof], dig, headReach,
      window: { walkMeters: 0, walkSeconds: 0, firstBlowSeconds: 0.65, minimumSeconds: 2.45, fits: true }, bed,
      protection: { flameGround, roofY, fireballReflex: 'unchanged', unconditionalSafety: false } } };
  }
  return { plan: null, reason: 'no_loaded_reachable_geometry_within_material_budget' };
}

/** Physical occupancy, not a safety certificate. A missing roof/floor makes residence unconfirmed. */
export function insideDragonNook(plan: DragonNook, feet: P3, read: BedBlockReader): boolean {
  return Math.abs(feet.x - plan.stand.x) <= 0.45 && Math.abs(feet.z - plan.stand.z) <= 0.45 && Math.abs(feet.y - plan.stand.y) <= 0.15 &&
    read({ x: Math.floor(plan.stand.x), y: plan.stand.y - 1, z: Math.floor(plan.stand.z) })?.boundingBox === 'block' &&
    plan.requiredCells.every(c => read(c)?.boundingBox === 'block') &&
    plan.dig.every(c => air(read(c)));
}

/** One cell at a time, freshly checked by the caller before using the existing place hand. */
export const nookCellSupported = bedCellSupported;
