import pathfinder from 'mineflayer-pathfinder';
import { buildMovements } from '../setMovements.js';
import { feetCell } from '../localMap.js';
import { isSelfDropped } from '../selfDropped.js';
import { freeSlots, guard, letGo, packLine, stopped, StepStopped, wait, type StepContext, type StepOutcome } from './common.js';

const { goals } = pathfinder;

/**
 * pickup: walk to dropped items and take them (design mb-llm-centric 2.3). By id, or every item within a radius, nearest first. The walk
 * neither digs nor lays (as walk). What is gained is counted from the pack, not assumed.
 */
export interface PickupArgs { radius?: number; ids?: number[] }

const DEFAULT_RADIUS = 6;
const MAX_RADIUS = 16;
const ITEM_WAIT_MS = 2500;

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
  navigator?.setMovements(buildMovements(bot, false, true, true, true, false, true, 1, false, true, 3, 10, false));
  const missed: string[] = [];
  try {
    for (const entity of targets.slice(0, 16)) {
      if (!bot.entities?.[entity.id]) continue;
      if (freeSlots(bot) === 0) { missed.push(`${droppedName(bot, entity)}（持ち物が満杯）`); break; }
      const name = droppedName(bot, entity);
      const goal = new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 0.5);
      try {
        const done = await guard(ctx, Promise.resolve(navigator.goto(goal)), Math.min(10_000, Math.max(500, ctx.deadline - Date.now())));
        if (!done) { letGo(bot); missed.push(`${name}（時間切れ）`); continue; }
      } catch (error) {
        if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) { letGo(bot); throw error; }
        if (!bot.entities?.[entity.id]) continue; // taken on the way
        missed.push(`${name} (${Math.floor(entity.position.x)},${Math.floor(entity.position.y)},${Math.floor(entity.position.z)})（掘らない道が無い）`);
        continue;
      }
      for (const until = Date.now() + ITEM_WAIT_MS; Date.now() < until && bot.entities?.[entity.id];) await wait(ctx, 100);
      if (bot.entities?.[entity.id]) missed.push(`${name}（拾えなかった）`);
    }
  } finally { try { if (previous) navigator.setMovements(previous); } catch { /* kept */ } }
  const gained: string[] = [];
  const after = new Map<string, number>();
  for (const item of bot.inventory?.items?.() ?? []) after.set(item.name, (after.get(item.name) ?? 0) + item.count);
  for (const [name, count] of after) { const diff = count - (before.get(name) ?? 0); if (diff > 0) gained.push(`${name}+${diff}`); }
  const text = `拾った: ${gained.join(' ') || 'なし'}${missed.length ? `。拾えなかった: ${missed.join('、')}` : ''}`;
  if (!gained.length && missed.length) return stopped(bot, freeSlots(bot) === 0 ? 'inventory_full' : 'not_picked', `${text}（持ち物 ${packLine(bot).length > 200 ? `空き${freeSlots(bot)}枠` : packLine(bot)}）`, feetCell(bot)!);
  return { ok: true, text };
}
