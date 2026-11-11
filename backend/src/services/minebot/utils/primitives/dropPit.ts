import { Vec3 } from 'vec3';
import { liquidNearPit, planDumpPit, type DumpPitPlan } from '../dumpPit.js';
import { noteSelfDropped, type DroppedLike } from '../selfDropped.js';
import { feetCell, type Cell } from '../localMap.js';
import { inventoryCount, wait, type StepContext, type StepOutcome } from './common.js';
import { dig } from './dig.js';
import { place } from './place.js';

/**
 * The drop's own place to throw: a hole two cells deep beside the body, dug, thrown into, and covered (run 7, 11/11: 36 drops, 33 landed within 3 m, ten heaps were thrown again after
 * the next walk picked them up, and one vertical stopped "full" with the heap it had just thrown under it). The level throw cannot promise a distance (a step or a slope puts it at the
 * feet whatever the free cells say); a thing at the bottom of a hole under a block cannot be picked up at all. The planner says what and how many; the hole, the throw, the cover and
 * the check are the body's. Two cells is out of a standing body's reach (1.8 m down; the pick-up reaches 0.75 below the feet) and costs two digs.
 */
export const PIT_DEPTH = 2;
/** What covers the hole again, in the order tried (a kind that is spare anyway). */
export const CAP_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'dirt', 'netherrack', 'deepslate', 'stone'];
/** A thrown stack needs this long to fall before the cover goes on, and is waited for this much longer at most. */
const FALL_MS = 800;
const FALL_MAX_MS = 1500;
/** Items this near the body (level) and within these heights of its feet are within its pick-up reach. */
const REACH_M = 1.8;
const REACH_BELOW = -1.2;
const REACH_ABOVE = 2.2;
/** The body is this far from a heap thrown level before it goes on (a thrown item waits 2 s, then the pick-up reaches 1.3 m round it). */
export const CLEAR_M = 3.5;

const isItem = (entity: any) => entity && (entity.name === 'item' || entity.displayName === 'Item');
const kindOf = (entity: any): string | null => { try { return entity?.getDroppedItem?.()?.name ?? null; } catch { return null; } };
const countOf = (entity: any): number => { try { return Math.max(1, Number(entity?.getDroppedItem?.()?.count ?? 1)); } catch { return 1; } };

export interface OpenedPit { plan: DumpPitPlan; lyingBefore: Set<number>; dug: number }

/**
 * Digs the hole beside the body. Never moves the body. A reason in words when there is none: liquid near, nowhere to stand or no column to dig, a dig that failed; `threat` when
 * an enemy sees the cells (the throw is left for later: throwing at the feet is the worse trade).
 */
export async function openDropPit(ctx: StepContext): Promise<OpenedPit | { reason: string; threat?: boolean; text?: string }> {
  const bot = ctx.bot;
  const feet = feetCell(bot);
  if (!feet || !bot.entity?.position) return { reason: '足元が読めない' };
  const at = new Vec3(feet.x, feet.y, feet.z);
  const liquid = liquidNearPit(bot, at);
  if (liquid) return { reason: `液体（${liquid}）が近い` };
  const plan = planDumpPit(bot, at, { depthBelowFeet: PIT_DEPTH });
  if (!plan) return { reason: '立てる床が無いか、掘れる列が無い（液体・落ちる砂利・岩盤・道具のブロック）' };
  let dug = 0;
  for (const cell of plan.dig) {
    const outcome = await dig(ctx, { at: [{ x: cell.x, y: cell.y, z: cell.z }], collect: false });
    if (!outcome.ok) {
      if (outcome.reason === 'threat_exposed') return { reason: '敵が近い', threat: true, text: outcome.text };
      return { reason: `穴を掘れなかった（${String(outcome.text).slice(0, 60)}）` };
    }
    dug++;
  }
  // What the digging dropped into the hole is not what is thrown: the throw is counted from here.
  const lyingBefore = new Set<number>(Object.values(bot.entities ?? {}).filter(isItem).map((entity: any) => entity.id));
  return { plan, lyingBefore, dug };
}

/** The point to look at to throw into the hole: its middle, 55 degrees down from the eyes (1.4 down for 1.0 across), so the throw falls in the middle whatever its random spread (lab 2026-10-20). */
export function pitLookPoint(plan: DumpPitPlan, eyeY: number): Vec3 {
  return new Vec3(plan.column.x + 0.5, eyeY - 1.43, plan.column.z + 0.5);
}

/**
 * The block that will cover the hole, from what is held and what is thrown: a kind that is not thrown, or one of which more is held than thrown. When none is spare, one of a thrown cover
 * kind is kept back (`reserve`: the drop throws one fewer of it). Null when no cover kind is held at all (the hole stays open and the line says so).
 */
export function chooseCap(bot: any, thrown: Map<string, number>): { block: string; reserve: boolean } | null {
  for (const block of CAP_BLOCKS) {
    const held = inventoryCount(bot, block);
    if (held > 0 && (held - (thrown.get(block) ?? 0)) >= 1) return { block, reserve: false };
  }
  for (const block of CAP_BLOCKS) if ((thrown.get(block) ?? 0) >= 1 && inventoryCount(bot, block) >= 1) return { block, reserve: true };
  return null;
}

/** What the hole holds and what lies in reach of the body, of the items that fell after `lyingBefore`: the stacks' counts. */
function tally(bot: any, plan: DumpPitPlan, lyingBefore: Set<number>): { inside: number; outside: number; entities: DroppedLike[]; names: Set<string> } {
  const here = bot.entity?.position;
  let inside = 0, outside = 0;
  const entities: DroppedLike[] = [], names = new Set<string>();
  for (const entity of Object.values(bot.entities ?? {}) as any[]) {
    if (!isItem(entity) || !entity.position || lyingBefore.has(entity.id)) continue;
    entities.push(entity);
    const name = kindOf(entity);
    if (name) names.add(name);
    const inPit = Math.abs(entity.position.x - (plan.column.x + 0.5)) < 0.9 && Math.abs(entity.position.z - (plan.column.z + 0.5)) < 0.9 && entity.position.y <= plan.column.feetY - 1.2;
    if (inPit) { inside += countOf(entity); continue; }
    if (here && Math.hypot(entity.position.x - here.x, entity.position.z - here.z) <= REACH_M && entity.position.y - here.y >= REACH_BELOW && entity.position.y - here.y <= REACH_ABOVE) outside += countOf(entity);
  }
  return { inside, outside, entities, names };
}

/**
 * After the throws: waits for the stacks to land in the hole, covers it, reads what lies where, and remembers the items as the body's own (no pick-up of its own looks at them).
 * `outside` is what lies within reach of the body and is not in the hole (a stack that bounced out): the caller walks away from it.
 */
export async function closeDropPit(ctx: StepContext, opened: OpenedPit, cap: { block: string; reserve: boolean } | null): Promise<{ words: string; outside: number; entities: DroppedLike[] }> {
  const bot = ctx.bot;
  const { plan, lyingBefore } = opened;
  await wait(ctx, FALL_MS);
  const until = Date.now() + (FALL_MAX_MS - FALL_MS);
  const aloft = () => Object.values(bot.entities ?? {}).some((entity: any) => isItem(entity) && entity.position && !lyingBefore.has(entity.id)
    && Math.abs(entity.position.x - (plan.column.x + 0.5)) < 2 && Math.abs(entity.position.z - (plan.column.z + 0.5)) < 2 && entity.position.y > plan.column.feetY - 1.2);
  while (aloft() && Date.now() < until) await wait(ctx, 100);
  const parts: string[] = [];
  if (plan.cap) {
    if (!cap) parts.push('ふたの石を持っていないので穴は開けたまま');
    else {
      const capped: StepOutcome = await place(ctx, { block: cap.block, at: [{ x: plan.cap.x, y: plan.cap.y, z: plan.cap.z }] });
      parts.push(capped.ok ? `${cap.block} でふたをした${cap.reserve ? '（最後の 1 個をふたに残した）' : ''}` : `ふたは置けなかった（${String(capped.text).slice(0, 50)}）。穴は開けたまま`);
    }
  }
  const seen = tally(bot, plan, lyingBefore);
  for (const name of seen.names) noteSelfDropped(bot, name, seen.entities.filter(entity => kindOf(entity) === name), Date.now(), true);
  parts.unshift(`穴の中 ${seen.inside} 個・手の届く所に ${seen.outside} 個`);
  return { words: parts.join('。'), outside: seen.outside, entities: seen.entities };
}

/**
 * Walks the body away from where the items lie, CLEAR_M or more (a throw level, or a stack that bounced out of the hole): one try, a short `go` that digs nothing and lays nothing.
 * Says how far it got. `from` are the cells the items lie in.
 */
export async function walkClear(ctx: StepContext, from: Array<{ x: number; y: number; z: number }>): Promise<{ words: string; clear: boolean }> {
  const bot = ctx.bot;
  const feet = feetCell(bot);
  const here = bot.entity?.position;
  if (!feet || !here || !from.length) return { words: '', clear: true };
  const distanceTo = (x: number, z: number) => Math.min(...from.map(item => Math.hypot(item.x + 0.5 - x, item.z + 0.5 - z)));
  if (distanceTo(here.x, here.z) >= CLEAR_M) return { words: '', clear: true };
  const stand = (x: number, y: number, z: number) => {
    const floor = bot.blockAt?.(new Vec3(x, y - 1, z), false), body = bot.blockAt?.(new Vec3(x, y, z), false), head = bot.blockAt?.(new Vec3(x, y + 1, z), false);
    return floor?.boundingBox === 'block' && body?.boundingBox === 'empty' && head?.boundingBox === 'empty' && !/lava|water/u.test(String(body?.name));
  };
  const spots: Array<{ cell: Cell; d: number }> = [];
  for (const distance of [5, 4, 6]) for (const [ux, uz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    const scale = ux && uz ? Math.SQRT1_2 : 1;
    const x = Math.floor(here.x + ux * distance * scale), z = Math.floor(here.z + uz * distance * scale);
    for (const dy of [0, 1, -1]) if (stand(x, feet.y + dy, z)) { spots.push({ cell: { x, y: feet.y + dy, z }, d: distanceTo(x + 0.5, z + 0.5) }); break; }
  }
  const best = spots.filter(spot => spot.d >= CLEAR_M).sort((a, b) => b.d - a.d)[0];
  if (!best) return { words: `離れられなかった（足元から ${distanceTo(here.x, here.z).toFixed(1)}m）`, clear: false };
  const { go } = await import('./go.js');
  const gone = await go(ctx, { goals: [best.cell], range: 1, canDig: undefined, maxDig: 0, canPlace: undefined, seconds: 8 });
  const now = bot.entity?.position;
  const apart = now ? distanceTo(now.x, now.z) : 0;
  return { words: gone.ok || apart >= CLEAR_M ? `${apart.toFixed(1)}m 離れた` : `離れられなかった（足元から ${apart.toFixed(1)}m）`, clear: apart >= CLEAR_M };
}
