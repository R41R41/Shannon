import fs from 'node:fs';
import path from 'node:path';
import { acquireExclusiveFileLock } from '../utils/exclusiveFileLock.js';

/** One restart-resistant allocation shared by flat regression and natural-world
 * retries. Values are conservative reservations, not settled billing/FX quotes.
 * Prior accepted runs: $0.2007276 + $0.2933141. At a deliberately conservative
 * 300 JPY/USD plus 25% margin, prior + $2.00 stays below the approved 1,000 JPY.
 */
export class AcceptanceBudget {
  readonly maxUsd: number;
  readonly maxRequests: number;
  readonly priorReservedUsd: number;
  constructor(readonly file: string, options: { maxUsd?: number; maxRequests?: number; priorReservedUsd?: number } = {}) {
    this.maxUsd = options.maxUsd ?? 2;
    this.maxRequests = options.maxRequests ?? 120;
    this.priorReservedUsd = options.priorReservedUsd ?? 0.4940417;
    if (!Number.isFinite(this.maxUsd) || this.maxUsd <= 0 || !Number.isInteger(this.maxRequests) || this.maxRequests < 1
      || !Number.isFinite(this.priorReservedUsd) || this.priorReservedUsd < 0) throw new Error('ACCEPTANCE_BUDGET_POLICY_INVALID');
    const root = path.resolve('saves/minecraft/progressive_reports');
    if (!path.resolve(file).startsWith(`${root}${path.sep}`)) throw new Error('ACCEPTANCE_LEDGER_OUTSIDE_LAB');
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  reserve(body: string): { request: number; reservedUsd: number; totalReservedUsd: number } {
    const parsed = JSON.parse(body);
    if (parsed.model !== 'gpt-5.6-luna' || !Number.isInteger(parsed.max_output_tokens) || parsed.max_output_tokens < 1) throw new Error('ACCEPTANCE_MODEL_OR_OUTPUT_BOUND_INVALID');
    const cost = ((Buffer.byteLength(body) + 4096) * 0.50 + parsed.max_output_tokens * 1.80) / 1_000_000;
    const lock = fs.openSync(`${this.file}.lock`, 'wx', 0o600);
    try {
      const state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, requests: 0, reservedUsd: 0 };
      if (state.version !== 1 || !Number.isInteger(state.requests) || state.requests < 0 || !Number.isFinite(state.reservedUsd) || state.reservedUsd < 0) throw new Error('ACCEPTANCE_LEDGER_INVALID');
      if (state.maxUsd !== undefined && state.maxUsd !== this.maxUsd) throw new Error('ACCEPTANCE_LEDGER_POLICY_MISMATCH');
      if (state.requests >= this.maxRequests || state.reservedUsd + cost > this.maxUsd) throw new Error('ACCEPTANCE_SHARED_BUDGET_EXHAUSTED');
      const next = { ...state, requests: state.requests + 1, reservedUsd: state.reservedUsd + cost,
        maxRequests: this.maxRequests, maxUsd: this.maxUsd, priorReservedUsd: this.priorReservedUsd,
        yenCeilingWithMargin: (this.priorReservedUsd + state.reservedUsd + cost) * 300 * 1.25 };
      const temporary = `${this.file}.pending-${process.pid}`;
      const fd = fs.openSync(temporary, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
      const dir = fs.openSync(path.dirname(this.file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      return { request: next.requests, reservedUsd: cost, totalReservedUsd: next.reservedUsd };
    } finally { fs.closeSync(lock); fs.unlinkSync(`${this.file}.lock`); }
  }
}

/** Official GPT-5.6 Luna prices (USD per 1M tokens), checked 2026-10-01. */
export const LUNA_PRICING = { input: 0.20, cachedInput: 0.02, output: 1.20,
  longContextInputTokens: 272_000, longContextInputMultiplier: 2, longContextOutputMultiplier: 1.5 } as const;

type ResponseUsage = { input_tokens?: number; output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null } | null | undefined;

const tokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Priced cost of one Responses API usage block, before any safety margin. */
export function lunaUsageCostUsd(usage: ResponseUsage): number | null {
  const input = usage?.input_tokens, output = usage?.output_tokens;
  if (!tokenCount(input) || !tokenCount(output)) return null;
  const cached = usage?.input_tokens_details?.cached_tokens === undefined ? 0 : usage.input_tokens_details.cached_tokens;
  if (!tokenCount(cached) || cached > input) return null;
  const long = input! > LUNA_PRICING.longContextInputTokens;
  const inputRate = LUNA_PRICING.input * (long ? LUNA_PRICING.longContextInputMultiplier : 1);
  const cachedRate = LUNA_PRICING.cachedInput * (long ? LUNA_PRICING.longContextInputMultiplier : 1);
  const outputRate = LUNA_PRICING.output * (long ? LUNA_PRICING.longContextOutputMultiplier : 1);
  return ((input! - cached) * inputRate + cached * cachedRate + output! * outputRate) / 1_000_000;
}

/**
 * Prices of the other planners a run may be compared with (USD per 1M tokens, official list prices).
 * `cachedInput` is a cache read; `cacheWrite` is the first write of a cached prefix. Anthropic reports
 * uncached input, cache writes and cache reads as three separate counts.
 */
export interface AnthropicPricing { input: number; cacheWrite: number; cacheWrite1h?: number; cachedInput: number; output: number }
/** Official list prices, checked 2026-10-01 at platform.claude.com/docs/en/about-claude/pricing (5-minute cache writes; standard, global routing). */
export const ANTHROPIC_PRICING: Record<string, AnthropicPricing> = {
  'claude-sonnet-5-5': { input: 2, cacheWrite: 2.5, cachedInput: 0.2, output: 10 },
  'claude-opus-5-5': { input: 4, cacheWrite: 5, cachedInput: 0.2, output: 20 },
  // Checked 2026-10-05 (the same price list): the cheaper planner the user asked to compare.
  'claude-haiku-4-5': { input: 1, cacheWrite: 1.25, cachedInput: 0.1, output: 5 },
  // Checked 2026-10-08. Prompts above 100k tokens multiply every rate by five.
  'claude-haiku-5-5': { input: 0.1, cacheWrite: 0.125, cacheWrite1h: 0.2, cachedInput: 0.01, output: 0.5 },
};

type AnthropicUsage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null } | null | undefined;

export function anthropicUsageCostUsd(model: string, usage: AnthropicUsage): number | null {
  const pricing = Object.prototype.hasOwnProperty.call(ANTHROPIC_PRICING, model) ? ANTHROPIC_PRICING[model] : undefined;
  const input = usage?.input_tokens, output = usage?.output_tokens;
  if (!pricing || !tokenCount(input) || !tokenCount(output)) return null;
  const haiku = model === 'claude-haiku-5-5';
  // Older recorded usage omitted zero cache fields. New native usage must be complete.
  if (haiku && (usage?.cache_creation_input_tokens === undefined || usage.cache_read_input_tokens === undefined)) return null;
  const written = usage?.cache_creation_input_tokens === undefined ? 0 : usage.cache_creation_input_tokens;
  const read = usage?.cache_read_input_tokens === undefined ? 0 : usage.cache_read_input_tokens;
  if (!tokenCount(written) || !tokenCount(read)) return null;
  let fiveMinutes = written, oneHour = 0;
  if (usage?.cache_creation !== undefined) {
    const detail = usage.cache_creation;
    if (!detail || !tokenCount(detail.ephemeral_5m_input_tokens) || !tokenCount(detail.ephemeral_1h_input_tokens)) return null;
    fiveMinutes = detail.ephemeral_5m_input_tokens; oneHour = detail.ephemeral_1h_input_tokens;
    if (!Number.isSafeInteger(fiveMinutes + oneHour) || fiveMinutes + oneHour !== written) return null;
  } else if (haiku && written > 0) return null; // A write with an unknown TTL has an unknown price.
  const totalInput = input + written + read;
  if (!Number.isSafeInteger(totalInput)) return null;
  const multiplier = haiku && totalInput > 100_000 ? 5 : 1;
  return (input * pricing.input + fiveMinutes * pricing.cacheWrite
    + oneHour * (pricing.cacheWrite1h ?? pricing.input * 2) + read * pricing.cachedInput + output * pricing.output) * multiplier / 1_000_000;
}

/** Cost of one response's usage for whichever planner made the request; null when it cannot be priced. */
export function modelUsageCostUsd(model: string, usage: unknown): number | null {
  const cost = model === 'gpt-5.6-luna' ? lunaUsageCostUsd(usage as ResponseUsage) : anthropicUsageCostUsd(model, usage as AnthropicUsage);
  return cost !== null && Number.isFinite(cost) ? cost : null;
}

/** Per-request evidence, separate from the margin-bearing operational budget. */
export interface ActualUsageSettlement {
  chargedUsd: number;
  settledUsd: number;
  /** Usage × list price, without margin; null means usage/price is not known. */
  priceDerivedUsd: number | null;
  /** The held bound, including the existing safety margin; never claimed as a bill. */
  unknownReservedUsd: number;
}

function hasOneHourCache(request: unknown): boolean {
  const pending = [request];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (!Array.isArray(value) && (value as { cache_control?: { ttl?: unknown } }).cache_control?.ttl === '1h') return true;
    for (const child of Object.values(value)) pending.push(child);
  }
  return false;
}

/**
 * Cap measured in actual billed usage. Each request first reserves a bound
 * that no response can exceed (one token per request byte, the full output
 * limit, long-context rates), then settles to the response's reported usage.
 * A request without usage (network error, abort) stays charged at its bound;
 * one the provider refused outright (4xx) is released without charge.
 * Operational budget amounts include `margin`; priceDerivedUsd does not.
 */
export class ActualUsageBudget {
  readonly maxUsd: number;
  readonly maxRequests: number;
  readonly margin: number;
  constructor(readonly file: string, options: { maxUsd: number; maxRequests: number; margin?: number }) {
    this.maxUsd = options.maxUsd;
    this.maxRequests = options.maxRequests;
    this.margin = options.margin ?? 1.25;
    if (!Number.isFinite(this.maxUsd) || this.maxUsd <= 0 || !Number.isInteger(this.maxRequests) || this.maxRequests < 1
      || !Number.isFinite(this.margin) || this.margin < 1) throw new Error('ACCEPTANCE_BUDGET_POLICY_INVALID');
    const root = path.resolve('saves/minecraft/progressive_reports');
    if (!path.resolve(file).startsWith(`${root}${path.sep}`)) throw new Error('ACCEPTANCE_LEDGER_OUTSIDE_LAB');
  }

  private update<T>(change: (state: any) => T): T {
    // Parallel isolated runs share one approval: wait briefly for another
    // writer instead of failing that run's model request.
    const lock = acquireExclusiveFileLock(`${this.file}.lock`);
    try {
      const state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
        : { version: 2, requests: 0, settledUsd: 0, inFlight: {} };
      if (state.version !== 2 || !Number.isInteger(state.requests) || !Number.isFinite(state.settledUsd)
        || typeof state.inFlight !== 'object' || state.inFlight === null) throw new Error('ACCEPTANCE_LEDGER_INVALID');
      if (state.maxUsd !== undefined && state.maxUsd !== this.maxUsd) throw new Error('ACCEPTANCE_LEDGER_POLICY_MISMATCH');
      const result = change(state);
      const inFlightUsd = Object.values(state.inFlight as Record<string, number>).reduce((sum, value) => sum + value, 0);
      const next = { ...state, maxUsd: this.maxUsd, maxRequests: this.maxRequests, margin: this.margin,
        pricing: LUNA_PRICING, inFlightUsd, committedUsd: state.settledUsd + inFlightUsd };
      const temporary = `${this.file}.pending-${process.pid}`;
      const fd = fs.openSync(temporary, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
      const dir = fs.openSync(path.dirname(this.file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      return result;
    } finally { fs.closeSync(lock); fs.unlinkSync(`${this.file}.lock`); }
  }

  reserve(body: string): { request: number; reservedUsd: number; totalCommittedUsd: number } {
    const parsed = JSON.parse(body);
    const outputBound = parsed.model === 'gpt-5.6-luna' ? parsed.max_output_tokens : parsed.max_tokens;
    if ((parsed.model !== 'gpt-5.6-luna' && !Object.prototype.hasOwnProperty.call(ANTHROPIC_PRICING, parsed.model)) || !Number.isSafeInteger(outputBound) || outputBound < 1
      || (parsed.model === 'claude-haiku-5-5' && outputBound > 8192))
      throw new Error('ACCEPTANCE_MODEL_OR_OUTPUT_BOUND_INVALID');
    // A token covers at least one byte of the request, so bytes bound the input
    // (for a cached prompt, at the price of writing it, the dearest way to send it).
    const inputBound = Buffer.byteLength(body) + 4096;
    const oneHour = parsed.model === 'claude-haiku-5-5' || hasOneHourCache(parsed);
    const bound = parsed.model === 'gpt-5.6-luna' ? lunaUsageCostUsd({ input_tokens: inputBound, output_tokens: outputBound })
      : anthropicUsageCostUsd(parsed.model, { input_tokens: 0, cache_creation_input_tokens: inputBound, cache_read_input_tokens: 0,
        output_tokens: outputBound, ...(oneHour ? { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: inputBound } } : {}) });
    if (bound === null) throw new Error('ACCEPTANCE_MODEL_OR_OUTPUT_BOUND_INVALID');
    const reservedUsd = bound! * this.margin;
    return this.update(state => {
      const committed = state.settledUsd + Object.values(state.inFlight as Record<string, number>).reduce((sum, value) => sum + value, 0);
      if (state.requests >= this.maxRequests || committed + reservedUsd > this.maxUsd) throw new Error('ACCEPTANCE_SHARED_BUDGET_EXHAUSTED');
      state.requests += 1;
      state.inFlight[String(state.requests)] = reservedUsd;
      return { request: state.requests, reservedUsd, totalCommittedUsd: committed + reservedUsd };
    });
  }

  /** Replace a reservation with the billed usage; missing usage keeps the bound. */
  settle(request: number, usage: unknown, model = 'gpt-5.6-luna'): ActualUsageSettlement {
    const cost = modelUsageCostUsd(model, usage);
    return this.update(state => {
      const reserved = state.inFlight[String(request)];
      if (!Number.isFinite(reserved)) throw new Error('ACCEPTANCE_RESERVATION_UNKNOWN');
      delete state.inFlight[String(request)];
      // Never under-record: billed usage above the bound still counts in full.
      const chargedUsd = cost === null ? reserved : cost * this.margin;
      state.settledUsd += chargedUsd;
      return { chargedUsd, settledUsd: state.settledUsd, priceDerivedUsd: cost, unknownReservedUsd: cost === null ? reserved : 0 };
    });
  }

  /**
   * Drop the reservation of a request the provider refused with a 4xx status
   * (bad request, rate limit, no credit): it was never processed, so nothing
   * is billed. Keeping such requests at their bound let 58 refusals for an
   * exhausted credit balance consume about a dollar of an approved cap.
   */
  settleRejected(request: number): ActualUsageSettlement {
    return this.update(state => {
      if (!Number.isFinite(state.inFlight[String(request)])) throw new Error('ACCEPTANCE_RESERVATION_UNKNOWN');
      delete state.inFlight[String(request)];
      state.rejected = (Number.isInteger(state.rejected) ? state.rejected : 0) + 1;
      return { chargedUsd: 0, settledUsd: state.settledUsd, priceDerivedUsd: 0, unknownReservedUsd: 0 };
    });
  }
}

/** Consolidate earlier isolated-world reservations into one campaign-wide cap.
 * This runs before any paid request; old ledgers remain immutable audit records.
 */
export function seedSharedCampaignBudget(file: string, legacyFiles: string[], maxUsd = 8, maxRequests = 500): void {
  const root = path.resolve('saves/minecraft/progressive_reports');
  if (!path.resolve(file).startsWith(`${root}${path.sep}`) || legacyFiles.some(source => !path.resolve(source).startsWith(`${root}${path.sep}`)))
    throw new Error('ACCEPTANCE_LEDGER_OUTSIDE_LAB');
  if (fs.existsSync(file)) return;
  const lock = fs.openSync(`${file}.migration.lock`, 'wx', 0o600);
  try {
    if (fs.existsSync(file)) return;
    let requests = 0;
    let reservedUsd = 0;
    for (const source of legacyFiles) {
      const state = JSON.parse(fs.readFileSync(source, 'utf8'));
      if (state.version !== 1 || !Number.isInteger(state.requests) || state.requests < 0
        || !Number.isFinite(state.reservedUsd) || state.reservedUsd < 0) throw new Error('ACCEPTANCE_LEGACY_LEDGER_INVALID');
      requests += state.requests;
      reservedUsd += state.reservedUsd;
    }
    if (reservedUsd > maxUsd || requests > maxRequests) throw new Error('ACCEPTANCE_LEGACY_BUDGET_EXHAUSTED');
    const next = { version: 1, requests, reservedUsd, maxUsd, maxRequests, priorReservedUsd: 0,
      yenCeilingWithMargin: reservedUsd * 300 * 1.25,
      migrationSources: legacyFiles.map(source => path.basename(source)) };
    const temporary = `${file}.pending-${process.pid}`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { fs.closeSync(lock); fs.unlinkSync(`${file}.migration.lock`); }
}
