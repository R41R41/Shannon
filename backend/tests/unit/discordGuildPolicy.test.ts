/**
 * Which guilds the runtime serves and where it registers its slash commands (guildPolicy.ts). With
 * SHANNON_PROD_ALLOW_TEST_GUILD off (the default) every answer is the one client.ts gave before the switch existed.
 */
import { describe, expect, it } from 'vitest';
import { commandGuildIds, skipsDiscordGuild, type DiscordGuildPolicy } from '../../src/services/discord/guildPolicy.js';

const TEST = '1240653981739389029';
const AIMINE = '1143860744983687218';
const OTHER = '1215605785984507925';

function policy(over: Partial<DiscordGuildPolicy> = {}): DiscordGuildPolicy {
  return { isDev: false, testGuildId: TEST, aimineGuildId: AIMINE, devAllowAimine: false, prodAllowTestGuild: false, ...over };
}

/** The production rule as client.ts had it before the switch (1161f8a). */
function legacySkip(p: DiscordGuildPolicy, guildId: string | null, devHolding: boolean): boolean {
  if (!guildId) return true;
  const isTestGuild = guildId === p.testGuildId;
  if (p.isDev) return !isTestGuild && !(p.devAllowAimine && guildId === p.aimineGuildId);
  if (isTestGuild) return true;
  return guildId === p.aimineGuildId && devHolding;
}

describe('discord guild policy', () => {
  it('switch off: the same answers as before, for every guild, mode and dev lock', () => {
    for (const isDev of [false, true]) {
      for (const devAllowAimine of [false, true]) {
        for (const devHolding of [false, true]) {
          for (const guildId of [TEST, AIMINE, OTHER, null, '']) {
            const p = policy({ isDev, devAllowAimine });
            expect(skipsDiscordGuild(p, guildId, () => devHolding)).toBe(legacySkip(p, guildId, devHolding));
          }
        }
      }
    }
    expect(commandGuildIds(policy())).toEqual([AIMINE]);
    expect(commandGuildIds(policy({ isDev: true }))).toEqual([TEST]);
    expect(commandGuildIds(policy({ isDev: true, devAllowAimine: true }))).toEqual([TEST, AIMINE]);
  });

  it('switch on in production: the test guild is served and gets the commands; the rest is unchanged', () => {
    const p = policy({ prodAllowTestGuild: true });
    expect(skipsDiscordGuild(p, TEST, () => false)).toBe(false);
    expect(skipsDiscordGuild(p, AIMINE, () => false)).toBe(false);
    expect(skipsDiscordGuild(p, AIMINE, () => true)).toBe(true);
    expect(skipsDiscordGuild(p, OTHER, () => false)).toBe(false);
    expect(skipsDiscordGuild(p, null, () => false)).toBe(true);
    expect(commandGuildIds(p)).toEqual([AIMINE, TEST]);
  });

  it('switch on has no effect in dev mode, and empty ids are never registered', () => {
    const dev = policy({ isDev: true, prodAllowTestGuild: true });
    expect(skipsDiscordGuild(dev, AIMINE, () => false)).toBe(true);
    expect(commandGuildIds(dev)).toEqual([TEST]);
    expect(commandGuildIds(policy({ prodAllowTestGuild: true, testGuildId: '' }))).toEqual([AIMINE]);
    expect(commandGuildIds(policy({ prodAllowTestGuild: true, testGuildId: AIMINE }))).toEqual([AIMINE]);
    expect(skipsDiscordGuild(policy({ testGuildId: '' }), OTHER, () => false)).toBe(false);
  });
});
