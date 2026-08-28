import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Never read the real dev .env or use its credentials in these tests.
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));
const originalArgv = [...process.argv];

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
