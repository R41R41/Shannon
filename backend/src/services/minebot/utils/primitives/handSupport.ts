import { bodyReader, isOpenBlock, type BlockReader, type Cell, type MapBlock } from '../localMap.js';
import { isLava, isWater, NO_ENTER, standable } from '../walkRules.js';
import { cellText, DIRECTIONS, inventoryCount, type StepContext } from './common.js';
import { walk } from './walk.js';
import type { StepOutcome } from './common.js';

/**
 * What the hands that take a range from the planner (obsidian, portal) share (contract hands-contract.md, 2026-10-26): the planner decides
 * what, where and how far; the body works out the seconds-fine moves. A hand never looks for a thing beyond the cells it was given (the lava
 * sources, the frame's place) and keeps to a limit it reports. These are the small parts of that: where a body may stand, whether the eye
 * reaches a face, and the ray the game's server walks to find the face a click lands on.
 */

export type Face = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';
export const FACES: readonly Face[] = ['down', 'up', 'north', 'south', 'west', 'east'];
export const OPPOSITE: Record<Face, Face> = { up: 'down', down: 'up', north: 'south', south: 'north', east: 'west', west: 'east' };

/** A bucket's click is a ray of 4.5 from the eye (the game's block interaction range): the cells it is aimed at are asked inside 4.3. */
export const BUCKET_REACH = 4.3;
/** A block is put in a cell the eye is this far from at most (place allows 5.0; the margin is for a server a tick behind). */
export const PLACE_REACH = 4.6;
/** A dig is started when the eye is this far from the block (dig stops at 5.0). */
export const DIG_REACH_PLAN = 4.8;
export const EYE = 1.62;

export const keyOf = (cell: Cell) => `${cell.x},${cell.y},${cell.z}`;
export const sameCell = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y && a.z === b.z;
export const shift = (cell: Cell, face: Face): Cell => {
  const [dx, dy, dz] = DIRECTIONS[face];
  return { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz };
};
export const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
export const isAirBlock = (block: MapBlock | null): boolean => !!block && AIR_NAMES.has(block.name);
/** A cell a block or water may be put in without anything being broken: air, or a plant or snow layer the game replaces. */
export const isOpenCell = (block: MapBlock | null): boolean => !!block && (AIR_NAMES.has(block.name) || (isOpenBlock(block) && block.solid !== true));
export const isSolid = (block: MapBlock | null): boolean => !!block && block.solid === true;
export const isWaterSource = (block: MapBlock | null): boolean => !!block && block.name === 'water' && (block.level ?? 0) === 0;
export const isLavaSource = (block: MapBlock | null): boolean => !!block && block.name === 'lava' && (block.level ?? 0) === 0;
export const isFire = (block: MapBlock | null): boolean => !!block && (block.name === 'fire' || block.name === 'soul_fire');

export const readerOf = (bot: any): BlockReader => bodyReader(bot);
export const eyeAtCell = (cell: Cell): [number, number, number] => [cell.x + 0.5, cell.y + EYE, cell.z + 0.5];
/** The distance from the eye of a body standing in `stand` to the middle of `cell`. */
export const eyeTo = (stand: Cell, cell: Cell): number => Math.hypot(stand.x - cell.x, stand.y + EYE - (cell.y + 0.5), stand.z - cell.z);

/** The cell the first solid block (or, with `fluid`, the first source of water or lava) on the straight line from `from` to `to` lies in, with the face the line enters it by. */
export interface RayHit { cell: Cell; face: Face; name: string; fluid: boolean }
export function rayFirst(read: BlockReader, from: [number, number, number], to: [number, number, number], fluid = false): RayHit | null {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  let x = Math.floor(from[0]), y = Math.floor(from[1]), z = Math.floor(from[2]);
  const stepX = Math.sign(dx), stepY = Math.sign(dy), stepZ = Math.sign(dz);
  const big = Number.POSITIVE_INFINITY;
  const tDeltaX = dx === 0 ? big : Math.abs(1 / dx), tDeltaY = dy === 0 ? big : Math.abs(1 / dy), tDeltaZ = dz === 0 ? big : Math.abs(1 / dz);
  let tMaxX = dx === 0 ? big : (stepX > 0 ? x + 1 - from[0] : from[0] - x) * tDeltaX;
  let tMaxY = dy === 0 ? big : (stepY > 0 ? y + 1 - from[1] : from[1] - y) * tDeltaY;
  let tMaxZ = dz === 0 ? big : (stepZ > 0 ? z + 1 - from[2] : from[2] - z) * tDeltaZ;
  // The cell the eye is in is never a hit (the eye is in open air or water).
  for (let guard = 0; guard < 256; guard++) {
    let face: Face;
    let t: number;
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) { t = tMaxX; x += stepX; tMaxX += tDeltaX; face = stepX > 0 ? 'west' : 'east'; }
    else if (tMaxY <= tMaxZ) { t = tMaxY; y += stepY; tMaxY += tDeltaY; face = stepY > 0 ? 'down' : 'up'; }
    else { t = tMaxZ; z += stepZ; tMaxZ += tDeltaZ; face = stepZ > 0 ? 'north' : 'south'; }
    if (t > 1) return null;
    const block = read(x, y, z);
    if (!block) return { cell: { x, y, z }, face, name: '未ロード', fluid: false };
    if (isSolid(block)) return { cell: { x, y, z }, face, name: block.name, fluid: false };
    if (fluid && (block.name === 'water' || block.name === 'lava') && (block.level ?? 0) === 0) return { cell: { x, y, z }, face, name: block.name, fluid: true };
  }
  return null;
}

/** The point on a block's face a click is aimed at: the face's middle, a hair inside the block so the line certainly enters by that face. */
export function facePoint(cell: Cell, face: Face, inside = 0.01): [number, number, number] {
  const [dx, dy, dz] = DIRECTIONS[face];
  return [cell.x + 0.5 + dx * (0.5 - inside), cell.y + 0.5 + dy * (0.5 - inside), cell.z + 0.5 + dz * (0.5 - inside)];
}

/** Whether a click from an eye at `eye` on the `face` of `ref` lands on that face: within `reach`, and nothing solid in front of it. */
export function clickLands(read: BlockReader, eye: [number, number, number], ref: Cell, face: Face, reach = BUCKET_REACH): boolean {
  const point = facePoint(ref, face);
  if (Math.hypot(point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]) > reach) return false;
  const hit = rayFirst(read, eye, point);
  return !!hit && sameCell(hit.cell, ref) && hit.face === face;
}

/** What is wrong with a cell as a place to stand (lava, fire or a hurting block round the body), or null. The rim of a pool (lava a cell down and aside) is fine. */
export function standHazard(read: BlockReader, stand: Cell): string | null {
  for (let dy = 0; dy <= 2; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const cell = { x: stand.x + dx, y: stand.y + dy, z: stand.z + dz };
    const block = read(cell.x, cell.y, cell.z);
    if (block && (isLava(block) || isFire(block))) return `${cellText(cell)} が ${block.name}`;
  }
  const under = read(stand.x, stand.y - 1, stand.z);
  if (under && NO_ENTER.has(under.name)) return `足の下 ${cellText({ ...stand, y: stand.y - 1 })} が ${under.name}`;
  return null;
}
/**
 * A cell the body can stand in, out of the water, with nothing that hurts round it. `waterOk`: a shallow flow (not a source, the head clear, a solid floor
 * under it) is stood in too (where the water has run over the ground round a pool).
 */
export function standOk(read: BlockReader, stand: Cell, waterOk = false, ignoreHazard = false): boolean {
  if (!standable(read, stand.x, stand.y, stand.z)) return false;
  const feet = read(stand.x, stand.y, stand.z);
  if (!feet) return false;
  if (isWater(feet)) {
    if (!waterOk || (feet.level ?? 0) === 0 || (feet.level ?? 0) >= 8 || isWater(read(stand.x, stand.y + 1, stand.z)) || !isSolid(read(stand.x, stand.y - 1, stand.z))) return false;
  }
  return ignoreHazard || standHazard(read, stand) === null;
}

/** A context with a limit of its own (never past the act's): what `seconds` of a hand means. */
export function limitedContext(ctx: StepContext, seconds: number): StepContext {
  return { ...ctx, deadline: Math.min(ctx.deadline, Date.now() + seconds * 1000) };
}
export const timeIsUp = (ctx: StepContext): boolean => Date.now() >= ctx.deadline;

/** Walks the feet to `stand` unless they are there: null when the body is there, else the walk's stop (to be tried with another place). */
export async function moveTo(ctx: StepContext, stand: Cell): Promise<StepOutcome | null> {
  const bot = ctx.bot;
  const position = bot.entity?.position;
  if (position && Math.floor(position.x) === stand.x && Math.floor(position.z) === stand.z && Math.abs(position.y - stand.y) < 0.2 && bot.entity.onGround !== false) return null;
  const outcome = await walk(ctx, { to: stand, range: 0, sprint: false });
  return outcome.ok ? null : outcome;
}


export const dist = (a: Cell, b: Cell) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The cells a body can stand in within `radius` of `centre`, from `yFrom` to `yTo`, with nothing that hurts round them. */
export function standCells(read: BlockReader, centre: Cell, radius: number, yFrom: number, yTo: number, waterOk = false, ignoreHazard = false): Cell[] {
  const out: Cell[] = [];
  for (let x = centre.x - radius; x <= centre.x + radius; x++) for (let z = centre.z - radius; z <= centre.z + radius; z++) for (let y = yFrom; y <= yTo; y++) {
    if (standOk(read, { x, y, z }, waterOk, ignoreHazard)) out.push({ x, y, z });
  }
  return out;
}

/** Blocks that fall when what holds them is gone: never laid as a footing or a scaffold. */
const FALLING = /^(?:sand|red_sand|gravel|suspicious_sand|suspicious_gravel|anvil|chipped_anvil|damaged_anvil|dragon_egg|.*_concrete_powder)$/u;
/** The block the planner allowed (canPlace) that the pack holds most of, for a footing or a scaffold; never the precious ones named in `except`. */
export const footingBlock = (bot: any, names: string[] | undefined, except: string[] = ['obsidian', 'crying_obsidian']): string | null =>
  (names ?? []).filter(name => !except.includes(name) && !FALLING.test(name) && inventoryCount(bot, name) > 0)
    .sort((a, b) => inventoryCount(bot, b) - inventoryCount(bot, a))[0] ?? null;
