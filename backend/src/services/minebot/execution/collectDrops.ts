import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import type { CustomBot } from '../types/CustomBot.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { assertActionActive, reportActionProgress } from './ActionExecution.js';
import { waitForObservation, type ObservationSource } from './observedWait.js';

const { goals } = pathfinder;
export type CollectionPolicy = 'target' | 'all';
export function inventoryCounts(bot: Pick<CustomBot, 'inventory'>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of bot.inventory.items()) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return counts;
}
export function inventoryIncrease(bot: Pick<CustomBot, 'inventory'>, before: Map<string, number>): string[] {
  return [...inventoryCounts(bot)].filter(([name, count]) => count > (before.get(name) ?? 0))
    .map(([name, count]) => `${name}x${count - (before.get(name) ?? 0)}`);
}
export function droppedItemName(bot: Pick<CustomBot, 'registry'>, entity: any): string | null {
  try {
    const item = entity.getDroppedItem?.();
    if (item?.name) return item.name;
    for (const metadata of entity.metadata ?? []) {
      const id = metadata?.itemId;
      if (typeof id === 'number' && bot.registry.items[id]) return bot.registry.items[id].name;
    }
  } catch { /* metadata can arrive after entitySpawn */ }
  return null;
}
export function expectedBlockDrops(bot: Pick<CustomBot, 'registry'>, block: any): string[] {
  const definition = bot.registry.blocksByName[block.name] as any;
  const names = (definition?.drops ?? []).flatMap((drop: any) => {
    const id = typeof drop === 'number' ? drop : drop.drop ?? drop.item;
    return bot.registry.items[id]?.name ? [bot.registry.items[id].name] : [];
  });
  if (bot.registry.itemsByName[block.name]) names.push(block.name);
  return [...new Set<string>(names)];
}
export function pickupGoal(bot: Pick<CustomBot, 'blockAt'>, position: Vec3) {
  const targetPosition = position.clone();
  const floor = targetPosition.floored();
  const support = bot.blockAt(floor);
  const y = support?.boundingBox === 'block' ? floor.y + 1 : floor.y;
  const goal = new goals.GoalNear(targetPosition.x, y, targetPosition.z, 0.5);
  // GoalNear rounds coordinates to a block. A one-node radius can therefore
  // stop >1.3 actual metres from edge loot and repeatedly "succeed" without
  // collecting. Judge the walking-cell centre against the real item position;
  // adjacent cells remain valid when they truly lie within pickup reach.
  const horizontalDistance = (node: { x: number; z: number }) =>
    Math.hypot(node.x + 0.5 - targetPosition.x, node.z + 0.5 - targetPosition.z);
  goal.isEnd = node => node.y === y && horizontalDistance(node) <= 1;
  goal.heuristic = node => Math.hypot(Math.max(0, horizontalDistance(node) - 1), node.y - y);
  return goal;
}

export async function collectDrops(bot: CustomBot, options: {
  origins: Vec3[];
  expectedItems: string[];
  beforeInventory: Map<string, number>;
  beforeEntityIds: Set<number>;
  policy?: CollectionPolicy;
  timeoutMs?: number;
  spawnWaitMs?: number;
  radius?: number;
}): Promise<string[]> {
  const policy = options.policy ?? 'target';
  const expected = new Set(options.expectedItems);
  const observedLoot = new Set<string>();
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  const sources = [
    ...['entitySpawn', 'entityGone', 'entityMoved', 'entityUpdate', 'playerCollect']
      .map(event => ({ source: bot as unknown as ObservationSource, event })),
    { source: bot.inventory as unknown as ObservationSource, event: 'updateSlot' },
  ];
  const relevant = (entity: any) => {
    if (entity.name !== 'item' || entity.isValid === false) return false;
    const originDistance = Math.min(...options.origins.map(origin => entity.position.distanceTo(origin)));
    if (originDistance > (options.radius ?? 10)) return false;
    if (policy === 'all') return true;
    const name = droppedItemName(bot, entity);
    if (name && expected.size > 0) return expected.has(name);
    // Unknown loot tables: only newly spawned, decoded drops at the dig site.
    // Never guess that an unrelated inventory increase fulfilled this action.
    return !!name && !options.beforeEntityIds.has(entity.id) && originDistance <= 2.5;
  };
  const candidates = () => Object.values(bot.entities).filter(relevant)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  const received = () => [...inventoryCounts(bot)].some(([name, count]) =>
    (expected.size === 0 || expected.has(name)) && count > (options.beforeInventory.get(name) ?? 0));
  reportActionProgress(bot, 'wait_drop', { expectedItems: [...expected], policy });
  // Inventory or visible loot can already be present: no unconditional wait.
  await waitForObservation(bot, () => received() || candidates().length > 0,
    Math.min(options.spawnWaitMs ?? 1200, Math.max(0, deadline - Date.now())), sources);
  for (let pass = 0; pass < 6 && Date.now() < deadline; pass++) {
    assertActionActive(bot);
    const item = candidates()[0];
    if (!item) break;
    const name = droppedItemName(bot, item);
    if (name) observedLoot.add(name);
    reportActionProgress(bot, 'pickup', { item: droppedItemName(bot, item), entityId: item.id,
      target: item.position.toArray(), pass, policy });
    const beforePass = inventoryCounts(bot);
    if (bot.entity.position.distanceTo(item.position) > 1.2) {
      const previousPosition = item.position.clone();
      const result = await gotoSafe(bot, pickupGoal(bot, item.position), {
        timeoutMs: Math.min(6500, Math.max(1, deadline - Date.now())), stuckAbortCount: 3,
      });
      assertActionActive(bot);
      reportActionProgress(bot, 'pickup', { entityId: item.id, movement: result });
      if (!result.success) {
        // Newly spawned drops can fall while a path is being computed. Retry
        // only with changed evidence, never repeat the same impossible goal.
        const changed = await waitForObservation(bot, () => received() || !bot.entities[item.id]
          || bot.entities[item.id].position.distanceTo(previousPosition) > 0.35,
          Math.min(350, Math.max(0, deadline - Date.now())), sources);
        if (changed && bot.entities[item.id] && !received()) continue;
        break;
      }
    }
    reportActionProgress(bot, 'confirm', { entityId: item.id, expectedItems: [...expected] });
    const changed = await waitForObservation(bot, () =>
      !bot.entities[item.id] || bot.entities[item.id].isValid === false
        || [...inventoryCounts(bot)].some(([name, count]) => count > (beforePass.get(name) ?? 0)),
      Math.min(900, Math.max(0, deadline - Date.now())), sources);
    // A disappeared entity is not proof of inventory receipt; account for late
    // slot updates without delaying a confirmed pickup.
    if (changed && !received()) await waitForObservation(bot, received,
      Math.min(400, Math.max(0, deadline - Date.now())), sources);
    if (!changed) {
      // Move all the way onto the walking node instead of repeatedly sleeping
      // outside the pickup radius. Partial solid surfaces use their upper node.
      const result = await gotoSafe(bot, pickupGoal(bot, item.position), {
        timeoutMs: Math.min(2500, Math.max(1, deadline - Date.now())), stuckAbortCount: 2,
      });
      if (!result.success) break;
    }
  }
  assertActionActive(bot);
  const eligibleNames = expected.size > 0 ? expected : observedLoot;
  const diff = inventoryIncrease(bot, options.beforeInventory).filter(entry =>
    policy === 'all' || [...eligibleNames].some(name => entry.startsWith(`${name}x`)));
  reportActionProgress(bot, 'confirm', { collected: diff, pendingDrops: candidates().length }, diff.length > 0);
  return diff;
}
