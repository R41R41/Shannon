/**
 * Lab arithmetic for the bed-kill checks M4 (where to stand), M5 (the perched budget) and M6 (the wait for the first landing),
 * dragon-bed-precision-20261104.md 264-270. Pure: no bot, no packets, no timers. The isolated End probe's M4-M6 scenes
 * (scripts/lab/end-bed-m456-scenes.part.ts) and their unit tests use these; nothing in the production body does.
 *
 * Vanilla 1.21.11 (sources @6c4ae19): ServerExplosion.hurtEntities — d = |feet - centre| / (2 * power), the knockback is
 * (eye - centre).normalize() * (1 - d) * seen * (1 - knockbackResistance), and the damage (before difficulty and armour)
 * 7 * power * (q^2 + q) + 1 with q = (1 - d) * seen. A bed is power 5. EnderDragon.hurt: off the perch nothing caps; on it,
 * the health lost since the perch began (not reset by healing) above 0.25 * 200 = 50 makes the blow that crossed it whole
 * and the dragon take off.
 */
import { bedExposure, bedDamage, type BedBlockReader } from './dragonBedGeometry.js';
import type { Box, P3 } from './dragonParts.js';

export const BED_POWER = 5;
const RANGE = BED_POWER * 2;
export const PERCH_TAKEOFF_LOSS = 50;

const finite = (...n: number[]) => n.every(Number.isFinite);
const dist = (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The share of the 45 body points that the blast saw, from the knockback vector the explosion packet gives the player (1.21.3+).
 * Exact when the player has no Blast Protection and no knockback resistance. Null when the feet are out of the blast's range. */
export function exposureFromKnockback(knockback: P3, feet: P3, centre: P3): number | null {
  if (!finite(knockback.x, knockback.y, knockback.z, feet.x, feet.y, feet.z, centre.x, centre.y, centre.z)) return null;
  const falloff = 1 - dist(feet, centre) / RANGE;
  if (falloff <= 0) return null;
  return Math.hypot(knockback.x, knockback.y, knockback.z) / falloff;
}

/** q from a dragon's or an unarmoured player's loss D = 35(q^2 + q) + 1 (Normal). */
export function impactFromDamage(damage: number): number | null {
  if (!finite(damage) || damage < 1) return null;
  return (Math.sqrt(1 + 4 * (damage - 1) / (7 * BED_POWER)) - 1) / 2;
}
/** The exposure that an unarmoured player's loss implies at a given feet distance (Normal, no armour, no effects). */
export function exposureFromDamage(damage: number, feetDistance: number): number | null {
  const q = impactFromDamage(damage), falloff = 1 - feetDistance / RANGE;
  return q === null || !finite(feetDistance) || falloff <= 0 ? null : q / falloff;
}
/** The distance d (exposure 1) at which a bed takes `damage` off the dragon's head: the inverse of bedDamage. */
export function distanceForDamage(damage: number): number | null {
  const q = impactFromDamage(damage);
  return q === null || q > 1 ? null : RANGE * (1 - q);
}

/** Iron armour (15 points, no toughness) applied to a loss: vanilla CombatRules.getDamageAfterAbsorb. */
export function afterArmour(damage: number, armour = 15, toughness = 0): number {
  const f = 2 + toughness / 4, g = Math.min(Math.max(armour - damage / f, armour * 0.2), 20);
  return damage * (1 - g / 25);
}

export type Cardinal = 'north' | 'south' | 'east' | 'west';
export const CARDINAL: Readonly<Record<Cardinal, P3>> = {
  north: { x: 0, y: 0, z: -1 }, south: { x: 0, y: 0, z: 1 }, east: { x: 1, y: 0, z: 0 }, west: { x: -1, y: 0, z: 0 },
};
/** Mineflayer yaw (radians, r = PI - theta) that faces the given horizontal direction; a bed placed with it has its pillow one step that way. */
export function facingYaw(direction: Cardinal): number {
  const d = CARDINAL[direction];
  const theta = Math.atan2(-d.x, d.z); // vanilla yRot: south 0, west +90, north 180, east -90 (radians here)
  const r = Math.PI - theta;
  return ((r + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

/**
 * One M4 layout, in cells. The pillow is `pillow`; the bed faces `facing` so its foot is one step back. The foot rests on an obsidian
 * "arm" (the M3 place hand clicks its top). A column of `column` obsidian stands under the pillow, its top touching the pillow.
 * Extra obsidian `shield` cells may be added. The stand is a feet position (not a cell): its floor is under it.
 */
export interface M4Layout {
  label: string; pillow: P3; foot: P3; facing: Cardinal; arm: P3; column: P3[]; shield: P3[]; stand: P3;
  /** The design's own words for this layout (which line of the design it checks). */
  checks: string;
}
export interface M4LayoutInput {
  label: string; pillow: P3; facing: Cardinal; column: number; stand: P3; shield?: P3[]; checks: string;
}
export function m4Layout(input: M4LayoutInput): M4Layout {
  const back = CARDINAL[input.facing], p = input.pillow;
  if (!finite(p.x, p.y, p.z, input.stand.x, input.stand.y, input.stand.z) || ![p.x, p.y, p.z].every(Number.isInteger) || !Number.isInteger(input.column) || input.column < 0) throw new Error('invalid_m4_layout');
  const foot = { x: p.x - back.x, y: p.y, z: p.z - back.z };
  const column: P3[] = [];
  for (let i = 1; i <= input.column; i++) column.push({ x: p.x, y: p.y - i, z: p.z });
  return { label: input.label, pillow: p, foot, facing: input.facing, arm: { ...foot, y: foot.y - 1 }, column, shield: input.shield ?? [], stand: input.stand, checks: input.checks };
}

const OBSIDIAN = { name: 'obsidian', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
const AIR = { name: 'air', boundingBox: 'empty', shapes: [] as number[][] };
const cellKey = (p: P3) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
/** A reader of the layout alone on a flat floor whose top is `floorY` (the floor is solid everywhere at floorY - 1). */
export function m4Reader(layout: M4Layout, floorY: number): BedBlockReader {
  const solid = new Set([layout.arm, ...layout.column, ...layout.shield].map(cellKey));
  return p => (solid.has(cellKey(p)) || Math.floor(p.y) === floorY - 1 ? OBSIDIAN : AIR);
}
export const playerBox = (feet: P3, width = 0.6, height = 1.8): Box =>
  ({ minX: feet.x - width / 2, minY: feet.y, minZ: feet.z - width / 2, maxX: feet.x + width / 2, maxY: feet.y + height, maxZ: feet.z + width / 2 });

/** The model's view of one layout: exposure (45 points), unarmoured loss, the knockback size, and the reach for the M3 burst from the stand. */
export function m4Predict(layout: M4Layout, floorY: number) {
  const read = m4Reader(layout, floorY);
  const centre = { x: layout.pillow.x + 0.5, y: layout.pillow.y + 0.5, z: layout.pillow.z + 0.5 };
  const exposure = bedExposure(read, centre, playerBox(layout.stand), [layout.pillow, layout.foot]);
  const feetDistance = dist(layout.stand, centre);
  const eye = { ...layout.stand, y: layout.stand.y + 1.62 };
  const reachTo = (cell: P3) => Math.hypot(...(['x', 'y', 'z'] as const).map(k => Math.max(cell[k] - eye[k], 0, eye[k] - cell[k] - 1)));
  return {
    exposure, rays: Math.round(exposure * 45), feetDistance, damage: bedDamage(feetDistance, exposure),
    damageIron: afterArmour(bedDamage(feetDistance, exposure)), knockback: (1 - feetDistance / RANGE) * exposure,
    reach: Math.max(reachTo(layout.arm), reachTo(layout.foot)), feetBelowCentre: centre.y - layout.stand.y,
    horizontalFromAxis: Math.hypot(layout.stand.x - centre.x, layout.stand.z - centre.z),
  };
}

/** M4's pass line for one blast: unarmoured loss at most 1.5 (one of 45 rays at 3.3 m) and no push worth the name. */
export const M4_MAX_LOSS = 1.5;
export const M4_MAX_PUSH = 0.05;
export function m4Verdict(blasts: ReadonlyArray<{ loss: number | null; push: number | null }>) {
  const seen = blasts.filter(b => b.loss !== null);
  const worstLoss = seen.reduce((m, b) => Math.max(m, b.loss ?? 0), 0);
  const worstPush = blasts.reduce((m, b) => Math.max(m, b.push ?? 0), 0);
  return { blasts: blasts.length, measured: seen.length, worstLoss, worstPush,
    pass: seen.length === blasts.length && blasts.length > 0 && worstLoss <= M4_MAX_LOSS + 1e-6 && worstPush <= M4_MAX_PUSH };
}

/**
 * M5: the pillow cell whose centre is nearest `target` metres from the head's feet, among air cells clear of the dragon.
 * `atLeast` keeps the first blast's distance from dropping under the line (the perched budget: d >= ~2.2 m keeps D <= 50).
 */
export function m5PillowCell(headFeet: P3, target: number, options: { atLeast?: number; isFree: (cell: P3) => boolean; span?: number }): { cell: P3; distance: number; damage: number } | null {
  if (!finite(headFeet.x, headFeet.y, headFeet.z, target)) return null;
  const span = options.span ?? 4, at = { x: Math.floor(headFeet.x), y: Math.floor(headFeet.y), z: Math.floor(headFeet.z) };
  let best: { cell: P3; distance: number; damage: number; error: number } | null = null;
  for (let dx = -span; dx <= span; dx++) for (let dy = -span; dy <= span; dy++) for (let dz = -span; dz <= span; dz++) {
    const cell = { x: at.x + dx, y: at.y + dy, z: at.z + dz };
    const distance = dist({ x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 }, headFeet);
    if (options.atLeast !== undefined && distance < options.atLeast) continue;
    if (!options.isFree(cell)) continue;
    const error = Math.abs(distance - target);
    if (!best || error < best.error - 1e-9) best = { cell, distance, damage: bedDamage(distance, 1), error };
  }
  return best ? { cell: best.cell, distance: best.distance, damage: best.damage } : null;
}

/** What the perched rule predicts for a series of losses that start a perch with `carried` already counted. */
export function perchedBudget(losses: readonly number[], carried = 0) {
  let sum = carried;
  const steps = losses.map((loss, i) => {
    sum += loss;
    const takesOff = sum > PERCH_TAKEOFF_LOSS;
    const step = { i, loss, sum, takesOff };
    if (takesOff) sum = 0;
    return step;
  });
  return { steps, takeoffAt: steps.find(s => s.takesOff)?.i ?? null };
}

/** Order statistics for M6 (nearest-rank quantiles; censored samples are reported apart, never mixed in). */
export function waitSummary(seconds: readonly number[], censored = 0) {
  const s = [...seconds].filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p: number) => s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] : null;
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
  return { n: s.length, censored, min: s[0] ?? null, p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9), max: s.at(-1) ?? null, mean };
}
