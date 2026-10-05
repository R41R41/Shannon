import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Never read the real dev .env or use its credentials in these tests.
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));
const originalArgv = [...process.argv];

describe('isolated Minebot credential boundary', () => {
  it('does not load shared dotenv files for an isolated probe', async () => {
    vi.stubEnv('SHANNON_ISOLATED_MINEBOT_PROBE', 'true');
    const dotenv = (await import('dotenv')).default; vi.mocked(dotenv.config).mockClear();
    await import('../../../src/config/env.js');
    expect(dotenv.config).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('OPENAI_API_KEY', 'offline-test-only');
  vi.stubEnv('MONGODB_URI', 'mongodb://127.0.0.1/shannon_unit_test');
  vi.stubEnv('IS_DEV', '');
  vi.stubEnv('SELF_IMPROVE_AUTO_APPLY_TIER2', '');
  process.argv = originalArgv.filter(a => a !== '--dev');
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.argv = [...originalArgv];
});

describe('self-improvement requires explicit opt-in', () => {
  it('does not authorize file writes just because --dev is present', async () => {
    process.argv.push('--dev');
    const { config } = await import('../../../src/config/env.js');
    expect(config.isDev).toBe(true);
    expect(config.selfImprove.autoApplyTier2).toBe(false);
  });
  it('honors an explicit false in dev mode', async () => {
    vi.stubEnv('IS_DEV', 'True');
    vi.stubEnv('SELF_IMPROVE_AUTO_APPLY_TIER2', 'false');
    const { config } = await import('../../../src/config/env.js');
    expect(config.selfImprove.autoApplyTier2).toBe(false);
  });
  it('allows an explicit true', async () => {
    vi.stubEnv('SELF_IMPROVE_AUTO_APPLY_TIER2', 'true');
    const { config } = await import('../../../src/config/env.js');
    expect(config.selfImprove.autoApplyTier2).toBe(true);
  });
  it('remains disabled by default outside dev mode', async () => {
    const { config } = await import('../../../src/config/env.js');
    expect(config.selfImprove.autoApplyTier2).toBe(false);
  });
});

it.each([['true','true'],['false','false'],['true','false']])('honors either X stop flag disabled=%s enabled=%s',async(disabled,enabled)=>{
  vi.stubEnv('TWITTER_DISABLED',disabled); vi.stubEnv('TWITTER_ENABLED',enabled);
  const {config}=await import('../../../src/config/env.js'); expect(config.twitter.disabled).toBe(true);
});

describe('discord token in dev', () => {
  it('uses DISCORD_TOKEN_TEST and ignores the production token', async () => {
    process.argv.push('--dev');
    vi.stubEnv('DISCORD_TOKEN', 'prod-token-must-not-be-used');
    vi.stubEnv('DISCORD_TOKEN_TEST', 'test-bot-token');
    vi.stubEnv('TEST_GUILD_ID', '123456789012345678');
    const { config } = await import('../../../src/config/env.js');
    expect(config.discord.token).toBe('test-bot-token');
    expect(config.discord.guilds.test.guildId).toBe('123456789012345678');
  });
  it('does not use the production token when the test token is missing', async () => {
    process.argv.push('--dev');
    vi.stubEnv('DISCORD_TOKEN', 'prod-token-must-not-be-used');
    vi.stubEnv('DISCORD_TOKEN_TEST', '');
    const { config } = await import('../../../src/config/env.js');
    expect(config.discord.token).toBe('');
  });
});

describe('minecraft Jev rollout mode', () => {
  it('requires a separate opt-in for running-action control, even in legacy feedback mode', async () => {
    vi.stubEnv('MINECRAFT_COGNITION_MODE', 'feedback');
    vi.stubEnv('MINECRAFT_EXECUTION_SUPERVISION_MODE', '');
    let loaded = await import('../../../src/config/env.js');
    expect(loaded.config.minecraftCognition.executionSupervisionMode).toBe('off');
    vi.resetModules(); vi.stubEnv('MINECRAFT_EXECUTION_SUPERVISION_MODE', 'feedback');
    loaded = await import('../../../src/config/env.js');
    expect(loaded.config.minecraftCognition.executionSupervisionMode).toBe('feedback');
  });
  it('is off by default', async () => {
    vi.stubEnv('MINECRAFT_JEV_MODE', '');
    const { config } = await import('../../../src/config/env.js');
    expect(config.minecraftCognition.mode).toBe('off');
    expect(config.minecraftCognition.provider).toBe('auto');
    expect(config.minecraftCognition.openAIModel).toBe('gpt-5.6-luna');
    expect(config.minecraftCognition.openAIReasoningEffort).toBe('none');
  });

  it('accepts shadow and rejects unimplemented direct-control values', async () => {
    vi.stubEnv('MINECRAFT_JEV_MODE', 'shadow');
    let loaded = await import('../../../src/config/env.js');
    expect(loaded.config.minecraftCognition.mode).toBe('shadow');

    vi.resetModules();
    vi.stubEnv('MINECRAFT_JEV_MODE', 'control');
    loaded = await import('../../../src/config/env.js');
    expect(loaded.config.minecraftCognition.mode).toBe('off');
  });

  it('accepts an explicit fast-provider and bounded OpenAI reasoning effort', async () => {
    vi.stubEnv('MINECRAFT_COGNITION_PROVIDER', 'openai');
    vi.stubEnv('MINECRAFT_OPENAI_REASONING_EFFORT', 'low');
    const { config } = await import('../../../src/config/env.js');
    expect(config.minecraftCognition.provider).toBe('openai');
    expect(config.minecraftCognition.openAIReasoningEffort).toBe('low');
  });

  it('prefers the provider-neutral cognition mode while preserving the Jev alias', async () => {
    vi.stubEnv('MINECRAFT_JEV_MODE', 'shadow');
    vi.stubEnv('MINECRAFT_COGNITION_MODE', 'feedback');
    const { config } = await import('../../../src/config/env.js');
    expect(config.minecraftCognition.mode).toBe('feedback');
    expect(config.minecraftCognition.openAITimeoutMs).toBe(2_500);
  });
});
