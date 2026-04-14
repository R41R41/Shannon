import type { CustomBot } from '../types.js';

/** LLM / ツール結果用の満杯時リカバリ（他スキルと文言を揃える） */
export const INVENTORY_FULL_RECOVERY_HINT_JA =
  '満杯になる前に空きが減ってきた段階で預けるのが望ましい。インベントリ満杯のまま捨ててはいけません。必ず deposit-to-container で**地上（天光の届く場所）の**チェストまたは樽に預けて空きを作る。洞窟内の収納は拒否される。地上へ出て find-blocks で chest / barrel を探すか、craft-one(chest) と place-block-at で屋外・天窓付近に設置してから預ける。地上に落ちたアイテムは pickup-nearest-item で回収したあとも、整理はチェスト預けで行う。';

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
export function shouldPauseMiningForDeposit(bot: CustomBot, remainingToMine: number): boolean {
  const empty = emptySlotCountSafe(bot);
  if (empty <= 0) return true;
  if (remainingToMine <= 0) return false;
  if (empty <= DEPOSIT_BEFORE_EMPTY_SLOTS_FALLS_TO && remainingToMine > empty) {
    return true;
  }
  return false;
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
