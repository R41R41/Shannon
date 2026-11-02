import { Vec3 } from 'vec3';
import { bodyReader, type BlockReader } from './localMap.js';
import type { P3 } from './dragonParts.js';

/**
 * What an end crystal's blast would do to the body where it stands, by the game's own rule (Explosion.explode, power 6: it reaches 12 blocks;
 * an entity at distance d with a fraction `seen` of its box in the blast's sight takes ((i² + i) / 2) * 7 * 12 + 1 with i = (1 - d / 12) * seen,
 * as a whole number; then the difficulty, then the armour). An estimate: enchantments, the shield, resistance and absorption are not counted,
 * and a ray through iron bars is counted as passing (a bar is a thin post). So a blast is judged worse, not better, than it will be.
 */
export const CRYSTAL_POWER = 6;
export const CRYSTAL_REACH = CRYSTAL_POWER * 2;
/** An arrow is shot from at least this far (the blast reaches 12). */
export const CRYSTAL_SAFE_SHOT = 13;
/** A blow is struck only when the estimate leaves the body this much health. */
export const BLAST_MARGIN = 4;

const ARMOR: Record<string, { head: number; chest: number; legs: number; feet: number; toughness: number }> = {
  leather: { head: 1, chest: 3, legs: 2, feet: 1, toughness: 0 }, golden: { head: 2, chest: 5, legs: 3, feet: 1, toughness: 0 },
  chainmail: { head: 2, chest: 5, legs: 4, feet: 1, toughness: 0 }, iron: { head: 2, chest: 6, legs: 5, feet: 2, toughness: 0 },
  diamond: { head: 3, chest: 8, legs: 6, feet: 3, toughness: 2 }, netherite: { head: 3, chest: 8, legs: 6, feet: 3, toughness: 3 },
  turtle: { head: 2, chest: 0, legs: 0, feet: 0, toughness: 0 },
};
/** The armour points and toughness of what is worn (the head, chest, legs and feet slots 5 to 8). */
export function armorOf(bot: any): { points: number; toughness: number } {
  let points = 0, toughness = 0;
  const slots: Array<[number, 'head' | 'chest' | 'legs' | 'feet']> = [[5, 'head'], [6, 'chest'], [7, 'legs'], [8, 'feet']];
  for (const [slot, part] of slots) {
    const name = String(bot?.inventory?.slots?.[slot]?.name ?? '');
    const material = Object.keys(ARMOR).find(key => name.startsWith(`${key}_`));
    if (!material) continue;
    points += ARMOR[material][part]; toughness += ARMOR[material].toughness;
  }
  return { points, toughness };
}

/** The damage after armour (CombatRules.getDamageAfterAbsorb). */
export function afterArmor(damage: number, points: number, toughness: number): number {
  const f = 2 + toughness / 4;
  const reduction = Math.min(20, Math.max(points - damage / f, points * 0.2));
  return damage * (1 - reduction / 25);
}
export function afterDifficulty(damage: number, difficulty: string | undefined): number {
  switch (String(difficulty ?? 'normal')) {
    case 'peaceful': return 0;
    case 'easy': return Math.min(damage / 2 + 1, damage);
    case 'hard': return damage * 1.5;
    default: return damage;
  }
}
/** The blast's raw damage at `distance` for the fraction of the body that is in its sight. */
export function blastRaw(distance: number, seen: number, power = CRYSTAL_POWER): number {
  const reach = power * 2;
  if (distance >= reach || seen <= 0) return 0;
  const impact = (1 - distance / reach) * seen;
  return Math.floor((impact * impact + impact) / 2 * 7 * reach + 1);
}

/** The collision boxes of a block in its own cell (min x y z, max x y z, 0 to 1), or null when they are not known (then a solid block is taken as a whole cube). */
export type ShapesAt = (x: number, y: number, z: number) => number[][] | null;
const WHOLE_CUBE: number[][] = [[0, 0, 0, 1, 1, 1]];
const LINE_STEP = 0.1;

/** Whether the segment a to b passes through the box (min, max). */
function segmentHitsBox(a: P3, b: P3, min: P3, max: P3): boolean {
  let t0 = 0, t1 = 1;
  for (const axis of ['x', 'y', 'z'] as const) {
    const d = b[axis] - a[axis];
    if (Math.abs(d) < 1e-12) { if (a[axis] < min[axis] || a[axis] > max[axis]) return false; continue; }
    let u0 = (min[axis] - a[axis]) / d, u1 = (max[axis] - a[axis]) / d;
    if (u0 > u1) [u0, u1] = [u1, u0];
    t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * The fraction of the body's box that the blast's centre sees: the game's own sample grid (Explosion.getSeenPercent: steps of 1 / (2 w + 1) across, 1 / (2 h + 1) up,
 * 45 points for a body 0.6 wide and 1.8 tall) with a straight line from each point to the centre; a line is shut out by the collision boxes of the solid blocks it passes
 * through (a bottom slab shuts out what is under its top and leaves the line over it, a stair its steps; a block whose boxes are not known is a whole cube; iron bars are passed:
 * a bar is a thin post, so the estimate is the larger one). Independent review 2026-11-02: a slab taken as a whole cube judged a blast of 17 as none.
 */
export function seenFraction(read: BlockReader, centre: P3, feet: P3, ignore: P3[] = [], shapesAt?: ShapesAt): number {
  const w = 0.6, h = 1.8;
  const d0 = 1 / (w * 2 + 1), d1 = 1 / (h * 2 + 1), d2 = d0;
  const d3 = (1 - Math.floor(1 / d0) * d0) / 2, d4 = (1 - Math.floor(1 / d2) * d2) / 2;
  // The cell the blast is centred in is never in its way (a bed is gone when it blows), nor are the cells given.
  const skip = new Set([centre, ...ignore].map(cell => `${Math.floor(cell.x)},${Math.floor(cell.y)},${Math.floor(cell.z)}`));
  let seen = 0, total = 0;
  for (let fx = 0; fx <= 1 + 1e-9; fx += d0) for (let fy = 0; fy <= 1 + 1e-9; fy += d1) for (let fz = 0; fz <= 1 + 1e-9; fz += d2) {
    total++;
    const to = { x: feet.x - w / 2 + w * fx + d3, y: feet.y + h * fy, z: feet.z - w / 2 + w * fz + d4 };
    const length = Math.hypot(to.x - centre.x, to.y - centre.y, to.z - centre.z), steps = Math.max(1, Math.ceil(length / LINE_STEP));
    const tried = new Set<string>();
    let blocked = false;
    for (let i = 1; i < steps && !blocked; i++) {
      const t = i / steps;
      const bx = Math.floor(centre.x + (to.x - centre.x) * t), by = Math.floor(centre.y + (to.y - centre.y) * t), bz = Math.floor(centre.z + (to.z - centre.z) * t);
      const key = `${bx},${by},${bz}`;
      if (skip.has(key) || tried.has(key)) continue;
      tried.add(key);
      const block = read(bx, by, bz);
      if (!block || block.solid !== true || block.name === 'iron_bars') continue;
      const boxes = shapesAt?.(bx, by, bz) ?? WHOLE_CUBE;
      if (boxes.some(box => segmentHitsBox(centre, to, { x: bx + box[0], y: by + box[1], z: bz + box[2] }, { x: bx + box[3], y: by + box[4], z: bz + box[5] }))) blocked = true;
    }
    if (!blocked) seen++;
  }
  return total ? seen / total : 0;
}

export interface BlastEstimate { distance: number; seen: number; raw: number; expected: number; armor: number; health: number; safe: boolean }
/** What a blast of `power` (a crystal's 6, a bed's 5) at `centre` would take from the body at `feet` (the body's own place by default), and whether the body can take it. */
export function blastAt(bot: any, centre: P3, feet: P3 = bot.entity.position, power = CRYSTAL_POWER, ignore: P3[] = []): BlastEstimate {
  const distance = Math.hypot(feet.x - centre.x, feet.y - centre.y, feet.z - centre.z);
  const shapesAt: ShapesAt = (x, y, z) => {
    try { const shapes = bot?.blockAt?.(new Vec3(x, y, z), false)?.shapes; return Array.isArray(shapes) && shapes.length ? shapes as number[][] : null; } catch { return null; }
  };
  const seen = distance >= power * 2 ? 0 : seenFraction(bodyReader(bot), centre, feet, ignore, shapesAt);
  const raw = blastRaw(distance, seen, power);
  const { points, toughness } = armorOf(bot);
  const expected = raw === 0 ? 0 : Math.round(afterArmor(afterDifficulty(raw, bot?.game?.difficulty), points, toughness) * 10) / 10;
  const health = Number(bot?.health ?? 20);
  return { distance: Math.round(distance * 10) / 10, seen: Math.round(seen * 100) / 100, raw, expected, armor: points, health, safe: expected + BLAST_MARGIN < health };
}
