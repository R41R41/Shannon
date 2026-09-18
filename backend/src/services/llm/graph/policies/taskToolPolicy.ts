const DISCORD_ARTIFACT_GOAL = /(?:PDF|旅行資料|旅程.{0,12}資料|日帰り旅行.{0,20}資料)/iu;

/**
 * Tools exposed to the model while producing a Discord travel artifact.
 *
 * Keeping this list deliberately small improves tool choice, reduces prompt
 * tokens, and prevents unrelated side effects (tweets, images, routines, etc.).
 * The deterministic delivery hand-off still happens in the executor after the
 * travel brief has been rendered.
 */
export const DISCORD_ARTIFACT_ALLOWED_TOOLS = [
  'recall-person',
  'ask-user-on-discord',
  'update-plan',
  'google-search',
  'fetch-url',
  'search-weather',
  'search-places',
  'compute-route',
  'create-travel-brief',
  'send-artifact-on-discord',
  'task-complete',
] as const;

export function isDiscordArtifactTask(goal: string, platform: string | null): boolean {
  return platform === 'discord' && DISCORD_ARTIFACT_GOAL.test(goal);
}

/**
 * Explicit per-request policy has priority. Otherwise, known task families get
 * a least-privilege policy; unclassified tasks retain the existing tool set.
 */
export function resolveTaskToolPolicy(
  goal: string,
  platform: string | null,
  explicitlyAllowed?: readonly string[],
): string[] | undefined {
  if (explicitlyAllowed?.length) return [...new Set(explicitlyAllowed)];
  if (isDiscordArtifactTask(goal, platform)) return [...DISCORD_ARTIFACT_ALLOWED_TOOLS];
  return undefined;
}
