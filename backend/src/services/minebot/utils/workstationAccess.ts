import { Vec3 } from 'vec3';
import { BLOCK_USE_REACH, blockCenterWithinUseReach } from './blockInteractionReach.js';
import { checkBlockLineOfSight } from './blockLineOfSight.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
import type { CustomBot } from '../types/CustomBot.js';

/**
 * Where a crafting table or a furnace stands, and from where it can be used.
 *
 * Run 20 lost about 26 s to this: the second iron batch found its table behind the first furnace (craft-one: line_of_sight_blocked,
 * 13.9 s), a furnace at 4.3 m was refused (start-smelting, then a third furnace made for it, 12 s), and the first batch's furnace was
 * walked back to over 47 m. A workstation is used from one spot, so: (1) one is set down where it hides no other from that spot and
 * does not plug the way out, (2) before one is used the body checks it can reach it and see it, and moves to a spot where it can.
 */

export const WORKSTATION_BLOCKS = new Set(['crafting_table', 'furnace', 'blast_furnace', 'smoker']);
/** Eye-to-centre reach a stand or a spot is chosen for: a little inside BLOCK_USE_REACH, so a small drift does not lose it. */
export const STAND_USE_REACH = 4.0;
/** Stations this near (centre to eyes) are counted as part of the worksite. */
const WORKSITE_RANGE = 6;
/** Eyes to centre within which the server is likely to take an open that the body's own checks (4.25 m, clear view) would not allow. */
export const PLAUSIBLE_REACH = 5.0;

type BlockLike = { name?: string; boundingBox?: string; position?: Vec3; diggable?: boolean } | null | undefined;
/** What the checks need of the body; a stand-in body without `blockAt` sees nothing in the way. */
export interface StationBot { entity: { position: Vec3; height?: number }; blockAt?: (position: Vec3) => BlockLike }

const HAZARD = new Set(['water', 'flowing_water', 'lava', 'flowing_lava', 'fire', 'soul_fire', 'powder_snow', 'cactus',
  'sweet_berry_bush', 'magma_block', 'bubble_column', 'campfire', 'soul_campfire']);
const LIQUID = new Set(['water', 'flowing_water', 'lava', 'flowing_lava', 'bubble_column']);
const FALLING = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel', 'anvil', 'chipped_anvil', 'damaged_anvil',
  'pointed_dripstone']);
const EYE = 1.62;

const cellOf = (position: Vec3) => new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
const sameCell = (a: Vec3, b: Vec3) => Math.floor(a.x) === Math.floor(b.x) && Math.floor(a.y) === Math.floor(b.y) && Math.floor(a.z) === Math.floor(b.z);

function at(bot: StationBot, position: Vec3): BlockLike {
  try { return bot.blockAt?.(position); } catch { return null; }
}

/** An open cell a body can occupy: nothing solid, no liquid or fire. */
function open(block: BlockLike): boolean {
  return !!block && block.boundingBox === 'empty' && !HAZARD.has(block.name ?? '');
}

/** A cell to stand in: open feet and head cells over a solid floor that is not a hazard. */
export function isStandCell(bot: StationBot, cell: Vec3): boolean {
  const floor = at(bot, cell.offset(0, -1, 0));
  return open(at(bot, cell)) && open(at(bot, cell.offset(0, 1, 0)))
    && !!floor && floor.boundingBox === 'block' && !HAZARD.has(floor.name ?? '');
}

export interface StationAccess {
  /** Eyes to the block centre within the body's use reach. */
  inReach: boolean;
  /** Nothing solid between the eyes and the block centre. */
  clear: boolean;
  ready: boolean;
  eyeDistance: number;
  obstruction?: { name: string; position: Vec3 };
}

/** Whether a block can be used from `feet` (the body's place now by default): in reach and in sight. */
export function stationAccess(bot: StationBot, position: Vec3, feet: Vec3 = bot.entity.position, reach: number = BLOCK_USE_REACH): StationAccess {
  // A position that is only a distance (a stand-in without coordinates) is judged by that distance alone.
  if (!Number.isFinite(feet.x) || !Number.isFinite(feet.y) || !Number.isFinite(feet.z)) {
    const distance = typeof (feet as any).distanceTo === 'function' ? (feet as any).distanceTo(position.offset(0.5, 0.5, 0.5)) : Infinity;
    const near = distance <= reach + 0.25;
    return { inReach: near, clear: near, ready: near, eyeDistance: distance };
  }
  const inReach = blockCenterWithinUseReach(feet, position, reach);
  const eyeDistance = Math.hypot(feet.x - position.x - 0.5, feet.y + 1.65 - position.y - 0.5, feet.z - position.z - 0.5);
  // Out of reach: not looked at (sight is only asked of what can be used). A stand-in body without `blockAt` sees nothing in the way.
  if (!inReach) return { inReach, clear: false, ready: false, eyeDistance };
  if (typeof bot.blockAt !== 'function') return { inReach, clear: true, ready: true, eyeDistance };
  // A block of unknown shape (a bare stand-in) is not taken for a wall.
  const shaped = (position: Vec3): BlockLike => { const block = at(bot, position); return block && block.boundingBox === undefined ? { ...block, boundingBox: 'empty' } : block; };
  const view = { entity: { position: bot.entity.position, height: bot.entity.height ?? EYE }, blockAt: shaped } as unknown as CustomBot;
  const los = checkBlockLineOfSight(view, position, 99, feet);
  return { inReach, clear: los.clear, ready: los.clear, eyeDistance,
    ...(los.obstructionName && los.obstructionPos ? { obstruction: { name: los.obstructionName, position: los.obstructionPos } } : {}) };
}

/** The same body with one more solid block at `cell`: what the view from here would be once something is set down there. */
export function withSolidAt(bot: StationBot, cell: Vec3, name = 'furnace'): StationBot {
  const stand = { name, boundingBox: 'block', position: cell, diggable: true };
  return { entity: bot.entity, blockAt: (position: Vec3) => sameCell(position, cell) ? stand : at(bot, position) };
}

export interface Workstation { name: string; position: Vec3 }

/** Crafting tables and furnaces within `radius` of `around` (cells), nearest first. */
export function listWorkstations(bot: StationBot, around: Vec3 = bot.entity.position, radius = 7): Workstation[] {
  const base = cellOf(around);
  const found: Array<Workstation & { d: number }> = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -3; dy <= 4; dy++) {
        const position = base.offset(dx, dy, dz);
        const block = at(bot, position);
        if (block?.name && WORKSTATION_BLOCKS.has(block.name)) found.push({ name: block.name, position, d: Math.hypot(dx, dy, dz) });
      }
    }
  }
  return found.sort((a, b) => a.d - b.d).map(({ name, position }) => ({ name, position }));
}

export interface Stance { feet: Vec3; cost: number }

/**
 * Cells to stand in from which every one of `targets` can be used (in reach and in sight), cheapest to get to first. Searched round
 * the first target, not round the body: the body may be a long way off, and a stand beside the block is what is wanted.
 */
export function findStances(bot: StationBot, targets: Vec3[], options: { from?: Vec3; limit?: number; reach?: number; radius?: number } = {}): Stance[] {
  if (!targets.length) return [];
  const from = options.from ?? bot.entity.position;
  const reach = options.reach ?? STAND_USE_REACH;
  const radius = options.radius ?? 5;
  const base = cellOf(targets[0]);
  // Cells the body can walk to from where it stands (steps of one up or up to three down): a stand in the air, or on the far side of
  // a wall, is not offered. Not known (the body is not in a stand cell): every cell is a candidate, by distance.
  const walk = Number.isFinite(from.x) ? walkableCells(bot, cellOf(from), base) : null;
  const found: Stance[] = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -4; dy <= 3; dy++) {
        const cell = base.offset(dx, dy, dz);
        if (!isStandCell(bot, cell)) continue;
        // Not on top of a furnace or a table (it can be climbed, but it is no place to work from).
        if (WORKSTATION_BLOCKS.has(at(bot, cell.offset(0, -1, 0))?.name ?? '')) continue;
        const steps = walk?.get(cellKey(cell));
        if (walk && steps === undefined) continue;
        if (!walk && Math.abs(cell.y - Math.floor(from.y)) > 3) continue;
        const feet = cell.offset(0.5, 0, 0.5);
        if (!targets.every(target => stationAccess(bot, target, feet, reach).ready)) continue;
        found.push({ feet, cost: steps ?? (from.distanceTo(feet) + Math.abs(feet.y - from.y)) });
      }
    }
  }
  return found.sort((a, b) => a.cost - b.cost).slice(0, options.limit ?? 6);
}

const cellKey = (cell: Vec3) => `${cell.x},${cell.y},${cell.z}`;

/**
 * The stand cells reachable on foot from `start` (breadth first, steps of one up and up to three down, four directions), with the
 * number of steps, kept within 12 cells of `around`. Null when `start` is not itself a stand cell.
 */
export function walkableCells(bot: StationBot, start: Vec3, around: Vec3, bound = 12): Map<string, number> | null {
  if (!isStandCell(bot, start)) return null;
  const seen = new Map<string, number>([[cellKey(start), 0]]);
  const queue: Vec3[] = [start];
  for (let i = 0; i < queue.length && seen.size < 4000; i++) {
    const cell = queue[i];
    const steps = seen.get(cellKey(cell))!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [0, 1, -1, -2, -3]) {
        const next = cell.offset(dx, dy, dz);
        if (Math.abs(next.x - around.x) > bound || Math.abs(next.z - around.z) > bound || Math.abs(next.y - around.y) > 8) continue;
        if (seen.has(cellKey(next)) || !isStandCell(bot, next)) continue;
        // Up one needs room above the cell it leaves; down needs the cells over the drop to be open (stepped off, then fallen).
        if (dy === 1 && !open(at(bot, cell.offset(0, 2, 0)))) continue;
        if (dy < 0 && !open(at(bot, cell.offset(dx, 1, dz)))) continue;
        seen.set(cellKey(next), steps + 1);
        queue.push(next);
        break;
      }
    }
  }
  return seen;
}

/** How many of the four ways out of the body's cell are open (feet and head cell both). */
export function exitsFrom(bot: StationBot, feetCell: Vec3): number {
  let exits = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const beside = feetCell.offset(dx, 0, dz);
    if (open(at(bot, beside)) && open(at(bot, beside.offset(0, 1, 0)))) exits++;
  }
  return exits;
}

export interface SpotCandidate { x: number; y: number; z: number; dist: number; ref: string }
export interface ScoredSpot {
  cell: Vec3;
  score: number;
  /** Others the spot would hide from here. */
  hides: number;
  /** Ways out of the body's cell the block would close. */
  exitLoss: number;
  /** Cells the body could walk to that it could not once the block stands there (a corridor plugged beyond the body). */
  cut: number;
  /** A wall cell that has to be dug out first. */
  niche: boolean;
}

/** Every cell the body's box is in (the same cells place-block-at keeps clear: the body's feet, middle and head, at its corners). */
export function bodyBoxCells(at: { x: number; y: number; z: number }): Vec3[] {
  const cells: Vec3[] = [];
  for (const dx of [-0.3, 0.3]) for (const dz of [-0.3, 0.3]) for (const dy of [0, 1, 1.79]) {
    const cell = new Vec3(Math.floor(at.x + dx), Math.floor(at.y + dy), Math.floor(at.z + dz));
    if (!cells.some(other => other.equals(cell))) cells.push(cell);
  }
  return cells;
}

const isBody = (cell: Vec3, body: Vec3[]) => body.some(b => sameCell(b, cell));

/**
 * Where to set a workstation down, best first: within use reach of the eyes and in sight from the spot the body stands on; hiding no
 * other workstation it can use from here; not closing the way out (in a one-block tunnel a wall cell is dug out instead and the block
 * goes into it). `spots` are cells place-block-at can fill (find-placeable-spot's search).
 */
export function planWorkstationSpot(bot: StationBot, blockName: string, spots: SpotCandidate[],
  options: { exclude?: Vec3[] } = {}): ScoredSpot[] {
  const feet = bot.entity.position;
  const body = bodyBoxCells(feet);
  const feetCell = cellOf(feet);
  const eyes = feet.offset(0, EYE, 0);
  const stations = listWorkstations(bot, feet, WORKSITE_RANGE + 1).filter(s => s.position.offset(0.5, 0.5, 0.5).distanceTo(eyes) <= WORKSITE_RANGE);
  const usableNow = stations.filter(s => stationAccess(bot, s.position).ready);
  const exitsBefore = exitsFrom(bot, feetCell);
  const exclude = options.exclude ?? [];

  const score = (cell: Vec3, base: number, niche: boolean): ScoredSpot | null => {
    if (isBody(cell, body) || exclude.some(e => sameCell(e, cell))) return null;
    if (cell.offset(0.5, 0.5, 0.5).distanceTo(eyes) > STAND_USE_REACH) return null;
    // After it is set down: seen from here, hiding nothing that could be used from here, and the way out as open as it was.
    const after = withSolidAt(bot, cell, blockName);
    const own = stationAccess(bot, cell, feet, STAND_USE_REACH);
    if (!own.ready) return null;
    const hides = usableNow.filter(s => !stationAccess(after, s.position).ready).length;
    const exitsAfter = exitsFrom(after, feetCell);
    const exitLoss = exitsBefore - exitsAfter;
    const sealed = exitsBefore > 0 && exitsAfter === 0;
    return { cell, niche, hides, exitLoss, cut: 0, score: base + hides * 1000 + exitLoss * 30 + (sealed ? 800 : 0) };
  };

  // How many cells the body can walk to now; a block that takes away more than its own cell cuts a corridor off.
  const walkBound = 6;
  const walkBefore = walkableCells(bot, feetCell, feetCell, walkBound);
  const withCut = (entry: ScoredSpot): ScoredSpot => {
    if (!walkBefore) return entry;
    const walkAfter = walkableCells(withSolidAt(bot, entry.cell, blockName), feetCell, feetCell, walkBound);
    // The cell itself, and the stand cell under it whose head room it takes, are not what is looked for.
    const own = Number(isStandCell(bot, entry.cell)) + Number(isStandCell(bot, entry.cell.offset(0, -1, 0)));
    const cut = Math.max(0, walkBefore.size - (walkAfter?.size ?? 0) - own);
    return cut > 0 ? { ...entry, cut, score: entry.score + 200 + cut * 5 } : entry;
  };

  let scored: ScoredSpot[] = [];
  for (const spot of spots) {
    const cell = new Vec3(spot.x, spot.y, spot.z);
    const entry = score(cell, spot.dist + (spot.ref === '下' ? 0 : 3), false);
    if (entry) scored.push(entry);
  }
  // The corridor test is the dearer one: only the best few are put to it.
  scored = scored.sort((a, b) => a.score - b.score);
  scored = [...scored.slice(0, 12).map(withCut), ...scored.slice(12)];
  // A wall cell dug out beside the body (head height first: the floor stays clear). Only worth it when the body is in a corridor.
  const clean = scored.filter(entry => entry.hides === 0 && entry.exitLoss === 0 && entry.cut === 0);
  if (!clean.length && exitsBefore <= 2) {
    for (const dy of [1, 0]) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cell = feetCell.offset(dx, dy, dz);
        if (!nicheDiggable(bot, cell, new Vec3(dx, 0, dz))) continue;
        const entry = score(cell, 1 + (dy === 1 ? 0 : 0.5), true);
        if (entry) scored.push(withCut(entry));
      }
    }
  }
  return scored.sort((a, b) => a.score - b.score);
}

/** A wall cell that can be dug out and used: ordinary and diggable, with a wall behind it, and no liquid, sand or gravel round it. */
function nicheDiggable(bot: StationBot, cell: Vec3, away: Vec3): boolean {
  const block = at(bot, cell);
  if (!block || block.boundingBox !== 'block' || block.diggable === false) return false;
  const name = block.name ?? '';
  if (PROTECTED_UTILITY_BLOCKS.has(name) || WORKSTATION_BLOCKS.has(name) || FALLING.has(name) || HAZARD.has(name)) return false;
  if (/(_ore|spawner|bedrock|obsidian|portal|frame|_door|_bed|_sign|chest|barrel|rail)/.test(name)) return false;
  const behind = at(bot, cell.plus(away));
  if (!behind || behind.boundingBox !== 'block') return false;
  const above = at(bot, cell.offset(0, 1, 0));
  if (above && (FALLING.has(above.name ?? '') || LIQUID.has(above.name ?? ''))) return false;
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
    if (LIQUID.has(at(bot, cell.offset(dx, dy, dz))?.name ?? '')) return false;
  }
  return true;
}

export interface Hidden { name: string; position: Vec3; inReach: boolean; obstruction?: string }

/** The workstations near the stand (within the worksite) that cannot be used from `feet`: out of reach, or in the way of something. */
export function worksiteState(bot: StationBot, feet: Vec3 = bot.entity.position): { stations: Workstation[]; unusable: Hidden[] } {
  const eyes = feet.offset(0, EYE, 0);
  const stations = listWorkstations(bot, feet, WORKSITE_RANGE + 1).filter(s => s.position.offset(0.5, 0.5, 0.5).distanceTo(eyes) <= WORKSITE_RANGE);
  const unusable: Hidden[] = [];
  for (const station of stations) {
    const access = stationAccess(bot, station.position, feet);
    if (!access.ready) unusable.push({ ...station, inReach: access.inReach, ...(access.obstruction ? { obstruction: access.obstruction.name } : {}) });
  }
  return { stations, unusable };
}

/**
 * Why an open that the server did not answer failed, said from the body's own measure: null when it was in reach and in sight (the
 * cause is something else). The failure types are those of the checks before it (distance_too_far, line_of_sight_blocked).
 */
export function explainOpenFailure(bot: StationBot, position: Vec3, label: string):
  { success: false; failureType: string; recoverable: true; result: string } | null {
  const access = stationAccess(bot, position);
  if (access.ready) return null;
  const where = `${label}(${position.x}, ${position.y}, ${position.z})`;
  if (!access.inReach) {
    return { success: false, failureType: 'distance_too_far', recoverable: true,
      result: `${where}を開けませんでした: 遠すぎます（目から${access.eyeDistance.toFixed(1)}m、届くのは約${BLOCK_USE_REACH}m）。move-to で近づいてからもう一度` };
  }
  const blocker = access.obstruction ? `${access.obstruction.name}(${access.obstruction.position.x}, ${access.obstruction.position.y}, ${access.obstruction.position.z})` : '何か';
  return { success: false, failureType: 'line_of_sight_blocked', recoverable: true,
    result: `${where}を開けませんでした: 視線が${blocker}に遮られています（目から${access.eyeDistance.toFixed(1)}m）。別の側から近づいてもう一度。`
      + `${label}を見える所に置き直すこともできます` };
}

type Move = (x: number, y: number, z: number, range: number, goalType: string) => Promise<{ success?: boolean; result?: unknown; failureType?: string }>;

/**
 * Brings the body to a place from which `position` can be used: null when it can be (or now can), else why not and what to do. The
 * walk first is the coarse one to the block (as before); when the block is then still out of reach or out of sight, a stand beside
 * it is looked for (the cells round the block, nearest first) and walked to. A thing in the way that can be dug (stone, dirt) is
 * dug as a last resort; a furnace or a table in the way never is.
 */
export async function reachWorkstation(bot: StationBot, position: Vec3, move: Move,
  options: { label: string; stopped?: () => boolean; tryAnyway?: boolean; clearSight?: (position: Vec3) => Promise<{ clear: boolean; dug: boolean }> }): Promise<
  { success: false; failureType: string; recoverable: true; result: string } | null> {
  const first = stationAccess(bot, position);
  if (first.ready) return null;
  const where = `${options.label}(${position.x}, ${position.y}, ${position.z})`;
  let moved: { success?: boolean; result?: unknown; failureType?: string } = { success: true };
  let access = first;

  // 1. Not in reach: the coarse walk (a stand within reach whatever the height).
  if (!access.inReach) {
    try { moved = await move(position.x, position.y, position.z, 4, 'block'); }
    catch (error: any) { moved = { success: false, result: String(error?.message ?? error) }; }
    access = stationAccess(bot, position);
    if (access.ready) return null;
  }

  // 2. In reach but not in sight, or still out of reach: a stand beside it from which it is both.
  if (!options.stopped?.()) {
    const stances = findStances(bot, [position]);
    for (const stance of stances.slice(0, 3)) {
      if (options.stopped?.()) break;
      try { await move(stance.feet.x, stance.feet.y, stance.feet.z, 0.5, 'near'); } catch { /* the next stand */ }
      access = stationAccess(bot, position);
      if (access.ready) return null;
    }
  }

  // 3. Something diggable in the way (a wall of stone): dug, as the open itself did.
  if (access.inReach && !access.clear && access.obstruction && options.clearSight && !options.stopped?.()) {
    const cleared = await options.clearSight(position).catch(() => ({ clear: false, dug: false }));
    if (cleared.dug) {
      access = stationAccess(bot, position);
      if (access.ready) return null;
    }
  }

  // No stand found, but the server may well take it (the lab's opened a furnace through a table and up to 5.8 m from the eyes, though
  // the body keeps to 4.25 m and a clear view for itself): the caller tries the open, which costs at most the window wait (5 s) and
  // says why afterwards (explainOpenFailure). Better than a third furnace (12 s in run 20).
  if (options.tryAnyway && access.eyeDistance <= PLAUSIBLE_REACH) return null;

  const distance = access.eyeDistance.toFixed(1);
  const blocker = access.obstruction
    ? `${access.obstruction.name}(${access.obstruction.position.x}, ${access.obstruction.position.y}, ${access.obstruction.position.z})` : '何か';
  const protectedBlock = !!access.obstruction
    && (WORKSTATION_BLOCKS.has(access.obstruction.name) || PROTECTED_UTILITY_BLOCKS.has(access.obstruction.name));
  if (access.inReach) {
    return { success: false, failureType: 'line_of_sight_blocked', recoverable: true,
      result: `${where}は届く距離（目から${distance}m）ですが、視線が${blocker}に遮られています。周りに見える立ち位置も見つかりませんでした。`
        + (protectedBlock
          ? `${access.obstruction!.name}は壊しません。壁を1マス掘って立ち位置を作るか、${options.label}を見える所に置き直してください（place-block-at は見える所を自分で選びます）`
          : 'move-to で別の側から近づいてください') };
  }
  return { success: false, failureType: moved.failureType ?? 'distance_too_far', recoverable: true,
    result: `${where}に届く所まで近づけませんでした（目からの距離 ${distance}m、届くのは約${BLOCK_USE_REACH}m）: ${String(moved.result ?? '').slice(0, 120)}` };
}
