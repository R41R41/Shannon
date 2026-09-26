import { describe, expect, it } from 'vitest';

describe('ModelSelector defaults', () => {
  it('uses the OpenAI chain even when an Anthropic key also exists', async () => {
    process.env.OPENAI_API_KEY ||= 'test-openai-key';
    process.env.ANTHROPIC_API_KEY ||= 'test-anthropic-key';
    process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/test';
    delete process.env.SHANNON_LLM_PROVIDER;

    const { ModelSelector } = await import('../../../src/services/llm/graph/cognitive/ModelSelector');
    const { config } = await import('../../../src/config/env');
    expect(ModelSelector.getChainInfo().map((entry) => entry.name)).toEqual([
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
    ]);
    expect(ModelSelector.getChainInfo().map((entry) => entry.reasoningEffort)).toEqual([
      'none',
      'none',
      'none',
    ]);
    expect(config.webSearch.providerOrder).toEqual(['google', 'brave']);
  });

  it('routes low-cost, planned, and high-risk work to Luna, Terra, and Sol', async () => {
    const { ModelSelector } = await import('../../../src/services/llm/graph/cognitive/ModelSelector');

    expect(ModelSelector.selectInitialModel('low', false, 'conversation')).toBe('gpt-5.6-luna');
    expect(ModelSelector.selectInitialModel('mid', true, 'conversation')).toBe('gpt-5.6-terra');
    expect(ModelSelector.selectInitialModel('high', true, 'conversation')).toBe('gpt-5.6-sol');
  });
});
