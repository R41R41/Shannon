import type { CustomBot } from '../types.js';

/** LLM / ツール結果用の満杯時リカバリ（他スキルと文言を揃える） */
/**
 * What to do about a full pack, as the choices there are. It used to be an order: never drop anything, always
 * put it in a chest or barrel under the open sky. A body with seven stacks of stone it had no use for, deep
 * in a cave, could then neither mine nor drop: it crafted a chest it could not place and built walls to be
 * rid of granite (paid runs L64, L74). What is worth keeping is the planner's to judge.
 */
export const INVENTORY_FULL_RECOVERY_HINT_JA =
  '空きを作る方法は2つ: (a) 要らない物（余った丸石・安山岩・土など）は drop-item で捨てる。(b) 残したい物はチェストか樽に預ける（deposit-to-container。収納は地上＝天光の届く場所に置いたものだけ使える。無ければ craft-one(chest) と place-block-at で置く）。地上に落ちたアイテムは pickup-nearest-item で回収できる。';

export function countItemInInventory(bot: CustomBot, itemName: string): number {
  return bot.inventory
    .items()
    .filter((i: { name: string; count: number }) => i.name === itemName)
    .reduce((sum, i) => sum + i.count, 0);
}

export function inventoryNoEmptySlots(bot: CustomBot): boolean {
  return typeof bot.inventory.emptySlotCount === 'function' && bot.inventory.emptySlotCount() === 0;
}

/** 空きがこの数以下になったら満杯を待たずに預ける（mine-block 等が参照） */
export const DEPOSIT_BEFORE_EMPTY_SLOTS_FALLS_TO = 5;

export function emptySlotCountSafe(bot: CustomBot): number {
  if (typeof bot.inventory.emptySlotCount !== 'function') return 999;
  return bot.inventory.emptySlotCount();
}

/**
 * 採掘などを続けると溢れやすいとき true。
 * 空きが閾値以下かつ「まだ掘りたい個数」が空きスロット数より多いときに預けを促す。
 */
export function shouldPauseMiningForDeposit(bot: CustomBot, remainingToMine: number, dropNames: string[] = []): boolean {
  const empty = emptySlotCountSafe(bot);
  if (empty <= 0) return true;
  if (remainingToMine <= 0) return false;
  if (empty > DEPOSIT_BEFORE_EMPTY_SLOTS_FALLS_TO) return false;
  // What the drops fill, in slots, when their kinds are known: ten obsidian take one slot, not ten. Blocks against slots refused a
  // ladder probe (2026-10-20) ten obsidian with five slots free, eleven times over.
  if (dropNames.length) return empty < slotsForDrops(bot, remainingToMine, dropNames);
  return remainingToMine > empty;
}

/** The most one block gives of the kinds that drop several (fortune aside). */
const DROPS_PER_BLOCK: Record<string, number> = {
  lapis_lazuli: 9, redstone: 5, raw_copper: 5, gold_nugget: 6, glowstone_dust: 4, clay_ball: 4, amethyst_shard: 4, melon_slice: 7,
};

/**
 * Slots `blocks` more blocks can fill: each kind they drop as if all of them dropped it (gravel: gravel and flint), the room left in
 * the stacks already held taken first, and one slot more for what the walk to them digs on the way.
 */
export function slotsForDrops(bot: CustomBot, blocks: number, dropNames: string[]): number {
  const items = bot.inventory.items() as Array<{ name: string; count: number; stackSize?: number }>;
  const registry = (bot as any).registry?.itemsByName ?? {};
  let slots = 1;
  for (const name of new Set(dropNames)) {
    const stackSize = Math.max(1, Number(registry[name]?.stackSize ?? items.find(item => item.name === name)?.stackSize ?? 64));
    const room = items.filter(item => item.name === name).reduce((sum, item) => sum + Math.max(0, stackSize - item.count), 0);
    slots += Math.max(0, Math.ceil((blocks * (DROPS_PER_BLOCK[name] ?? 1) - room) / stackSize));
  }
  return slots;
}

export function getItemNameFromEntity(entity: any, mcData: any): string | null {
  try {
    const metadata = entity.metadata;
    if (!metadata) return null;
    for (let i = 7; i <= 9; i++) {
      const itemData = metadata[i];
      if (itemData && typeof itemData === 'object' && 'itemId' in itemData) {
        const itemId = (itemData as { itemId: number }).itemId;
        const it = mcData.items[itemId];
        if (it) return it.name;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function hasNearbyDroppedItemNamed(
  bot: CustomBot,
  mcData: any,
  itemName: string,
  maxDist: number,
): boolean {
  const botPos = bot.entity.position;
  for (const entity of Object.values(bot.entities) as any[]) {
    if (!entity || entity.name !== 'item') continue;
    if (entity.position.distanceTo(botPos) > maxDist) continue;
    if (getItemNameFromEntity(entity, mcData) === itemName) return true;
  }
  return false;
}
