import { inventoryCount, type StepContext } from './common.js';

/** Record an observed recipe result even when the act's done condition interrupts its final wait. Never assume a craft succeeded. */
export function craftEvents(ctx: StepContext, recipe: any, item: string, intermediate: boolean, madeNames: ReadonlySet<string> = new Set()): () => void {
  const bot = ctx.bot, before = inventoryCount(bot, item);
  const ingredients = (recipe.delta ?? []).filter((entry: any) => entry.count < 0).map((entry: any) => {
    const name = String(bot.registry?.items?.[entry.id]?.name ?? entry.id);
    return { name, before: inventoryCount(bot, name) };
  });
  return () => {
    const gained = inventoryCount(bot, item) - before;
    if (gained <= 0) return;
    for (const entry of ingredients) {
      const spent = entry.before - inventoryCount(bot, entry.name);
      if (spent > 0) ctx.record?.({ item: entry.name, count: -spent, reason: 'ingredient', ...(madeNames.has(entry.name) ? { intermediate: true } : {}) });
    }
    ctx.record?.({ item, count: gained, reason: 'crafted', ...(intermediate ? { intermediate: true } : {}) });
  };
}
