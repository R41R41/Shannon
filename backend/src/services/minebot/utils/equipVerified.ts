import { waitForObservation, type ObservationSource } from '../execution/observedWait.js';
import { isThrowable } from './inventoryTidy.js';

/**
 * bot.equip() resolving is not the tool being in the hand: production run 14 logged "stone_pickaxe を装備しました"
 * and then dug coal ore by bare hand (15 s a block, nothing dropped) with the pickaxes in inventory slots 10 and 12,
 * outside the hotbar. This puts the check after the call and, when it fails, retries once by placing the tool in a
 * hotbar slot explicitly and selecting that slot.
 *
 * Run 21 (pack 34/36, hotbar full): the pickaxe sat in slot 23 and "held=none, hotbar target 0" ended dig-block-at. When the move
 * did not leave the tool in the hand, a second try swaps the two slots in one window click (mode 2, the number-key swap): it needs no
 * free slot and no item on the cursor, and nothing is thrown away. The hotbar slot given up is the least valuable one (empty, then
 * rock and clutter, then other things, never by choice a tool, weapon, armour, food, bucket or bed).
 */

const HOTBAR_START = 36;
const HOTBAR_SLOTS = 9;
const SETTLE_MS = 600;
/** The swap goes through the server, which answers a little later than a move done on the client's own copy. */
const SWAP_SETTLE_MS = 1200;

export interface EquipOutcome {
  held: boolean;
  /** The explicit hotbar placement was tried (the plain equip did not leave the tool in the hand). */
  retried: boolean;
  /** Short account of what happened, for the log and the failure message. */
  detail: string;
}

type ToolLike = { type: number; name?: string; slot?: number };

export function holdsTool(bot: any, tool: ToolLike): boolean {
  const held = bot?.heldItem;
  if (!held || !tool) return false;
  if (held.type !== tool.type) return false;
  return held.name === undefined || tool.name === undefined || held.name === tool.name;
}

async function settled(bot: any, tool: ToolLike, timeoutMs: number = SETTLE_MS): Promise<boolean> {
  const sources: Array<{ source: ObservationSource; event: string }> = typeof bot?.on === 'function'
    ? [{ source: bot as ObservationSource, event: 'heldItemChanged' }] : [];
  return waitForObservation(bot, () => holdsTool(bot, tool), timeoutMs, sources);
}

/** How little a hotbar slot's content is wanted there: 0 junk to throw, 1 anything else, 3 what the body works with. */
function hotbarWorth(bot: any, item: { name?: string } | null | undefined): number {
  if (!item) return -1;
  const name = String(item.name ?? '');
  if (/_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/.test(name) || /^(bow|crossbow|shield|trident|elytra|totem_of_undying|flint_and_steel|shears|fishing_rod)$/.test(name)
    || /bucket$/.test(name) || /(^|_)bed$/.test(name) || name === 'torch' || name === 'ender_pearl' || bot?.registry?.foodsByName?.[name]) return 3;
  return isThrowable(name) ? 0 : 1;
}

/** The hotbar slot to put a tool in: where it already is, else an empty one, else the least valuable one (the slot in use on a tie). */
function hotbarTarget(bot: any, tool: ToolLike): number {
  const slots: any[] = bot.inventory?.slots ?? [];
  if (typeof tool.slot === 'number' && tool.slot >= HOTBAR_START && tool.slot < HOTBAR_START + HOTBAR_SLOTS) return tool.slot;
  for (let slot = HOTBAR_START; slot < HOTBAR_START + HOTBAR_SLOTS; slot++) if (!slots[slot]) return slot;
  const current = HOTBAR_START + Math.min(Math.max(Number.isInteger(bot.quickBarSlot) ? bot.quickBarSlot : 0, 0), HOTBAR_SLOTS - 1);
  let best = current;
  for (let slot = HOTBAR_START; slot < HOTBAR_START + HOTBAR_SLOTS; slot++) {
    if (hotbarWorth(bot, slots[slot]) < hotbarWorth(bot, slots[best])) best = slot;
  }
  return best;
}

export async function equipToHandVerified(bot: any, tool: ToolLike): Promise<EquipOutcome> {
  let firstError = '';
  try { await bot.equip(tool, 'hand'); } catch (error: any) { firstError = error?.message ?? String(error); }
  if (await settled(bot, tool)) return { held: true, retried: false, detail: 'equip' };

  // Retry once with the tool as the inventory has it now (the object passed in may be stale).
  const fresh: ToolLike = bot.inventory?.items?.().find((item: ToolLike) => item.type === tool.type) ?? tool;
  const target = hotbarTarget(bot, fresh);
  let retryError = '';
  try {
    if (typeof fresh.slot === 'number' && fresh.slot !== target) await bot.moveSlotItem(fresh.slot, target);
    bot.setQuickBarSlot(target - HOTBAR_START);
  } catch (error: any) { retryError = error?.message ?? String(error); }
  if (await settled(bot, tool)) {
    return { held: true, retried: true, detail: `slot ${fresh.slot ?? '?'} -> hotbar ${target - HOTBAR_START}` };
  }

  // Still not in the hand, the tool outside the hotbar (a full pack: the move above can leave an item on the cursor or be refused):
  // one swap click with the hotbar slot, then that slot selected. Nothing is dropped, so no tool is ever lost to it.
  const now: ToolLike = bot.inventory?.items?.().find((item: ToolLike) => item.type === tool.type) ?? fresh;
  let swapError = '';
  let swapped = false;
  if (typeof bot.clickWindow === 'function' && typeof now.slot === 'number' && now.slot >= 0 && now.slot < HOTBAR_START) {
    const swapTarget = hotbarTarget(bot, now);
    try {
      await bot.clickWindow(now.slot, swapTarget - HOTBAR_START, 2);
      bot.setQuickBarSlot(swapTarget - HOTBAR_START);
      swapped = true;
    } catch (error: any) { swapError = error?.message ?? String(error); }
    if (swapped && await settled(bot, tool, SWAP_SETTLE_MS)) {
      return { held: true, retried: true, detail: `slot ${now.slot} <-> hotbar ${swapTarget - HOTBAR_START}（入れ替え）` };
    }
  }
  const why = [firstError && `equip: ${firstError}`, retryError && `retry: ${retryError}`, swapError && `swap: ${swapError}`].filter(Boolean).join('; ');
  return { held: false, retried: true,
    detail: `held=${bot.heldItem?.name ?? 'none'} (slot ${fresh.slot ?? '?'}, hotbar target ${target - HOTBAR_START})${why ? ` ${why}` : ''}` };
}
