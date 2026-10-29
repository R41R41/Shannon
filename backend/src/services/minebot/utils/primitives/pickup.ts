import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { bodyReader, feetCell, relativeWords, type Cell } from '../localMap.js';
import { isSelfDropped } from '../selfDropped.js';
import { solidBetween } from '../probeTools.js';
import { cellText, freeSlots, letGo, packLine, stopped, wait, type StepContext, type StepOutcome } from './common.js';
import { goWith, walkMovements, wayWords, whyBlocked, type WayNotes } from './walk.js';

const { goals } = pathfinder;

/**
 * pickup: walk to dropped items and take them (design mb-llm-centric 2.3). By id, or every item within a radius, nearest first. The walk is
 * the walk's (no dig, no block laid; doors opened, leaves broken). What is gained is counted from the pack, not assumed. An item not taken
 * is said with where it lies, where it is from the body, how far, and what stands between (r5: run 28's 19 "拾えなかった" said none of it).
 */
export interface PickupArgs { radius?: number; ids?: number[] }

const DEFAULT_RADIUS = 6;
const MAX_RADIUS = 16;
const ITEM_WAIT_MS = 2500;
/** The longest a drop still in the air is waited for to come to rest before the hand walks to it or waits for it. */
const SETTLE_MS = 1500;
/** A body takes an item its box, grown by 1 across and 0.5 up and down, touches (the item's own box is 0.25 wide). */
const TAKE_ACROSS = 1.3 + 0.125;
const TAKE_BELOW = 0.5 + 0.25;
const TAKE_ABOVE = 1.8 + 0.5;

function droppedName(bot: any, entity: any): string {
  try {
    const item = entity.getDroppedItem?.();
    if (item?.name) return String(item.name);
  } catch { /* by its id below */ }
  const meta = Array.isArray(entity.metadata) ? entity.metadata.find((value: any) => value && typeof value === 'object' && ('itemId' in value || 'blockId' in value)) : null;
  const id = meta?.itemId ?? meta?.blockId;
  return typeof id === 'number' ? String(bot.registry?.items?.[id]?.name ?? 'item') : 'item';
}

export function itemEntitiesNear(bot: any, radius: number): any[] {
  const at = bot.entity?.position;
  if (!at) return [];
  return Object.values(bot.entities ?? {}).filter((entity: any) => entity?.position && (entity.name === 'item' || entity.displayName === 'Item')
    && entity.position.distanceTo(at) <= radius).sort((a: any, b: any) => a.position.distanceTo(at) - b.position.distanceTo(at));
}

/** Whether the body's box would take an item at `item` now. */
export function withinTake(body: { x: number; y: number; z: number }, item: { x: number; y: number; z: number }): boolean {
  return Math.abs(item.x - body.x) <= TAKE_ACROSS && Math.abs(item.z - body.z) <= TAKE_ACROSS && item.y >= body.y - TAKE_BELOW && item.y <= body.y + TAKE_ABOVE;
}

/**
 * Where an item lies from the body, as facts: its cell, the way from the feet, the distance, whether the body's box takes it, and the solid
 * cells between the body's middle and it.
 */
export function itemFacts(bot: any, position: { x: number; y: number; z: number }): string {
  const body = bot.entity?.position;
  const cell: Cell = { x: Math.floor(position.x), y: Math.floor(position.y + 1e-3), z: Math.floor(position.z) };
  const feet = feetCell(bot);
  if (!body || !feet) return cellText(cell);
  const distance = Math.hypot(position.x - body.x, position.y - body.y, position.z - body.z);
  const facts = [`${cellText(cell)} 自分から${relativeWords(feet, cell)}・${distance.toFixed(1)}m`];
  if (!withinTake(body, position)) facts.push('拾える所（体から横 1.4m・上 2.3m・下 0.7m）に無い');
  let between: Cell[] = [];
  try { between = solidBetween(bodyReader(bot), [body.x, body.y + 0.9, body.z], [position.x, position.y + 0.125, position.z]); } catch { between = [];}
  if (between.length) {
    const read = bodyReader(bot);
    facts.push(`間に ${between.slice(0, 2).map(c => `${cellText(c)} ${read(c.x, c.y, c.z)?.name ?? '未ロード'}`).join('、')}${between.length > 2 ? ' ほか' : ''}`);
  }
  return facts.join('、');
}

export async function pickup(ctx: StepContext, args: PickupArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const radius = Math.min(MAX_RADIUS, Math.max(1, args.radius ?? DEFAULT_RADIUS));
  const wanted = args.ids?.length ? new Set(args.ids) : null;
  // What the body threw away itself is not picked up again by a radius (by id it is: the planner asked for that one).
  const targets = (wanted ? Object.values(bot.entities ?? {}).filter((entity: any) => entity && wanted.has(entity.id))
    : itemEntitiesNear(bot, radius).filter(entity => !isSelfDropped(bot, entity))) as any[];
  if (!targets.length) return { ok: true, text: `半径${radius}m に落とし物は無い` };
  const before = new Map<string, number>();
  for (const item of bot.inventory?.items?.() ?? []) before.set(item.name, (before.get(item.name) ?? 0) + item.count);
  const navigator = bot.pathfinder;
  const previous = navigator?.movements;
  navigator?.setMovements(walkMovements(bot, true));
  const missed: string[] = [];
  const notes: WayNotes = { opened: [], leaves: 0 };
  try {
    for (const entity of targets.slice(0, 16)) {
      if (!bot.entities?.[entity.id]) continue;
      if (freeSlots(bot) === 0) { missed.push(`${droppedName(bot, entity)}（持ち物が満杯）`); break; }
      const name = droppedName(bot, entity);
      const where = () => ({ x: entity.position.x, y: entity.position.y, z: entity.position.z });
      // A drop just thrown out is still in the air (the last drop of a mine: it showed beside the body and bounced 1.3-2 m off while the hand
      // waited for it where it first showed, 1 run in 4 of the hands check): it is let come to rest before the hand decides to walk or wait.
      for (let still = 0, until = Date.now() + SETTLE_MS, last = where(); Date.now() < until && still < 2 && bot.entities?.[entity.id];) {
        await wait(ctx, 100);
        const now = where();
        still = Math.hypot(now.x - last.x, now.y - last.y, now.z - last.z) < 0.03 ? still + 1 : 0;
        last = now;
      }
      if (!bot.entities?.[entity.id]) continue; // taken while it fell
      let unreachable = false;
      // Walked to where it lies and waited for it; once more where it lies then, if it rolled on meanwhile.
      for (let attempt = 0; attempt < 2 && bot.entities?.[entity.id] && !unreachable; attempt++) {
        if (!withinTake(bot.entity.position, where())) {
          // Run 47 (hold 1): a drop whose coordinates lie inside a block (a wall's, the top of a fence: it clips into the shape) cannot be stood in; the body goes where its box takes it from.
          const itemCell = { x: Math.floor(entity.position.x), y: Math.floor(entity.position.y + 1e-3), z: Math.floor(entity.position.z) };
          let inBlock = false;
          try { inBlock = bot.blockAt?.(new Vec3(itemCell.x, itemCell.y, itemCell.z), false)?.boundingBox === 'block'; } catch { inBlock = false; }
          const goal = new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, inBlock ? Math.max(0.5, TAKE_ACROSS - 0.15) : 0.5);
          const gone = await goWith(ctx, goal, Math.min(10_000, Math.max(500, ctx.deadline - Date.now())), notes);
          if (!bot.entities?.[entity.id]) break; // taken on the way
          if (gone.timedOut || gone.stuck || gone.error || !gone.reached) {
            letGo(bot);
            const item = where(), cell = { x: Math.floor(item.x), y: Math.floor(item.y + 1e-3), z: Math.floor(item.z) };
            const here = feetCell(bot)!;
            const blocked = whyBlocked(bot, here, cell);
            const why = gone.timedOut ? '時間切れ' : gone.stuck ? '4秒進めず' : /no path/iu.test(String((gone.error as Error)?.message)) ? '掘らない道が無い' : 'そこまで着けない';
            if (!withinTake(bot.entity.position, item)) { missed.push(`${name}（${why}。${itemFacts(bot, item)}${blocked ? `。${blocked.text}` : ''}）`); unreachable = true; break; }
          }
        }
        for (const until = Date.now() + ITEM_WAIT_MS; Date.now() < until && bot.entities?.[entity.id];) await wait(ctx, 100);
      }
      if (unreachable) continue;
      if (bot.entities?.[entity.id]) {
        const item = where();
        missed.push(`${name}（${withinTake(bot.entity.position, item) ? `拾える所にあるのに ${ITEM_WAIT_MS / 1000} 秒で入らなかった。` : ''}${itemFacts(bot, item)}）`);
      }
    }
  } finally { try { if (previous) navigator.setMovements(previous); } catch { /* kept */ } }
  const gained: string[] = [];
  let gotCount = 0;
  const after = new Map<string, number>();
  for (const item of bot.inventory?.items?.() ?? []) after.set(item.name, (after.get(item.name) ?? 0) + item.count);
  for (const [name, count] of after) { const diff = count - (before.get(name) ?? 0); if (diff > 0) { gained.push(`${name}+${diff}`); gotCount += diff; } }
  const way = wayWords(notes);
  const text = `拾った: ${gained.join(' ') || 'なし'}${missed.length ? `。拾えなかった: ${missed.join('、')}` : ''}${way ? `（途中で${way}）` : ''}`;
  // Continue contracts (1): progress in items (the items the pack gained, counted from the pack; what was left lying is in the text).
  const progress = { unit: 'item' as const, done: gotCount, left: null };
  if (!gained.length && missed.length) return { ...stopped(bot, freeSlots(bot) === 0 ? 'inventory_full' : 'not_picked', `${text}（持ち物 ${packLine(bot).length > 200 ? `空き${freeSlots(bot)}枠` : packLine(bot)}）`, feetCell(bot)!), progress };
  return { ok: true, text, progress };
}
