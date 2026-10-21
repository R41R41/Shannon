/**
 * What the body threw away itself is not picked up again. Run 21: the pack was 34/36 with 545 cobblestone, drop-item threw 400 of it in a
 * narrow place and "picked 401 up again" (picked_up_again); the earlier tidy throws of 143 and 423 were followed a minute later by
 * the same heap, because collectDrops (after every dig that yields cobblestone) walks to ANY cobblestone lying within ten blocks of
 * the dig, including the heap the body had just thrown, and the auto pickup and pickup-nearest-item do the same.
 *
 * drop-item records the ids of the item entities it threw (only kinds the tidy table allows to be thrown: a tool thrown by mistake
 * is still fetched back on purpose). Every pickup that chooses its own target asks `isSelfDropped` first. The record lives for
 * SELF_DROP_MS, then the item is just a drop on the ground again (it despawns after five minutes anyway).
 */
import { isThrowable } from './inventoryTidy.js';
import { nativeActionHost } from '../execution/ActionExecution.js';

/**
 * How long a thrown heap is left alone: as long as an item lies on the ground (it despawns after five minutes), a little less.
 * (Run 25: two minutes, then the heap was fetched back.)
 */
export const SELF_DROP_MS = 290_000;

interface Noted { at: number; name: string }
/**
 * Kept on the native body, not on the object the caller holds: every skill works through a motor port of its own (a new proxy for each
 * action), so the port drop-item wrote through was never the one collectDrops, pickup-nearest-item and the auto pickup asked through,
 * and the record was never found (run 25: the same dirt 40 and diorite 25 thrown and fetched back three times).
 */
const records = new WeakMap<object, Map<number, Noted>>();
const hostOf = (bot: object): object => { try { return nativeActionHost(bot) ?? bot; } catch { return bot; } };

export interface DroppedLike { id?: number; name?: string; displayName?: unknown; getDroppedItem?(): { name?: string } | null | undefined }

const isItemEntity = (entity: DroppedLike) => entity.name === 'item' || String(entity.displayName) === 'Item';

/** The kind lying in an item entity, or null when it cannot be read (metadata can arrive late). */
export function droppedKind(entity: DroppedLike): string | null {
  try { return entity.getDroppedItem?.()?.name ?? null; } catch { return null; }
}

/** Remembers item entities the body threw itself. Junk kinds only; returns how many were noted. */
export function noteSelfDropped(bot: object, itemName: string, entities: DroppedLike[], now: number = Date.now()): number {
  // Junk kinds, and the spare pickaxes the tidy throws (inventoryTidy surplusPickaxes); other things may be fetched back on purpose.
  if (!isThrowable(itemName) && !itemName.endsWith('_pickaxe')) return 0;
  const host = hostOf(bot);
  let map = records.get(host);
  if (!map) { map = new Map(); records.set(host, map); }
  let noted = 0;
  for (const entity of entities) {
    if (entity.id === undefined || !isItemEntity(entity)) continue;
    map.set(entity.id, { at: now, name: itemName });
    noted++;
  }
  // The record is small, but a long run throws many heaps: old ones go.
  if (map.size > 256) for (const [id, record] of map) if (now - record.at > SELF_DROP_MS) map.delete(id);
  return noted;
}

/** Whether this item entity is one the body threw away itself a short while ago. */
export function isSelfDropped(bot: object, entity: DroppedLike | null | undefined, now: number = Date.now()): boolean {
  if (!entity || entity.id === undefined) return false;
  const host = hostOf(bot);
  const record = records.get(host)?.get(entity.id);
  if (!record) return false;
  if (now - record.at > SELF_DROP_MS) { records.get(host)?.delete(entity.id); return false; }
  return true;
}

/** Item entities now lying that were not in `before`, of this kind (or of unreadable kind: they may be ours). */
export function newItemEntities(bot: { entities?: Record<string, DroppedLike> | Record<number, DroppedLike> }, before: Set<number>, itemName: string): DroppedLike[] {
  return (Object.values(bot.entities ?? {}) as DroppedLike[]).filter(entity => entity && entity.id !== undefined && isItemEntity(entity)
    && !before.has(entity.id) && (droppedKind(entity) === null || droppedKind(entity) === itemName));
}

