import { beforeEach, describe, expect, it } from 'vitest';

describe('modelManager cost guard', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY ||= 'test-openai-key';
    process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/test';
  });

  it('rejects GPT-6 Astra runtime overrides', async () => {
    const { modelManager } = await import('../../src/config/modelManager');

    expect(() => modelManager.set('functionCalling', 'gpt-6-astra')).toThrow(
      'GPT-6 Astra is disabled',
    );
    expect(() => modelManager.set('functionCalling', 'gpt-6-astra-2026-04-30')).toThrow(
      'GPT-6 Astra is disabled',
    );
  });

  it('accepts the approved OpenAI routing tiers', async () => {
    const { modelManager } = await import('../../src/config/modelManager');

    expect(() => modelManager.set('functionCalling', 'gpt-5.6-luna')).not.toThrow();
    expect(() => modelManager.set('functionCalling', 'gpt-5.6-terra')).not.toThrow();
    expect(() => modelManager.set('functionCalling', 'gpt-5.6-sol')).not.toThrow();
    modelManager.reset('functionCalling');
  });
});
