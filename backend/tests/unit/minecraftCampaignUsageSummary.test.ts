import { describe, expect, it } from 'vitest';
import { summarizeCampaignUsage } from '../../src/services/minebot/testing/CampaignUsageSummary.js';
describe('campaign usage projection', () => {
  it('keeps cold 1h write, warm read, output and unknown cost distinct', () => {
    const summary = summarizeCampaignUsage([
      { request: 1, role: 'planner', provider: 'anthropic', phase: 'active', requestedModel: 'claude-haiku-5-5',
        priceDerivedUsd: .0003, chargedUsd: .000375, unknownReservedUsd: 0, durationMs: 300,
        usage: { input_tokens: 20, cache_creation_input_tokens: 1200, cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1200 }, output_tokens: 100 } },
      { request: 2, role: 'planner', provider: 'anthropic', phase: 'active', requestedModel: 'claude-haiku-5-5',
        priceDerivedUsd: .0001, chargedUsd: .000125, unknownReservedUsd: 0, durationMs: 100,
        usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 1200, output_tokens: 80 } },
      { request: 3, role: 'learning', phase: 'drain', priceDerivedUsd: null, unknownReservedUsd: .01, chargedUsd: .01 },
    ]);
    expect(summary.priceDerivedUsd).toBeCloseTo(.0004);
    expect(summary.unknownReservedUsd).toBe(.01);
    expect(summary.cacheCreationTokens).toBe(1200);
    expect(summary.cacheCreation1hTokens).toBe(1200);
    expect(summary.outputTokensIncludingThinking).toBe(180);
    expect(summary.cacheReadRatio).toBeCloseTo(1200 / 2440);
    expect(summary.groups).toHaveLength(2);
    expect(summary.latencyMedianMs).toBe(100);
    expect(summary.latencyP95Ms).toBe(300);
  });
  it('counts a repeated reservation receipt once and retains its final settlement', () => {
    const summary = summarizeCampaignUsage([{ request: 1, priceDerivedUsd: null, unknownReservedUsd: .1 },
      { request: 1, priceDerivedUsd: .002, unknownReservedUsd: 0, chargedUsd: .0025 }]);
    expect(summary.requests).toBe(1);
    expect(summary.priceDerivedUsd).toBe(.002);
    expect(summary.unknownReservedUsd).toBe(0);
  });
  it('does not double-count OpenAI cache reads in historical comparisons', () => {
    const summary = summarizeCampaignUsage([
      { provider: 'openai', usage: { input_tokens: 200, input_tokens_details: { cached_tokens: 150 }, output_tokens: 10 } },
      { provider: 'anthropic', usage: { input_tokens: 50, cache_read_input_tokens: 100, output_tokens: 20 } },
    ]);
    expect(summary.uncachedInputTokens).toBe(100);
    expect(summary.cacheReadTokens).toBe(250);
    expect(summary.cacheReadRatio).toBeCloseTo(250 / 350);
    expect(summary.outputTokensIncludingThinking).toBe(30);
  });
});
