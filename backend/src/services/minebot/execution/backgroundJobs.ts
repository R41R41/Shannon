import type { CustomBot } from '../types/CustomBot.js';

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
    ...(furnace.unfueledCount ? { unfueledInputCount: furnace.unfueledCount } : {}),
    instruction: furnace.unfueledCount
      ? `${furnace.unfueledCount} more input will never smelt without fuel. Refuel this furnace with start-smelting (resume) once its fuel slot is empty, or get fuel first; count only withdrawn output.`
      : 'Do independent prerequisites while waiting; return to this furnace and verify/withdraw output before using it.',
  }));
}
