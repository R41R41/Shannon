import { waitForObservation, type ObservationSource } from '../execution/observedWait.js';

/**
 * bot.equip() resolving is not the tool being in the hand: production run 14 logged "stone_pickaxe を装備しました"
 * and then dug coal ore by bare hand (15 s a block, nothing dropped) with the pickaxes in inventory slots 10 and 12,
 * outside the hotbar. This puts the check after the call and, when it fails, retries once by placing the tool in a
 * hotbar slot explicitly and selecting that slot.
 */

const HOTBAR_START = 36;
const HOTBAR_SLOTS = 9;
const SETTLE_MS = 600;

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

async function settled(bot: any, tool: ToolLike): Promise<boolean> {
  const sources: Array<{ source: ObservationSource; event: string }> = typeof bot?.on === 'function'
    ? [{ source: bot as ObservationSource, event: 'heldItemChanged' }] : [];
  return waitForObservation(bot, () => holdsTool(bot, tool), SETTLE_MS, sources);
}

/** The hotbar slot to put a tool in: where it already is, else an empty one, else the slot in use. */
function hotbarTarget(bot: any, tool: ToolLike): number {
  const slots: any[] = bot.inventory?.slots ?? [];
  if (typeof tool.slot === 'number' && tool.slot >= HOTBAR_START && tool.slot < HOTBAR_START + HOTBAR_SLOTS) return tool.slot;
  for (let slot = HOTBAR_START; slot < HOTBAR_START + HOTBAR_SLOTS; slot++) if (!slots[slot]) return slot;
  const current = Number.isInteger(bot.quickBarSlot) ? bot.quickBarSlot : 0;
  return HOTBAR_START + Math.min(Math.max(current, 0), HOTBAR_SLOTS - 1);
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
  const why = [firstError && `equip: ${firstError}`, retryError && `retry: ${retryError}`].filter(Boolean).join('; ');
  return { held: false, retried: true,
    detail: `held=${bot.heldItem?.name ?? 'none'} (slot ${fresh.slot ?? '?'}, hotbar target ${target - HOTBAR_START})${why ? ` ${why}` : ''}` };
}
