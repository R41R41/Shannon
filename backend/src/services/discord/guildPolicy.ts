/**
 * Which Discord guilds this runtime serves, and where it registers its slash commands.
 *
 * - dev (`--dev`, the test bot token): the test guild only; the aimine guild too with SHANNON_DEV_ALLOW_AIMINE=true.
 * - production: every configured guild except the test guild, and the aimine guild is left alone while a dev
 *   process holds it (the dev aimine lock). With SHANNON_PROD_ALLOW_TEST_GUILD=on (owner 2026-10-21, default off)
 *   production also serves the test guild and registers its commands there.
 *
 * Production registers commands in the aimine guild (and the test guild when allowed); dev in the test guild
 * (and aimine when allowed). With the switch off everything is exactly as before.
 */
export interface DiscordGuildPolicy {
  isDev: boolean;
  testGuildId: string;
  aimineGuildId: string;
  devAllowAimine: boolean;
  prodAllowTestGuild: boolean;
}

/** True when this runtime must ignore events (messages, commands, speech) of the guild. */
export function skipsDiscordGuild(
  policy: DiscordGuildPolicy,
  guildId: string | null,
  devHoldingAimine: () => boolean,
): boolean {
  if (!guildId) return true;
  const isTestGuild = Boolean(policy.testGuildId) && guildId === policy.testGuildId;
  const isAimineGuild = Boolean(policy.aimineGuildId) && guildId === policy.aimineGuildId;
  if (policy.isDev) {
    return !isTestGuild && !(policy.devAllowAimine && isAimineGuild);
  }
  if (isTestGuild) return !policy.prodAllowTestGuild;
  if (isAimineGuild && devHoldingAimine()) return true;
  return false;
}

/** The guilds the slash commands are registered in (empty ids dropped, no duplicates). */
export function commandGuildIds(policy: DiscordGuildPolicy): string[] {
  const ids = policy.isDev
    ? [policy.testGuildId, ...(policy.devAllowAimine ? [policy.aimineGuildId] : [])]
    : [policy.aimineGuildId, ...(policy.prodAllowTestGuild ? [policy.testGuildId] : [])];
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
}
