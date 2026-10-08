/** Content-free projection of a campaign's provider receipts. Prices are
 * settled by AcceptanceBudget; this never guesses an invoice or account balance. */
type RequestReceipt = {
  request?: number; role?: string; phase?: string; provider?: string; requestedModel?: string;
  httpStatus?: number; durationMs?: number; priceDerivedUsd?: number | null;
  unknownReservedUsd?: number; chargedUsd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    cache_creation_input_tokens?: number; cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } };
};
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
const amount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const quantile = (values: number[], q: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
};
function total(rows: RequestReceipt[]) {
  let input = 0, read = 0, written = 0, write5m = 0, write1h = 0, output = 0;
  for (const row of rows) {
    const inputTotal = count(row.usage?.input_tokens);
    if (row.provider === 'openai' || row.requestedModel?.startsWith('gpt-')) {
      // OpenAI includes cache reads in input_tokens; native Anthropic doesn't.
      const cached = count(row.usage?.input_tokens_details?.cached_tokens);
      const validRead = cached <= inputTotal ? cached : 0;
      input += inputTotal - validRead; read += validRead;
    } else {
      input += inputTotal; read += count(row.usage?.cache_read_input_tokens);
    }
    written += count(row.usage?.cache_creation_input_tokens); output += count(row.usage?.output_tokens);
    write5m += count(row.usage?.cache_creation?.ephemeral_5m_input_tokens);
    write1h += count(row.usage?.cache_creation?.ephemeral_1h_input_tokens);
  }
  const promptTokens = input + read + written;
  return {
    requests: rows.length, usageReceipts: rows.filter(row => row.usage).length,
    pricedReceipts: rows.filter(row => typeof row.priceDerivedUsd === 'number' && Number.isFinite(row.priceDerivedUsd) && row.priceDerivedUsd >= 0).length,
    priceDerivedUsd: rows.reduce((sum, row) => sum + amount(row.priceDerivedUsd), 0),
    unknownReservedUsd: rows.reduce((sum, row) => sum + amount(row.unknownReservedUsd), 0),
    budgetChargedUsdWithMargin: rows.reduce((sum, row) => sum + amount(row.chargedUsd), 0),
    uncachedInputTokens: input, cacheReadTokens: read, cacheCreationTokens: written,
    cacheCreation5mTokens: write5m, cacheCreation1hTokens: write1h, outputTokensIncludingThinking: output,
    cacheReadRatio: promptTokens ? read / promptTokens : null,
    latencyMedianMs: quantile(rows.map(row => row.durationMs).filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0), .5),
    latencyP95Ms: quantile(rows.map(row => row.durationMs).filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0), .95),
  };
}
export function summarizeCampaignUsage(receipts: RequestReceipt[]) {
  // One reservation is one transmitted request. Duplicate settlement receipts
  // must not count as another request or another charge.
  const unique = new Map<number | string, RequestReceipt>();
  receipts.forEach((row, i) => unique.set(row.request ?? `legacy-${i}`, row));
  const rows = [...unique.values()];
  const groups = new Map<string, RequestReceipt[]>();
  for (const row of rows) {
    const key = [row.provider ?? 'unknown', row.requestedModel ?? 'unknown', row.role ?? 'unknown', row.phase ?? 'unknown'].join('/');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return { schemaVersion: 1, basis: 'provider_usage_at_recorded_prices_not_invoice', ...total(rows),
    groups: [...groups].map(([key, group]) => ({ key, ...total(group) })) };
}
