import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AcceptanceBudget, ActualUsageBudget, lunaUsageCostUsd, seedSharedCampaignBudget } from '../../src/services/minebot/testing/AcceptanceBudget.js';
const files: string[] = [];
afterEach(() => { for (const file of files.splice(0)) for (const suffix of ['', '.lock']) if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix); });
const fixture = () => {
  const file = path.resolve(`saves/minecraft/progressive_reports/budget-unit-${randomUUID()}.json`); files.push(file);
  return new AcceptanceBudget(file);
};
const body = JSON.stringify({ model: 'gpt-5.6-luna', max_output_tokens: 4096, input: 'test-only' });
describe('shared isolated acceptance budget', () => {
  it('reserves before dispatch, survives retries/restarts, and stays below the approved yen ceiling', () => {
    const budget = fixture();
    expect(budget.reserve(body).request).toBe(1);
    expect(new AcceptanceBudget(budget.file).reserve(body).request).toBe(2);
    const state = JSON.parse(fs.readFileSync(budget.file, 'utf8'));
    expect(state.requests).toBe(2); expect(state.yenCeilingWithMargin).toBeLessThan(1000);
    expect((0.4940417 + budget.maxUsd) * 300 * 1.25).toBeLessThan(1000);
    expect(fs.readFileSync(budget.file, 'utf8')).not.toContain('test-only');
  });
  it('refuses exhausted or malformed ledgers without resetting spent reservations', () => {
    const budget = fixture(); budget.reserve(body);
    fs.writeFileSync(budget.file, JSON.stringify({ version: 1, requests: budget.maxRequests, reservedUsd: 1 }));
    expect(() => budget.reserve(body)).toThrow('EXHAUSTED');
    expect(JSON.parse(fs.readFileSync(budget.file, 'utf8')).requests).toBe(budget.maxRequests);
    fs.writeFileSync(budget.file, '{}'); expect(() => budget.reserve(body)).toThrow('INVALID');
    expect(fs.existsSync(budget.file + '.lock')).toBe(false);
  });
  it('does not bypass an existing lock or admit another model/unbounded output', () => {
    const budget = fixture(); fs.writeFileSync(budget.file + '.lock', 'other-owner');
    expect(() => budget.reserve(body)).toThrow();
    expect(fs.readFileSync(budget.file + '.lock', 'utf8')).toBe('other-owner');
    expect(() => budget.reserve('{}')).toThrow('BOUND_INVALID');
    expect(() => new AcceptanceBudget('/tmp/unapproved.json')).toThrow('OUTSIDE_LAB');
  });
  it('consolidates prior world reservations exactly once before further requests', () => {
    const shared = fixture();
    const legacy1 = fixture(); const legacy2 = fixture();
    fs.writeFileSync(legacy1.file, JSON.stringify({ version: 1, requests: 31, reservedUsd: 1.220212 }));
    fs.writeFileSync(legacy2.file, JSON.stringify({ version: 1, requests: 62, reservedUsd: 2.5978292 }));
    seedSharedCampaignBudget(shared.file, [legacy1.file, legacy2.file]);
    const seeded = JSON.parse(fs.readFileSync(shared.file, 'utf8'));
    expect(seeded.requests).toBe(93);
    expect(seeded.reservedUsd).toBeCloseTo(3.8180412);
    seedSharedCampaignBudget(shared.file, [legacy1.file, legacy2.file]);
    expect(JSON.parse(fs.readFileSync(shared.file, 'utf8')).requests).toBe(93);
    const campaign = new AcceptanceBudget(shared.file, { maxUsd: 8, maxRequests: 500, priorReservedUsd: 0 });
    expect(campaign.reserve(body).request).toBe(94);
    expect(JSON.parse(fs.readFileSync(shared.file, 'utf8')).yenCeilingWithMargin).toBeLessThan(3000);
  });
});

describe('actual-usage acceptance budget', () => {
  const actual = (maxUsd = 1, maxRequests = 100) => {
    const file = path.resolve(`saves/minecraft/progressive_reports/budget-unit-${randomUUID()}.json`); files.push(file);
    return new ActualUsageBudget(file, { maxUsd, maxRequests });
  };
  it('prices usage with the official Luna rates, cached input and the long-context surcharge', () => {
    expect(lunaUsageCostUsd({ input_tokens: 200_000, output_tokens: 1_000_000 })).toBeCloseTo(0.04 + 1.20, 6);
    expect(lunaUsageCostUsd({ input_tokens: 1_000_000, output_tokens: 0,
      input_tokens_details: { cached_tokens: 1_000_000 } })).toBeCloseTo(0.02 * 2, 6);
    expect(lunaUsageCostUsd({ input_tokens: 10_000, output_tokens: 50 })).toBeCloseTo((10_000 * 0.2 + 50 * 1.2) / 1e6, 9);
    expect(lunaUsageCostUsd({ input_tokens: 300_000, output_tokens: 1000 })).toBeCloseTo((300_000 * 0.4 + 1000 * 1.8) / 1e6, 9);
    expect(lunaUsageCostUsd(undefined)).toBeNull();
  });
  it('reserves an upper bound, then settles to billed usage with margin, across restarts', () => {
    const budget = actual();
    const first = budget.reserve(body);
    expect(first.reservedUsd).toBeGreaterThan(lunaUsageCostUsd({ input_tokens: 15_000, output_tokens: 50 })! * 1.25);
    let state = JSON.parse(fs.readFileSync(budget.file, 'utf8'));
    expect(state.inFlightUsd).toBeCloseTo(first.reservedUsd, 9);
    const settled = new ActualUsageBudget(budget.file, { maxUsd: 1, maxRequests: 100 })
      .settle(first.request, { input_tokens: 100, output_tokens: 10 });
    expect(settled.chargedUsd).toBeCloseTo((100 * 0.2 + 10 * 1.2) / 1e6 * 1.25, 12);
    state = JSON.parse(fs.readFileSync(budget.file, 'utf8'));
    expect(state.inFlight).toEqual({});
    expect(state.committedUsd).toBeCloseTo(settled.chargedUsd, 12);
    expect(fs.readFileSync(budget.file, 'utf8')).not.toContain('test-only');
  });
  it('releases a request the provider refused outright without charging it (58 refusals had cost a dollar of the cap)', () => {
    const budget = actual();
    const refused = budget.reserve(body);
    expect(budget.settleRejected(refused.request)).toEqual({ chargedUsd: 0, settledUsd: 0, priceDerivedUsd: 0, unknownReservedUsd: 0 });
    const state = JSON.parse(fs.readFileSync(budget.file, 'utf8'));
    expect(state).toMatchObject({ inFlight: {}, committedUsd: 0, rejected: 1, requests: 1 });
    expect(() => budget.settleRejected(refused.request)).toThrow('ACCEPTANCE_RESERVATION_UNKNOWN');
  });
  it('keeps an unsettled or usage-less request at its bound and refuses beyond the cap', () => {
    const budget = actual(0.01);
    const first = budget.reserve(body);
    budget.settle(first.request, null);
    const state = JSON.parse(fs.readFileSync(budget.file, 'utf8'));
    expect(state.settledUsd).toBeCloseTo(first.reservedUsd, 12);
    expect(() => budget.reserve(body)).toThrow('ACCEPTANCE_SHARED_BUDGET_EXHAUSTED');
    expect(() => budget.settle(first.request, { input_tokens: 1, output_tokens: 1 })).toThrow('RESERVATION_UNKNOWN');
    expect(fs.existsSync(budget.file + '.lock')).toBe(false);
  });
});

describe('actual-usage budget shared by parallel runs', () => {
  it('waits for another writer instead of failing, and still refuses a lock that is never released', async () => {
    const file = path.resolve(`saves/minecraft/progressive_reports/budget-unit-${randomUUID()}.json`); files.push(file);
    const budget = new ActualUsageBudget(file, { maxUsd: 1, maxRequests: 100 });
    // The synchronous wait blocks timers, so another process releases the lock.
    const { spawn } = await import('node:child_process');
    fs.writeFileSync(file + '.lock', 'other-run');
    spawn(process.execPath, ['-e', `setTimeout(() => require('fs').unlinkSync(${JSON.stringify(file + '.lock')}), 150)`]);
    expect(budget.reserve(body).request).toBe(1);
    fs.writeFileSync(file + '.lock', 'stuck');
    const started = Date.now();
    expect(() => (budget as any).update(() => 0)).toThrow('EEXIST');
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
    fs.unlinkSync(file + '.lock');
  }, 20_000);
});
