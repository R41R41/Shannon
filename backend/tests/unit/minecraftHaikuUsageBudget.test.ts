import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ActualUsageBudget, anthropicUsageCostUsd, lunaUsageCostUsd, modelUsageCostUsd,
} from '../../src/services/minebot/testing/AcceptanceBudget.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const model = 'claude-haiku-5-5';
const usage = (overrides: Record<string, unknown> = {}) => ({
  input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 2000,
  cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 400 }, ...overrides,
});
const body = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  model, max_tokens: 8192, system: [{ type: 'text', text: 'synthetic-only', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  messages: [{ role: 'user', content: 'synthetic-only' }], ...overrides,
});
const fixture = (maxUsd = 1) => {
  const directory = path.resolve(`saves/minecraft/progressive_reports/haiku-budget-unit-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true }); directories.push(directory);
  return new ActualUsageBudget(path.join(directory, 'ledger.json'), { maxUsd, maxRequests: 10, margin: 1.25 });
};
const upperBound = (request: string) => {
  const input = Buffer.byteLength(request, 'utf8') + 4096;
  return (input * 0.2 + 8192 * 0.5) * (input > 100_000 ? 5 : 1) / 1e6 * 1.25;
};

describe('Haiku native usage pricing', () => {
  it('prices uncached input, both cache TTLs, reads and total output once', () => {
    expect(anthropicUsageCostUsd(model, usage())).toBeCloseTo((1000 * 0.1 + 100 * 0.125 + 400 * 0.2 + 2000 * 0.01 + 100 * 0.5) / 1e6, 12);
    expect(modelUsageCostUsd(model, usage())).toBe(anthropicUsageCostUsd(model, usage()));
  });
  it('uses the complete prompt length and multiplies every rate only above 100k', () => {
    const exact = usage({ input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 98_998,
      cache_creation: { ephemeral_5m_input_tokens: 250, ephemeral_1h_input_tokens: 750 } });
    const atThreshold = (2 * 0.1 + 250 * 0.125 + 750 * 0.2 + 98_998 * 0.01 + 100 * 0.5) / 1e6;
    expect(anthropicUsageCostUsd(model, exact)).toBeCloseTo(atThreshold, 12);
    expect(anthropicUsageCostUsd(model, { ...exact, cache_read_input_tokens: 98_999 }))
      .toBeCloseTo((atThreshold + 0.01 / 1e6) * 5, 12);
  });
  it('accepts explicit zero creation without a TTL breakdown and keeps known zero price', () => {
    expect(anthropicUsageCostUsd(model, usage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, cache_creation: undefined }))).toBe(0);
  });
  it.each([
    { input_tokens: undefined }, { output_tokens: undefined }, { cache_creation_input_tokens: undefined },
    { cache_read_input_tokens: undefined }, { cache_creation: undefined }, { cache_creation: null },
    { cache_creation: { ephemeral_5m_input_tokens: 100 } },
    { cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 401 } },
    { cache_creation_input_tokens: null }, { cache_read_input_tokens: -1 }, { input_tokens: '1000' },
    { output_tokens: 1.5 }, { output_tokens: Infinity }, { cache_read_input_tokens: NaN },
    { input_tokens: Number.MAX_SAFE_INTEGER },
  ])('holds unknown price for malformed or incomplete usage %j', malformed => {
    expect(anthropicUsageCostUsd(model, usage(malformed) as any)).toBeNull();
  });
  it.each(['claude-unknown', 'constructor', '__proto__'])('refuses an unsupported model instead of assigning Haiku prices: %s', unknown => {
    expect(modelUsageCostUsd(unknown, usage())).toBeNull();
  });
  it('retains the historical valid prices of old models and omitted zero cache fields', () => {
    const old = { input_tokens: 900, output_tokens: 200, cache_creation_input_tokens: 1500, cache_read_input_tokens: 25_000 };
    expect(anthropicUsageCostUsd('claude-sonnet-5-5', old)).toBeCloseTo((900 * 2 + 1500 * 2.5 + 25_000 * 0.2 + 200 * 10) / 1e6, 12);
    expect(anthropicUsageCostUsd('claude-opus-5-5', old)).toBeCloseTo((900 * 4 + 1500 * 5 + 25_000 * 0.2 + 200 * 20) / 1e6, 12);
    expect(anthropicUsageCostUsd('claude-haiku-4-5', { input_tokens: 1000, output_tokens: 100 }))
      .toBeCloseTo((1000 + 100 * 5) / 1e6, 12);
  });
  it('can price an explicit old-model 1h breakdown without double counting its total', () => {
    expect(anthropicUsageCostUsd('claude-sonnet-5-5', usage())).toBeCloseTo((1000 * 2 + 100 * 2.5 + 400 * 4 + 2000 * 0.2 + 100 * 10) / 1e6, 12);
  });
  it.each([-1, 1.5, NaN, Infinity, '1000', null])('keeps malformed Luna cache counts unknown: %j', cached => {
    expect(lunaUsageCostUsd({ input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: cached as any } })).toBeNull();
  });
  it('does not clamp an impossible Luna cache count into a cheaper known cost', () => {
    expect(lunaUsageCostUsd({ input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 1001 } })).toBeNull();
  });
});

describe('Haiku bounded reservation and restart-safe settlement', () => {
  it('reserves UTF8 request bytes plus overhead at worst 1h write and full native output price', () => {
    const budget = fixture(), request = body({ messages: [{ role: 'user', content: '漢字の合成データ' }] });
    expect(Buffer.byteLength(request)).toBeGreaterThan(request.length);
    expect(budget.reserve(request).reservedUsd).toBeCloseTo(upperBound(request), 12);
    const saved = fs.readFileSync(budget.file, 'utf8');
    expect(saved).not.toContain('synthetic-only'); expect(saved).not.toContain('漢字');
  });
  it('reserves long input and output at the fivefold tier rather than assuming a small actual prompt', () => {
    const budget = fixture(), request = body({ messages: [{ role: 'user', content: 'x'.repeat(100_000) }] });
    expect(budget.reserve(request).reservedUsd).toBeCloseTo(upperBound(request), 12);
  });
  it.each([undefined, 0, -1, 1.5, 8193, '8192'])('rejects a missing, malformed or over-cap output before reservation: %j', max_tokens => {
    const budget = fixture();
    expect(() => budget.reserve(body({ max_tokens }))).toThrow('BOUND_INVALID');
    expect(fs.existsSync(budget.file)).toBe(false);
  });
  it('separates a known price without margin from charged budget and survives a reopened v2 ledger', () => {
    const budget = fixture(), first = budget.reserve(body());
    const reopened = new ActualUsageBudget(budget.file, { maxUsd: 1, maxRequests: 10, margin: 1.25 });
    const result = reopened.settle(first.request, usage(), model);
    expect(result.priceDerivedUsd).toBe(anthropicUsageCostUsd(model, usage()));
    expect(result.chargedUsd).toBeCloseTo(result.priceDerivedUsd! * 1.25, 12);
    expect(result.unknownReservedUsd).toBe(0);
    expect(JSON.parse(fs.readFileSync(budget.file, 'utf8')).version).toBe(2);
  });
  it('keeps missing usage charged at the held bound and never frees room after a restart', () => {
    const request = body(), budget = fixture(upperBound(request) * 1.5), first = budget.reserve(request);
    const result = budget.settle(first.request, undefined, model);
    expect(result.priceDerivedUsd).toBeNull(); expect(result.unknownReservedUsd).toBe(first.reservedUsd);
    expect(result.chargedUsd).toBe(first.reservedUsd);
    const reopened = new ActualUsageBudget(budget.file, { maxUsd: budget.maxUsd, maxRequests: 10, margin: 1.25 });
    expect(() => reopened.reserve(request)).toThrow('EXHAUSTED');
    expect(JSON.parse(fs.readFileSync(budget.file, 'utf8')).settledUsd).toBe(first.reservedUsd);
  });
  it('keeps a mismatched TTL total unknown instead of charging an incomplete cheaper usage', () => {
    const budget = fixture(), first = budget.reserve(body());
    const result = budget.settle(first.request, usage({ cache_creation_input_tokens: 501 }), model);
    expect(result.priceDerivedUsd).toBeNull(); expect(result.unknownReservedUsd).toBe(first.reservedUsd);
  });
  it('preserves existing v2 mixed settled amounts without reclassifying historical cost', () => {
    const budget = fixture();
    fs.writeFileSync(budget.file, JSON.stringify({ version: 2, requests: 4, settledUsd: 0.25,
      inFlight: { '4': upperBound(body()) }, maxUsd: 1, margin: 1.25 }));
    const result = budget.settle(4, usage(), model);
    expect(result.settledUsd).toBeCloseTo(0.25 + result.chargedUsd, 12);
    expect(result.priceDerivedUsd).toBe(anthropicUsageCostUsd(model, usage()));
    expect(budget.reserve(body()).request).toBe(5);
  });
  it('returns known zero for a definite refusal but retains consumed request count', () => {
    const budget = fixture(), first = budget.reserve(body());
    expect(budget.settleRejected(first.request)).toEqual({ chargedUsd: 0, settledUsd: 0, priceDerivedUsd: 0, unknownReservedUsd: 0 });
    expect(budget.reserve(body()).request).toBe(2);
  });
  it('rejects a second settlement without changing the committed total', () => {
    const budget = fixture(), first = budget.reserve(body()); budget.settle(first.request, null, model);
    const before = fs.readFileSync(budget.file, 'utf8');
    expect(() => budget.settle(first.request, usage(), model)).toThrow('RESERVATION_UNKNOWN');
    expect(fs.readFileSync(budget.file, 'utf8')).toBe(before);
  });
  it('retains old-model 5m reservation price and honors an explicitly requested 1h bound', () => {
    const oldBody = JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 8192, messages: [] });
    const oldInputBound = Buffer.byteLength(oldBody) + 4096;
    expect(fixture().reserve(oldBody).reservedUsd).toBeCloseTo((oldInputBound * 2.5 + 8192 * 10) / 1e6 * 1.25, 12);
    const hourBody = body({ model: 'claude-sonnet-5-5' });
    expect(fixture().reserve(hourBody).reservedUsd).toBeCloseTo(((Buffer.byteLength(hourBody) + 4096) * 4 + 8192 * 10) / 1e6 * 1.25, 12);
  });
});
