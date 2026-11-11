import { feetCell, type Cell } from '../localMap.js';
import { blockAt, cellText, eyeDistance, isAirLike, USE_REACH, wait, type StepContext } from './common.js';
import { bodyCells, place } from './place.js';

/**
 * stanch: a body held in a stream of flowing water stops the stream (the owner, run 5, 2026-11-11: "足元に水流があって延々と進めない … 足元にブロックを置いて
 * 流されないように"; 308 s of one run, the lake flowing into a tunnel her own dig had opened). Flowing water without a source dries in a few seconds, so
 * a cheap block laid in the cell the flow comes from ends it, and the cells under and round the feet become dry. A block in the feet's own cell cannot be
 * laid (the game puts none where a body stands), so the dam goes into a neighbour cell: the nearest one upstream. When there is none to lay at, the cell the way
 * goes on to is laid and stepped up onto. The route search reads water as still and finds a way a current does not let a body walk; this is what the body does then.
 */

/** Cells of water the search for the cell upstream goes through (nearest first). */
const RADIUS = 4;
/** How many cells are laid at most in one stanch, and how many are tried (a refusal costs a cell). */
const MAX_DAMS = 2;
const MAX_TRIES = 6;
/** How long the feet's water is watched after a dam (flowing water without a source is gone in 2-4 s). */
const DRY_WAIT_MS = 3000;
const DRY_EVERY_MS = 250;
/** The least time left (a place and a short watch) for a dam to be started. */
const MIN_LEFT_MS = 1500;

/** Cheap blocks that stay where they are put, the first held is the dam (never an ore, planks, a crafting block, sand or gravel). Plentiful junk first; cobblestone
 *  (the stuff of tools and a furnace) only when nothing else is held. */
const DAM_BLOCKS = ['dirt', 'coarse_dirt', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff', 'cobbled_deepslate', 'blackstone', 'basalt', 'smooth_basalt', 'calcite',
  'end_stone', 'terracotta', 'sandstone', 'red_sandstone', 'deepslate', 'stone', 'stone_bricks', 'nether_bricks', 'cobblestone'];

/** A water cell's level: 0 a source, 1-7 a flow (the larger, the further from its source), 8 and up water falling; null when the cell holds no water (or is not loaded). */
export function waterLevel(bot: any, cell: Cell | null): number | null {
  if (!cell) return null;
  const block = blockAt(bot, cell);
  if (!block || block.name !== 'water') return null;
  let level = 0;
  try { level = Number(block.getProperties?.()?.level ?? block.metadata ?? 0); } catch { level = Number(block.metadata ?? 0); }
  return Number.isFinite(level) ? level : 0;
}
/** True when the cell holds flowing water (a flow or a fall; not a source). */
export function flowingAt(bot: any, cell: Cell | null): boolean {
  const level = waterLevel(bot, cell);
  return level !== null && level > 0;
}

/** The first of the cheap blocks the pack holds, or null. */
export function damBlockHeld(bot: any): string | null {
  const held = new Map<string, number>();
  for (const item of (bot.inventory?.items?.() ?? []) as any[]) held.set(String(item?.name), (held.get(String(item?.name)) ?? 0) + Number(item?.count ?? 0));
  return DAM_BLOCKS.find(name => (held.get(name) ?? 0) >= 1) ?? null;
}

/** How many blocks of the cheap kinds the pack holds (what a wall of water can be sealed with). */
export function damBlocksHeld(bot: any): number {
  let total = 0;
  for (const item of (bot.inventory?.items?.() ?? []) as any[]) if (DAM_BLOCKS.includes(String(item?.name))) total += Number(item?.count ?? 0);
  return total;
}

const key = (cell: Cell) => `${cell.x},${cell.y},${cell.z}`;
const SIDES: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
/** A falling stream feeds like a source. */
const feeding = (level: number) => (level >= 8 ? 0 : level);

/**
 * The water cells the flow at `from` comes from, nearest first: a neighbour of a cell is upstream of it when its level is lower (a source is 0), or when water
 * lies above it (a fall feeds the cell under it). Looked for RADIUS cells out along those links only.
 */
export function upstreamCells(bot: any, from: Cell, radius = RADIUS): Cell[] {
  const seen = new Set([key(from)]);
  const found: Cell[] = [];
  let layer: Cell[] = [from];
  for (let step = 0; step < radius && layer.length; step++) {
    const next: Cell[] = [];
    for (const cell of layer) {
      const own = waterLevel(bot, cell);
      if (own === null) continue;
      const links: Array<[Cell, boolean]> = [[{ x: cell.x, y: cell.y + 1, z: cell.z }, true], ...SIDES.map(([dx, dy, dz]) => [{ x: cell.x + dx, y: cell.y + dy, z: cell.z + dz }, false] as [Cell, boolean])];
      for (const [candidate, above] of links) {
        if (seen.has(key(candidate))) continue;
        const level = waterLevel(bot, candidate);
        if (level === null) continue;
        if (!above && feeding(level) >= feeding(own)) continue;
        seen.add(key(candidate));
        found.push(candidate);
        next.push(candidate);
      }
    }
    layer = next;
  }
  return found;
}

export interface StanchResult {
  /** A block was laid (the caller draws its way again). */
  attempted: boolean;
  /** The water at the feet was gone after it. */
  stopped: boolean;
  /** The cell the last block was laid in. */
  at?: Cell;
  /** That cell lies on the way to the target: the body has closed its own way (the planner is told to go round or dig). */
  onRoute?: boolean;
  /** One short line for the act: what was laid and what came of it, or why nothing was (never above ~70 characters). */
  words: string;
}

/** The creature in a cell, if any (a dam is not laid on one). */
function occupied(bot: any, cell: Cell): boolean {
  for (const entity of Object.values(bot.entities ?? {}) as any[]) {
    if (!entity?.position || entity === bot.entity || entity.name === 'item' || entity.name === 'experience_orb' || entity.type === 'projectile') continue;
    if (Math.floor(entity.position.x) === cell.x && Math.floor(entity.position.z) === cell.z && Math.floor(entity.position.y) === cell.y) return true;
  }
  return false;
}

/**
 * Stops the stream the feet are in. Only with flowing water at the feet; a cheap block is laid (whatever the act's canPlace, the owner asked for it) in the nearest
 * cell upstream the hand reaches, up to MAX_DAMS, until the water at the feet is gone. With none to lay at, the next cell toward `toward` is laid when it is flowing
 * water over a solid floor with room above, to be stepped up onto. `attempted` is false (and the words say why) when nothing was laid.
 */
export async function stanchStream(ctx: StepContext, options: { toward?: Cell; deadline?: number } = {}): Promise<StanchResult> {
  const bot = ctx.bot;
  const none = (words: string): StanchResult => ({ attempted: false, stopped: false, words });
  const feet = feetCell(bot);
  if (!feet || !flowingAt(bot, feet)) return none('');
  const block = damBlockHeld(bot);
  if (!block) return none('流れは dirt か cobblestone を 1 個持てば止められる（上流のマスに置く）');
  // The caller's own limit (a go's `seconds`) counts as well as the act's: a dam never runs a go past what the head asked for.
  const limit = Math.min(ctx.deadline, options.deadline ?? Infinity);
  const toward = options.toward;
  const reaching = (cell: Cell) => (toward ? Math.hypot(cell.x - toward.x, cell.y - toward.y, cell.z - toward.z) : 0);
  const laid: Cell[] = [];
  const refused: string[] = [];
  let tries = 0, noTime = false, onRoute = false;
  while (laid.length < MAX_DAMS && tries < MAX_TRIES) {
    if (limit - Date.now() <= MIN_LEFT_MS) { noTime = true; break; }
    const own = bodyCells(bot.entity.position);
    const here = feetCell(bot) ?? feet;
    const open = upstreamCells(bot, here).filter(cell => !own.some(c => key(c) === key(cell)) && !occupied(bot, cell) && eyeDistance(bot, cell) <= USE_REACH && !refused.includes(key(cell)));
    // A cell off the way first: a block on the way would close it (a tunnel whose way on is upstream); only when every cell is on it is one of those laid.
    const ahead = (cell: Cell) => !!toward && reaching(cell) < reaching(here) - 0.5;
    const candidate = open.find(cell => !ahead(cell)) ?? open[0];
    if (!candidate) break;
    tries++;
    const out = await place(ctx, { block, at: [candidate] });
    if (!out.ok) { refused.push(key(candidate)); continue; }
    laid.push(candidate);
    onRoute = ahead(candidate);
    const from = Date.now();
    let dry = false;
    const until = Math.min(from + DRY_WAIT_MS, limit - 200);
    while (Date.now() < until) {
      if (!flowingAt(bot, feetCell(bot))) { dry = true; break; }
      await wait(ctx, DRY_EVERY_MS);
    }
    if (dry || !flowingAt(bot, feetCell(bot))) {
      const words = onRoute ? `流れを止めた: ${cellText(candidate)} に ${block}（上流・道の上）。そこは塞がった: 別の道か掘って`
        : `流れを止めた: ${cellText(candidate)} に ${block}（上流）。足元の水は ${((Date.now() - from) / 1000).toFixed(1)} 秒で消えた`;
      return { attempted: true, stopped: true, at: candidate, onRoute, words };
    }
  }
  if (laid.length) return { attempted: true, stopped: false, at: laid[laid.length - 1], onRoute, words: `上流に ${block} を ${laid.length} 個置いたが足元の水は止まらない（${cellText(laid[laid.length - 1]!)}）` };
  // No cell upstream to lay at: the cell the way goes on to is laid and stepped up onto (one deep, a floor under it).
  if (toward) {
    const dx = Math.sign(toward.x - feet.x), dz = Math.sign(toward.z - feet.z);
    const next = Math.abs(toward.x - feet.x) >= Math.abs(toward.z - feet.z) ? { x: feet.x + dx, y: feet.y, z: feet.z } : { x: feet.x, y: feet.y, z: feet.z + dz };
    if ((next.x !== feet.x || next.z !== feet.z) && flowingAt(bot, next) && blockAt(bot, { ...next, y: next.y - 1 })?.boundingBox === 'block'
      && [1, 2].every(up => { const above = blockAt(bot, { ...next, y: next.y + up }); return isAirLike(above) || above?.name === 'water'; }) && !occupied(bot, next)) {
      const out = await place(ctx, { block, at: [next] });
      if (out.ok) return { attempted: true, stopped: false, words: `流れの先 ${cellText(next)} に ${block} を置いた（上がって乾いた足場にする）` };
      refused.push(key(next));
    }
  }
  if (noTime) return none('流れを止める時間が足りない（seconds を長く）');
  return none(`流れを止める置き場が無い${refused.length ? `（${refused.length} マス試したが置けない）` : '（上流に届く固い面が無い）'}`);
}
