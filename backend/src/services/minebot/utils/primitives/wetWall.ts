import type { Cell } from '../localMap.js';
import { blockAt, eyeDistance, USE_REACH, type StepContext } from './common.js';
import { damBlockHeld, damBlocksHeld, waterLevel } from './stanch.js';
import { place } from './place.js';

/**
 * A wall that water stands behind (run 7, 11/11, 02:34: a go dug into a lake's wall, the lake ran into the hole, the body dug four cells under water and was carried 1.4 m, 97 s; the
 * dirt it had laid in the breach was dug out again by its own route). Water enters a dug cell from its four sides and its top, never from below: so the water cells touching the cell are
 * the ones to fill, and then the cell opens dry. This reads them (`wetFaces`), prices them for a route (`wetCost`: a dry way within a few steps is taken, otherwise the wall is sealed and
 * dug), seals them before the dig (`sealWetFaces`: a cheap block on each water cell, against the cell's own face) and writes the sealed cells down so a route does not dig its own plug out
 * (`sealedBreakCost`). The planner is not asked: it is the hand's own footing. What cannot be sealed (no block, out of reach, refused) is left and said.
 */
export interface WetFace { at: Cell; up: boolean; source: boolean }
export interface SealResult { sealed: Cell[]; left: WetFace[]; block: string | null; words: string }

const SIDES: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
/** In steps: a side face, the top one (a flood from above is harder to hold), and the extra when the pack holds fewer blocks than there are faces. */
export const WET_SIDE_COST = 4;
export const WET_UP_COST = 12;
export const WET_SHORT_COST = 40;
/** The most faces sealed for one cell, and the time each may take (a block laid took 0.5 to 1.1 s in run 7). */
const MAX_FACES = 4;
const FACE_MS = 1200;
/** A cell sealed is a plug for this long: a route digs it only when nothing else is open. */
export const SEALED_MS = 120_000;
export const SEALED_BREAK_COST = 100;

const key = (cell: Cell) => `${cell.x},${cell.y},${cell.z}`;

/** The water cells that would run into `cell` if it were dug: its four sides and its top. A cell the map cannot read is not water. */
export function wetFaces(bot: any, cell: Cell): WetFace[] {
  const faces: WetFace[] = [];
  const probe = (at: Cell, up: boolean) => {
    const level = waterLevel(bot, at);
    if (level !== null) faces.push({ at, up, source: level === 0 });
  };
  for (const [dx, dy, dz] of SIDES) probe({ x: cell.x + dx, y: cell.y + dy, z: cell.z + dz }, false);
  probe({ x: cell.x, y: cell.y + 1, z: cell.z }, true);
  return faces;
}

/** The price of digging `cell` for a route, in steps: nothing dry costs 0. */
export function wetCost(bot: any, cell: Cell): number {
  const faces = wetFaces(bot, cell);
  if (!faces.length) return 0;
  const held = damBlocksHeld(bot);
  return faces.reduce((sum, face) => sum + (face.up ? WET_UP_COST : WET_SIDE_COST), 0) + (held < faces.length ? WET_SHORT_COST : 0);
}

type SealedBody = { sealedCells?: Map<string, number> };
export const noteSealed = (bot: any, cell: Cell, now = Date.now()) => {
  const body = bot as SealedBody;
  (body.sealedCells ??= new Map()).set(key(cell), now);
  if (body.sealedCells.size > 256) for (const [at, when] of body.sealedCells) if (now - when > SEALED_MS) body.sealedCells.delete(at);
};
export const sealedAt = (bot: any, cell: Cell, now = Date.now()): boolean => {
  const when = (bot as SealedBody).sealedCells?.get(key(cell));
  return when !== undefined && now - when <= SEALED_MS;
};
/** For the navigator: a cell the body sealed itself costs a hundred to dig out again (not a refusal: with no other way it is dug, after the water behind it is sealed anew). */
export function sealedBreakCost(bot: unknown): (block: { position?: Cell }) => number {
  return block => block?.position && sealedAt(bot, block.position) ? SEALED_BREAK_COST : 0;
}

/** For the navigator: what the wall costs to dig (wetCost), kept two seconds (a search asks about the same cells many times over, and water moves slowly). */
export function wetBreakCost(bot: unknown): (block: { position?: Cell }) => number {
  const cache = new Map<string, number>();
  let at = 0;
  return block => {
    const p = block?.position;
    if (!p) return 0;
    const now = Date.now();
    if (now - at > 2000) { cache.clear(); at = now; }
    const k = key(p);
    let cost = cache.get(k);
    if (cost === undefined) { try { cost = wetCost(bot, { x: p.x, y: p.y, z: p.z }); } catch { cost = 0; } cache.set(k, cost); }
    return cost;
  };
}

/**
 * Seals the water cells touching `cell` before it is dug: a cheap block laid on each, nearest to the eyes first (at most MAX_FACES, FACE_MS each, nothing beyond the hand's own time).
 * A face the hand cannot reach, a refused place or no block held is left (`left`) and said. The cell itself is written down as sealed when all its faces held.
 */
export async function sealWetFaces(ctx: StepContext, cell: Cell): Promise<SealResult> {
  const bot = ctx.bot;
  const faces = wetFaces(bot, cell);
  if (!faces.length) return { sealed: [], left: [], block: null, words: '' };
  const block = damBlockHeld(bot);
  const left: WetFace[] = [];
  const sealed: Cell[] = [];
  if (!block) {
    return { sealed, left: faces, block: null, words: `裏の水 ${faces.length} マス${faces.some(face => face.up) ? `（上 ${faces.filter(face => face.up).length}）` : ''}。dirt か cobblestone を ${faces.length} 個持てば体が塞いで掘る` };
  }
  const ordered = [...faces].sort((a, b) => eyeDistance(bot, a.at) - eyeDistance(bot, b.at));
  for (const face of ordered) {
    if (sealed.length >= MAX_FACES || Date.now() >= ctx.deadline - FACE_MS || eyeDistance(bot, face.at) > USE_REACH || !damBlockHeld(bot)) { left.push(face); continue; }
    const out = await place(ctx, { block: damBlockHeld(bot) ?? block, at: [face.at] });
    if (out.ok && blockAt(bot, face.at)?.name !== 'water') { sealed.push(face.at); noteSealed(bot, face.at); } else left.push(face);
  }
  if (!left.length) noteSealed(bot, cell);
  const up = faces.filter(face => face.up).length;
  const words = left.length
    ? `裏の水 ${faces.length} マス${up ? `（上 ${up}）` : ''}。${block} で ${sealed.length} 面塞ぎ ${left.length} 面残した`
    : `裏の水 ${faces.length} マスを ${block} で塞いでから掘った`;
  return { sealed, left, block, words };
}
