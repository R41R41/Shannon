/**
 * A window left open turns an equip into a click on a slot the window does not have.
 *
 * `bot.equip` of an item that is not in the hotbar moves it there with clicks, and a click goes to the window that is open, in that
 * window's numbering. A furnace's window has 39 slots, so a click on the hotbar's slots 39 to 44 fails an assertion of the library:
 * "invalid operation". Run 22 crafted its third furnace and could not set it down for that (the lab reproduces it: a furnace window
 * left open, the furnace in the pack's main part, the library's next hotbar slot 39). The window is closed before such an equip.
 */
interface WindowBot {
  currentWindow?: { type?: string } | null;
  closeWindow?(window: unknown): void;
  inventory?: { slots?: unknown[] };
}

const HOTBAR_FIRST = 36;
const HOTBAR_LAST = 44;

/** Whether `bot.equip(...args)` will click on slots (an item outside the hotbar, or a destination other than the hand). */
export function equipWillClick(bot: WindowBot, args: unknown[]): boolean {
  const destination = args[1] ?? 'hand';
  if (destination !== 'hand') return true;
  const item = args[0] as { slot?: unknown } | number | null | undefined;
  if (!item || typeof item !== 'object' || typeof item.slot !== 'number') return true;
  return item.slot < HOTBAR_FIRST || item.slot > HOTBAR_LAST;
}

/** Closes an open window that is not the pack itself; true when one was closed. */
export function closeStaleWindow(bot: WindowBot): boolean {
  const window = bot.currentWindow;
  if (!window || typeof bot.closeWindow !== 'function') return false;
  try { bot.closeWindow(window); return true; } catch { return false; }
}
