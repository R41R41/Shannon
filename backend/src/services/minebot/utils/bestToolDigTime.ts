/**
 * How long a block takes to break with the best tool the body carries for it, in milliseconds: the tool a
 * dig would put in the hand, not the thing that happens to be there now. Asked with a cobblestone in the
 * hand (it had just been placing blocks), a body with an iron pickaxe counted 47 seconds for three blocks
 * of deepslate and was told its shelter could not be dug in time (paid run L78; the dig takes four).
 * 0 when nothing is known of the block.
 */
interface ToolBody {
  entity?: { effects?: unknown };
  inventory?: { items(): Array<{ type: number }> };
}

export function digMsWithBestTool(bot: ToolBody, block: any): number {
  if (!block || typeof block.digTime !== 'function') return 0;
  const effects = (bot.entity as any)?.effects ?? {};
  let best = Infinity;
  for (const type of [null, ...(bot.inventory?.items() ?? []).map(item => item.type)]) {
    try { best = Math.min(best, Number(block.digTime(type, false, false, false, [], effects))); } catch { /* not a tool for it */ }
  }
  return Number.isFinite(best) ? best : 0;
}
