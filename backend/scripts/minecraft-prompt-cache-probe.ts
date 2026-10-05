#!/usr/bin/env node
// Measures when the planner model's prompt cache is read, with a handful of
// tiny requests charged to the already approved actual-usage ledger. The
// campaign runs paid full price for ~16k input tokens on every call: usage
// showed cache writes and never a read.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { ActualUsageBudget } from '../src/services/minebot/testing/AcceptanceBudget.js';

if (process.env.MINECRAFT_CAMPAIGN_PAID_AUTHORIZED !== 'true' || process.env.MINECRAFT_CAMPAIGN_BUDGET_PROFILE !== 'actual-5000-20261001-afternoon')
  throw new Error('PROMPT_CACHE_PROBE_REQUIRES_APPROVED_LEDGER');
const budget = new ActualUsageBudget(path.resolve('saves/minecraft/progressive_reports/dragon-campaign-actual-5000-20261001-afternoon.json'),
  { maxUsd: 5000 / 160, maxRequests: 20000, margin: 1.25 });
const apiKey = dotenv.parse(fs.readFileSync('/home/azureuser/Shannon-current/backend/.env')).OPENAI_API_KEY ?? '';
if (!apiKey) throw new Error('PROMPT_CACHE_PROBE_KEY_UNAVAILABLE');

const nonce = `probe-${Date.now()}`;
// About 3k tokens of fixed text, unique to this run.
const stable = `${nonce}\n` + Array.from({ length: 220 }, (_, index) => `Rule ${index}: when the body reports fact ${index * 7}, record it and continue with the plan as written.`).join('\n');
const tools = Array.from({ length: 3 }, (_, index) => ({ type: 'function', name: `tool_${index}`, description: `Fixed tool ${index} used only to measure caching.`,
  parameters: { type: 'object', properties: { value: { type: 'string' } } }, strict: false }));
const user = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] });
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'output_text', text }] });
const results: any[] = [];
async function call(label: string, instructions: string, input: any[], extra: Record<string, unknown> = {}): Promise<void> {
  const body = JSON.stringify({ model: 'gpt-5.6-luna', store: false, reasoning: { effort: 'none' }, input, instructions,
    max_output_tokens: 16, tools, parallel_tool_calls: true, ...extra });
  const reservation = budget.reserve(body);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(30_000) });
    const payload: any = await response.json();
    if (response.status >= 400 && response.status < 500) { budget.settleRejected(reservation.request); results.push({ label, http: response.status, error: payload?.error?.code ?? payload?.error?.type }); return; }
    budget.settle(reservation.request, payload.usage);
    results.push({ label, input: payload.usage?.input_tokens, cached: payload.usage?.input_tokens_details?.cached_tokens,
      written: payload.usage?.input_tokens_details?.cache_write_tokens, details: payload.usage?.input_tokens_details });
  } catch (error) { budget.settle(reservation.request, null); results.push({ label, error: String(error) }); }
  await new Promise(resolve => setTimeout(resolve, 2500));
}
await call('1 baseline', stable, [user('tail one')]);
await call('2 same prefix, different last message', stable, [user('tail two')]);
await call('3 exact repeat of 1', stable, [user('tail one')]);
await call('4 extends 1 with further turns', stable, [user('tail one'), assistant('ok'), user('tail three')]);
await call('5 volatile text at the end of the instructions', `${stable}\nstate: ${Date.now()}`, [user('tail one')]);
await call('6 cache key, first', stable, [user('tail four')], { prompt_cache_key: nonce });
await call('7 cache key, different last message', stable, [user('tail five')], { prompt_cache_key: nonce });
await call('8 cache key, volatile instructions tail', `${stable}\nstate: ${Date.now()}`, [user('tail five')], { prompt_cache_key: nonce });
for (const row of results) console.log(JSON.stringify(row));
