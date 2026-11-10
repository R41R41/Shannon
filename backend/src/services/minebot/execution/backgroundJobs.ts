import type { CustomBot } from '../types/CustomBot.js';
import { SMELTING_RECIPES } from '../knowledge/smeltingRecipes.js';

/**
 * What a batch of `input` comes out as ("iron_ingot", "cooked_beef"), or null when the recipe is not known (it is then left out, never guessed: the planner reads it as a fact).
 * Ores smelt like their raw items (iron, gold, copper); the nether ores are named; only `_log` stands for the logs that make charcoal (stems and `_wood` do not here).
 */
export function smeltOutputOf(input: string): string | null {
  if (input === 'nether_gold_ore') return 'gold_ingot';
  if (input === 'nether_quartz_ore') return 'quartz';
  const name = /_ore$/u.test(input) ? `raw_${input.replace(/^(?:deepslate_)?(.*)_ore$/u, '$1')}` : /_log$/u.test(input) ? 'oak_log' : input;
  return Object.entries(SMELTING_RECIPES).find(([, recipe]) => recipe.input === name)?.[0] ?? null;
}

/** Estimated eligibility is never called server-confirmed completion. */
export function backgroundJobs(bot: Pick<CustomBot, 'activeFurnaces' | 'game'>, now = Date.now()) {
  const dimension = String(bot.game?.dimension ?? 'unknown');
  return (bot.activeFurnaces ?? []).map(furnace => ({
    id: `smelt:${furnace.dimension ?? dimension}:${furnace.pos.x},${furnace.pos.y},${furnace.pos.z}:${furnace.startedAt}`,
    kind: 'smelting', position: furnace.pos, dimension: furnace.dimension ?? null,
    input: furnace.item, count: furnace.count, startedAt: furnace.startedAt,
    estimatedReadyAt: furnace.readyAt, remainingEstimateMs: Math.max(0, furnace.readyAt - now),
    status: furnace.dimension && furnace.dimension !== dimension ? 'different_dimension'
      : now >= furnace.readyAt ? 'verification_due' : 'waiting_external',
    completionVerified: false,
    // Run 5 (11/11): the head had only "seconds left" and stood at the furnace; what comes out is said so that it can plan the work meanwhile.
    ...(smeltOutputOf(String(furnace.item)) ? { expects: `${smeltOutputOf(String(furnace.item))}×${furnace.count}` } : {}),
    ...(furnace.unfueledCount ? { unfueledInputCount: furnace.unfueledCount } : {}),
    instruction: furnace.unfueledCount
      ? `${furnace.unfueledCount} more input will never smelt without fuel. Refuel this furnace with start-smelting (resume) once its fuel slot is empty, or get fuel first; count only withdrawn output.`
      : 'Do independent prerequisites while waiting; return to this furnace and verify/withdraw output before using it.',
  }));
}
