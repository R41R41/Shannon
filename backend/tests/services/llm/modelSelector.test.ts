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
      'gpt-4.1-mini',
      'gpt-5-mini-fast',
      'gpt-5-mini',
      'gpt-5',
    ]);
    expect(config.webSearch.providerOrder).toEqual(['google', 'brave']);
  });
});
