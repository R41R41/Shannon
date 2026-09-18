import axios from 'axios';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

export interface WebSearchQuery {
  query: string;
  siteSearch?: string;
  dateRestrict?: string;
  num?: number;
  start?: number;
  gl?: string;
  lr?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  provider: 'anthropic' | 'brave' | 'google';
}

export interface WebSearchResponse {
  provider: string;
  answer?: string;
  results: WebSearchResult[];
}

function diversify(results: WebSearchResult[], limit: number, singleDomain?: string): WebSearchResult[] {
  if (singleDomain) return results.slice(0, limit);
  const counts = new Map<string, number>();
  const output: WebSearchResult[] = [];
  for (const result of results) {
    let host = result.url;
    try { host = new URL(result.url).hostname.replace(/^www\./, ''); } catch { /* keep URL */ }
    const count = counts.get(host) ?? 0;
    if (count >= 2) continue;
    counts.set(host, count + 1);
    output.push(result);
    if (output.length >= limit) break;
  }
  return output;
}

function collectAnthropicBlocks(value: unknown, results: WebSearchResult[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectAnthropicBlocks(item, results));
    return;
  }
  const block = value as Record<string, unknown>;
  if (block.type === 'web_search_result' && typeof block.url === 'string') {
    results.push({
      provider: 'anthropic',
      title: typeof block.title === 'string' ? block.title : block.url,
      url: block.url,
      snippet: typeof block.page_age === 'string' ? `更新: ${block.page_age}` : '',
    });
  }
  Object.values(block).forEach((item) => collectAnthropicBlocks(item, results));
}

async function anthropicSearch(query: WebSearchQuery): Promise<WebSearchResponse> {
  if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const domain = query.siteSearch?.replace(/^https?:\/\//, '').split('/')[0];
  const tool: Record<string, unknown> = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 3,
    user_location: { type: 'approximate', country: (query.gl ?? 'JP').toUpperCase(), timezone: 'Asia/Tokyo' },
  };
  if (domain) tool.allowed_domains = [domain];
  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: config.anthropic.model,
    max_tokens: 2500,
    messages: [{
      role: 'user',
      content: `Search the web for: ${query.query}\nReturn a concise list of the most relevant independent sources with title, URL, and a factual one-sentence summary. Prefer primary/official sources when applicable.`,
    }],
    tools: [tool],
  }, {
    headers: {
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    timeout: 45_000,
    maxContentLength: 2 * 1024 * 1024,
  });
  const results: WebSearchResult[] = [];
  collectAnthropicBlocks(response.data?.content, results);
  const answer = (response.data?.content ?? [])
    .filter((block: { type?: string }) => block.type === 'text')
    .map((block: { text?: string }) => block.text ?? '')
    .join('\n').trim();
  if (!results.length && !answer) throw new Error('Anthropic web search returned no usable content');
  return { provider: 'anthropic', answer, results };
}

async function braveSearch(query: WebSearchQuery): Promise<WebSearchResponse> {
  if (!config.webSearch.braveApiKey) throw new Error('BRAVE_SEARCH_API_KEY is not configured');
  const q = query.siteSearch ? `${query.query} site:${query.siteSearch}` : query.query;
  const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
    headers: { 'X-Subscription-Token': config.webSearch.braveApiKey, Accept: 'application/json' },
    params: {
      q,
      count: Math.min(20, Math.max(1, query.num ?? 10)),
      offset: Math.max(0, (query.start ?? 1) - 1),
      country: (query.gl ?? 'JP').toUpperCase(),
      search_lang: query.lr?.replace(/^lang_/, '') ?? 'ja',
      extra_snippets: true,
    },
    timeout: 15_000,
  });
  const items = response.data?.web?.results ?? [];
  const results: WebSearchResult[] = items.map((item: Record<string, unknown>) => ({
    provider: 'brave' as const,
    title: String(item.title ?? item.url ?? 'タイトルなし'),
    url: String(item.url ?? ''),
    snippet: [item.description, ...(Array.isArray(item.extra_snippets) ? item.extra_snippets : [])]
      .filter(Boolean).join(' ').slice(0, 1000),
  })).filter((item: WebSearchResult) => item.url.startsWith('http'));
  if (!results.length) throw new Error('Brave Search returned no results');
  return { provider: 'brave', results };
}

async function googleSearch(query: WebSearchQuery): Promise<WebSearchResponse> {
  if (!config.google.apiKey || !config.google.searchEngineId) throw new Error('Google CSE is not configured');
  const params = new URLSearchParams({ key: config.google.apiKey, cx: config.google.searchEngineId, q: query.query });
  if (query.dateRestrict) params.set('dateRestrict', query.dateRestrict);
  if (query.siteSearch) params.set('siteSearch', query.siteSearch);
  if (query.num) params.set('num', String(Math.min(10, query.num)));
  if (query.start) params.set('start', String(query.start));
  if (query.gl) params.set('gl', query.gl);
  if (query.lr) params.set('lr', query.lr);
  const response = await axios.get(`https://www.googleapis.com/customsearch/v1?${params}`, { timeout: 15_000 });
  const results: WebSearchResult[] = (response.data?.items ?? []).map((item: Record<string, unknown>) => ({
    provider: 'google' as const,
    title: String(item.title ?? item.link ?? 'タイトルなし'),
    url: String(item.link ?? ''),
    snippet: String(item.snippet ?? ''),
  })).filter((item: WebSearchResult) => item.url.startsWith('http'));
  if (!results.length) throw new Error('Google CSE returned no results');
  return { provider: 'google', results };
}

const providers = { anthropic: anthropicSearch, brave: braveSearch, google: googleSearch } as const;

export async function searchWeb(query: WebSearchQuery): Promise<WebSearchResponse> {
  const failures: string[] = [];
  for (const name of config.webSearch.providerOrder) {
    const provider = providers[name as keyof typeof providers];
    if (!provider) continue;
    try {
      const response = await provider(query);
      return {
        ...response,
        results: diversify(response.results, Math.min(10, Math.max(1, query.num ?? 8)), query.siteSearch),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
      logger.warn(`[WebSearch] ${name} failed; trying next provider: ${message}`);
    }
  }
  throw new Error(`No web search provider succeeded (${failures.join(' | ')})`);
}
