import prismarineItem from 'prismarine-item';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:InventorySync');

interface SyncBot {
  _client?: { write(name: string, params: Record<string, unknown>): void };
  registry?: unknown;
  currentWindow?: unknown;
  inventory?: { slots: Array<{ name: string; count: number } | null>; selectedItem?: unknown };
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  supportFeature?(name: string): boolean;
  inventorySync?: InventorySyncState;
}
export interface InventorySyncState { enabled: boolean; resyncs: number; corrected: number }

const snapshot = (bot: SyncBot) => (bot.inventory?.slots ?? []).map(item => item ? `${item.name}x${item.count}` : '');

/**
 * Makes the body's picture of its own pack the server's. The client library
 * works a crafting grid by prediction: it writes into its own copy what each
 * click should do and what the result should be, and when it closes a
 * crafting-table window it stops listening to that window, late corrections
 * included. After three table crafts in two seconds a body's copy and the
 * server's pack had come apart, and from then on every craft in the pack's
 * own grid clicked on slots that did not hold what the copy said: seventeen
 * crafts in sixteen minutes "failed", each one taking a log (paid run L64).
 *
 * Two things a person does without thinking. The pack's screen is closed:
 * the server puts back whatever was left lying in its crafting grid or held
 * on the cursor. Then the pack is looked at: a click that touches nothing,
 * stamped with a state the server does not hold, makes it send the whole
 * pack. Resolves true when the pack arrived, false when it did not or when a
 * container is open (then that container's window is the truth).
 */
export async function resyncInventory(bot: SyncBot, timeoutMs = 1500): Promise<boolean> {
  const state = bot.inventorySync ??= { enabled: true, resyncs: 0, corrected: 0 };
  const client = bot._client;
  if (!state.enabled || !client || !bot.inventory || bot.currentWindow) return false;
  if (bot.supportFeature && !bot.supportFeature('stateIdUsed')) return false;
  const before = snapshot(bot);
  const arrived = new Promise<boolean>(resolve => {
    const done = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { bot.removeListener('setWindowItems:0', done); resolve(false); }, timeoutMs);
    bot.once('setWindowItems:0', done);
  });
  try {
    const Item = (prismarineItem as any)(bot.registry);
    client.write('close_window', { windowId: 0 });
    client.write('window_click', { windowId: 0, stateId: -1, slot: -1, mouseButton: 0, mode: 0, changedSlots: [], cursorItem: Item.toNotch(null) });
  } catch (error) {
    log.warn(`所持品の照合を送れません: ${String(error)}`);
    return false;
  }
  const ok = await arrived;
  if (!ok) return false;
  // The server holds nothing on the cursor once the screen is closed.
  bot.inventory.selectedItem = null;
  state.resyncs++;
  const after = snapshot(bot);
  const changed = after.map((value, slot) => value !== (before[slot] ?? '') ? `${slot}: ${before[slot] || '空'} → ${value || '空'}` : '').filter(Boolean);
  if (changed.length) {
    state.corrected++;
    log.warn(`🎒 所持品の写しがサーバーとずれていた（${changed.length}スロット）: ${changed.slice(0, 8).join('、')}`);
  }
  return true;
}
