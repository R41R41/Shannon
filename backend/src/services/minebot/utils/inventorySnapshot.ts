import type { MinecraftInventoryEntry } from '@shannon/common';

type PrismarineItem = {
  name: string;
  count: number;
  maxDurability?: number | null;
  durabilityUsed?: number | null;
};

/**
 * prismarine-item / mineflayer のアイテムを LLM 向けスナップショットに変換する。
 */
export function prismarineItemToInventoryEntry(item: PrismarineItem): MinecraftInventoryEntry {
  const entry: MinecraftInventoryEntry = {
    name: item.name,
    count: item.count,
  };
  const max = item.maxDurability;
  const used = item.durabilityUsed;
  if (max != null && max > 0 && used != null && used >= 0) {
    entry.durabilityMax = max;
    entry.durabilityRemaining = Math.max(0, max - used);
  }
  return entry;
}

export function mapBotInventoryItems(
  items: Iterable<PrismarineItem>,
): MinecraftInventoryEntry[] {
  return Array.from(items, prismarineItemToInventoryEntry);
}
