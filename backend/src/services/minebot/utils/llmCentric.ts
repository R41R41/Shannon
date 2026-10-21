/**
 * The switch of the "LLM decides in small steps" body (MINEBOT_LLM_CENTRIC, design mb-llm-centric 2.4, 2026-10-21).
 *
 *   off (unset, the default)  the body as it was: the skills with their own choices (detours, the tidy, the spare tools, the night's
 *                             sleep and gate, the idle pickup, the armour reflex, the top-up meal), the catalog of every skill.
 *   on                        the body keeps exact parts, exact observation and the safety reflexes only. The planner is offered `act`
 *                             (small steps, run in order and checked one by one), `view` (the map, wider) and a few readers; the
 *                             body's own choices above are not made, and what it refuses (a hostile let in by a dig, a village's
 *                             chest or bed) is said with the reason instead, to be passed with an argument.
 *
 * Read on every use (the environment is not cached) so that a test, or an operator restarting with the other value, sees the value
 * set. A body may also carry its own answer (`bot.llmCentric`, a boolean), which wins: the probes and the tests set it per body.
 */
export const LLM_CENTRIC_ENV = 'MINEBOT_LLM_CENTRIC';

export function llmCentricFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  const raw = String(env[LLM_CENTRIC_ENV] ?? '').trim().toLowerCase();
  return raw === 'on' || raw === '1' || raw === 'true';
}

/** Whether this body runs the LLM-centric mode (the body's own answer first, then the environment). */
export function isLlmCentric(bot?: unknown): boolean {
  const own = (bot as { llmCentric?: unknown } | null | undefined)?.llmCentric;
  if (typeof own === 'boolean') return own;
  return llmCentricFromEnv();
}
