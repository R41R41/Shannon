import { Vec3 } from 'vec3';
import type { Cell } from './localMap.js';

/** Direction goes FROM the entrance INTO the wall. All positions are absolute integer cells, never a vertical pit. */
export const DEN_DIRECTIONS = ['north', 'east', 'south', 'west'] as const;
export type DenDirection = typeof DEN_DIRECTIONS[number];
export interface EndermanDenSpec { entrance: Cell; direction: DenDirection }
export interface DenBlock {
  name: string;
  boundingBox: string;
  diggable?: boolean;
  hardness?: number | null;
  shapes?: readonly (readonly number[])[];
  getProperties?(): Record<string, unknown>;
}
export interface DenWorld {
  entity: { position: { x: number; y: number; z: number } };
  blockAt(position: Vec3, extraInfos?: boolean): DenBlock | null;
}
/** Exact natural block names, like canDig's named permissions; no ores, utility blocks, gravity blocks, or arbitrary walls. */
export const DEN_DIG_NAMES: readonly string[] = Object.freeze([
  'netherrack', 'warped_nylium', 'crimson_nylium', 'warped_wart_block', 'nether_wart_block', 'basalt', 'smooth_basalt', 'blackstone',
  'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'end_stone', 'dirt', 'coarse_dirt', 'grass_block',
]);
const NAMES = new Set(DEN_DIG_NAMES);
const AIR = new Set(['air', 'cave_air', 'void_air']);
const SOFT_PLANTS = /^(warped_roots|crimson_roots|nether_sprouts|warped_fungus|crimson_fungus|short_grass|grass|tall_grass|fern|large_fern|dead_bush)$/u;
const BAD = /^(lava|water|bubble_column|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|powder_snow|sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder|.*anvil|dragon_egg|pointed_dripstone|.*_portal|end_gateway)$/u;
const PARTIAL = /(?:slab|stairs|fence|wall|leaves|door|chest|glass|ice|honey|slime|soul_sand|farmland|dirt_path)/u;
const VECTORS: Record<DenDirection, Readonly<{ x: number; z: number }>> = {
  north: { x: 0, z: -1 }, east: { x: 1, z: 0 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 },
};
const FACES: readonly (readonly [number, number, number])[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const key = (p: Cell): string => `${p.x},${p.y},${p.z}`;
export const denCenter = (p: Cell): Vec3 => new Vec3(p.x + 0.5, p.y, p.z + 0.5);
export const denVector = (direction: DenDirection): Readonly<{ x: number; z: number }> => VECTORS[direction];
export function denOffset(den: EndermanDenSpec, depth: number, up = 0): Cell {
  const v = VECTORS[den.direction];
  return { x: den.entrance.x + v.x * depth, y: den.entrance.y + up, z: den.entrance.z + v.z * depth };
}
/** Front upper, front lower, back upper, back lower: the back is visible only after the front is open. */
export function denDigCells(den: EndermanDenSpec): Cell[] { return [denOffset(den, 0, 1), denOffset(den, 0), denOffset(den, 1, 1), denOffset(den, 1)]; }
export function endermanDenProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'den は {entrance:{x,y,z}, direction:north|east|south|west}';
  const d = value as Record<string, unknown>, e = d.entrance;
  if (Object.keys(d).some(k => k !== 'entrance' && k !== 'direction') || !DEN_DIRECTIONS.includes(d.direction as DenDirection)) return 'den の direction は壁の奥へ向く東西南北';
  if (!e || typeof e !== 'object' || Object.keys(e).length !== 3 || Object.keys(e).some(k => !['x', 'y', 'z'].includes(k))) return 'den.entrance は絶対座標 {x,y,z}';
  const p = e as Record<string, unknown>;
  if (![p.x, p.y, p.z].every(n => typeof n === 'number' && Number.isSafeInteger(n)) || Math.abs(Number(p.x)) > 29_999_980 || Math.abs(Number(p.z)) > 29_999_980
    || Number(p.y) < -64 || Number(p.y) > 317) return 'den.entrance はワールド内の整数マス';
  return null;
}
export function denRead(bot: Pick<DenWorld, 'blockAt'>, p: Cell): DenBlock | null {
  try { return bot.blockAt(new Vec3(p.x, p.y, p.z), false); } catch { return null; }
}
export function denHazard(b: DenBlock | null): boolean {
  if (!b) return true;
  try { const props = b.getProperties?.(); if (props?.waterlogged === true || props?.waterlogged === 'true') return true; } catch { return true; }
  return BAD.test(b.name);
}
export const denAir = (b: DenBlock | null): boolean => !!b && AIR.has(b.name) && !denHazard(b);
/** Harmless noncolliding plants are walked/looked through in place; this grants no permission to break them. */
const denPassable = (b: DenBlock | null): boolean => denAir(b) || !!b && b.boundingBox === 'empty' && SOFT_PLANTS.test(b.name) && !denHazard(b);
export function denSolid(b: DenBlock | null): boolean {
  return !!b && b.boundingBox === 'block' && !denHazard(b) && !PARTIAL.test(b.name)
    && (!b.shapes || b.shapes.some(s => s.length === 6 && s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 1 && s[4] === 1 && s[5] === 1));
}
/** Known, dry, full floor; no door opening or plant/leaf breaking is hidden in these movements. */
export function denStandable(bot: Pick<DenWorld, 'blockAt'>, p: Cell, height = 2): boolean {
  if (!denSolid(denRead(bot, { ...p, y: p.y - 1 }))) return false;
  for (let dy = 0; dy < height; dy++) if (!denPassable(denRead(bot, { ...p, y: p.y + dy }))) return false;
  return true;
}
export interface DenInspection {
  ok: boolean;
  code: string;
  reason: string;
  at?: Cell;
  remaining: Cell[];
}
/** Conservative shell: ALL six neighbours are sealed except the four excavated cells and the intended two-cell entrance. */
export function inspectEndermanDen(bot: Pick<DenWorld, 'blockAt'>, den: EndermanDenSpec, complete = false, canDig: readonly string[] = DEN_DIG_NAMES): DenInspection {
  const remaining: Cell[] = [];
  const fail = (code: string, reason: string, at?: Cell): DenInspection => ({ ok: false, code, reason, at, remaining });
  const problem = endermanDenProblem(den);
  if (problem) return fail('invalid_input', problem);
  const dig = denDigCells(den), inside = new Set(dig.map(key));
  const mouth = new Set([denOffset(den, -1), denOffset(den, -1, 1)].map(key));
  const allowed = new Set(canDig.filter(name => NAMES.has(name)));
  for (const p of dig) {
    const b = denRead(bot, p);
    if (!b || denHazard(b)) return fail(!b ? 'unloaded' : 'den_hazard', `${key(p)} は ${b?.name ?? '未ロード'}（液体・落下物・危険）`, p);
    if (denAir(b)) continue;
    if (complete || !denSolid(b) || !allowed.has(b.name) || b.diggable === false || b.hardness === null || (b.hardness ?? 0) < 0) {
      return fail(complete ? 'den_not_open' : 'den_not_diggable', `${key(p)} の ${b.name} は${complete ? 'まだ空いていない' : '横穴で掘ってよい固いブロックでない'}`, p);
    }
    remaining.push(p);
  }
  for (const p of dig) for (const [dx, dy, dz] of FACES) {
    const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz };
    if (inside.has(key(q)) || mouth.has(key(q))) continue;
    const b = denRead(bot, q);
    if (!b) return fail('unloaded', `${key(q)} は未ロード（穴の周囲を確認できない）`, q);
    if (denHazard(b)) return fail('den_hazard', `${key(q)} の ${b.name} へ開口する（掘らない）`, q);
    if (!denSolid(b)) return fail('den_open_shell', `${key(q)} は ${b.name}（天井・床・左右・奥が空洞へ開く）`, q);
  }
  // Both outside cells form the level runway for provoking and returning. The first has three cells for the enemy, too.
  for (const depth of [-1, -2]) if (!denStandable(bot, denOffset(den, depth), 3)) return fail('den_outside_unsafe', `入口外 ${key(denOffset(den, depth))} に平らで乾いた床と高さ3がない`, denOffset(den, depth));
  return { ok: true, code: 'den_valid', reason: '', remaining };
}
/** A ray including BOTH endpoint cells. No first-two-metres exemption; unknown cells, fluids and walls cannot certify sight. */
export function denClearRay(bot: Pick<DenWorld, 'blockAt'>, from: Cell, to: Cell): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) / 0.08));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!denPassable(denRead(bot, { x: Math.floor(from.x + (to.x - from.x) * t), y: Math.floor(from.y + (to.y - from.y) * t), z: Math.floor(from.z + (to.z - from.z) * t) }))) return false;
  }
  return true;
}
export interface EndermanDenCandidate extends EndermanDenSpec {
  dig: Cell[];
  wait: Cell;
  outside: Cell;
  outsideFloor: Cell;
  sightDistance: number;
  distance: number;
  remaining: number;
  score: number;
  penalties: string[];
}
export interface EndermanDenOptions { radius?: number; verticalRange?: number; limit?: number; minSight?: number; maxSight?: number; canDig?: readonly string[] }

/** Pure observation: reads loaded blocks only, never chooses a hand, digs, walks, mutates a bot, or reads a clock. */
export function endermanDenCandidates(bot: DenWorld, opts: EndermanDenOptions = {}): EndermanDenCandidate[] {
  const bounded = (n: number | undefined, fallback: number, lo: number, hi: number): number => Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n!))) : fallback;
  const radius = bounded(opts.radius, 7, 1, 12), vertical = bounded(opts.verticalRange, 1, 0, 2), limit = bounded(opts.limit, 8, 1, 64);
  const minSight = bounded(opts.minSight, 6, 3, 16), maxSight = bounded(opts.maxSight, 20, minSight, 24);
  const p = bot.entity.position, origin = { x: Math.floor(p.x), y: Math.floor(p.y + 0.001), z: Math.floor(p.z) };
  if (![p.x, p.y, p.z].every(Number.isFinite)) return [];
  // A per-call cache only; flowing lava or a removed roof is observed afresh on the next call and on every live check.
  const cache = new Map<string, DenBlock | null>();
  const world: DenWorld = { entity: bot.entity, blockAt(at) {
    const k = key(at); if (!cache.has(k)) cache.set(k, denRead(bot, at)); return cache.get(k) ?? null;
  } };
  const candidates: EndermanDenCandidate[] = [];
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -vertical; dy <= vertical; dy++) {
    if (Math.hypot(dx, dz) > radius) continue;
    for (const direction of DEN_DIRECTIONS) {
      const den: EndermanDenSpec = { entrance: { x: origin.x + dx, y: origin.y + dy, z: origin.z + dz }, direction };
      const check = inspectEndermanDen(world, den, false, opts.canDig);
      if (!check.ok) continue;
      const outside = denOffset(den, -1), v = denVector(direction), from = denCenter(outside).offset(0, 1.62, 0);
      // The frontal strip is both standable ground and an eye ray from the actual provoking cell. Side trees are not assumed away.
      let sightDistance = 0;
      for (let distance = 1; distance <= maxSight; distance++) {
        const ground = { x: outside.x - v.x * distance, y: outside.y, z: outside.z - v.z * distance };
        if (!denStandable(world, ground, 3) || !denClearRay(world, from, denCenter(ground).offset(0, 2.55, 0))) break;
        sightDistance = distance;
      }
      if (sightDistance < minSight) continue;
      const distance = Math.hypot(outside.x + 0.5 - p.x, outside.y - p.y, outside.z + 0.5 - p.z);
      const penalties: string[] = [];
      if (sightDistance < 12) penalties.push(`入口正面の見通しが短い（${sightDistance}m）`);
      if (dy) penalties.push(`入口まで高低差 ${dy}`);
      if (check.remaining.length) penalties.push(`未掘削 ${check.remaining.length}/4`);
      const score = distance + Math.abs(dy) * 2 + check.remaining.length * 0.25 + Math.max(0, 12 - sightDistance) * 0.5;
      candidates.push({ ...den, dig: denDigCells(den), wait: denOffset(den, 1), outside, outsideFloor: { ...outside, y: outside.y - 1 },
        sightDistance, distance, remaining: check.remaining.length, score, penalties });
    }
  }
  return candidates.sort((a, b) => a.score - b.score || a.distance - b.distance || b.sightDistance - a.sightDistance
    || a.entrance.x - b.entrance.x || a.entrance.z - b.entrance.z || a.direction.localeCompare(b.direction)).slice(0, limit);
}
