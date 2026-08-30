const HTTPS = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:[/?#][^\s]*)?$/;

export interface CustomSearchHit { title: string; snippet: string; url: string }
export interface CustomSearchPort {
  apiKey: string; engineId: string;
  get?(url: string, signal: AbortSignal): Promise<{ ok: boolean; text: string }>;
}

function clean(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() && value.trim().length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
    ? value.trim() : undefined;
}

/** Public Custom Search only. No cookies, redirects, or result-as-instruction handling. */
export async function customSearch(port: CustomSearchPort, query: string, limit: number, signal: AbortSignal): Promise<readonly CustomSearchHit[]> {
  if (!clean(query, 120) || /[\r\n]/.test(query) || !Number.isSafeInteger(limit) || limit < 1 || limit > 5)
    throw new Error('SEARCH_INPUT_INVALID');
  if (!/^[A-Za-z0-9_-]{10,128}$/.test(port.apiKey) || !/^[A-Za-z0-9:_-]{8,128}$/.test(port.engineId)) throw new Error('SEARCH_CONFIG_INVALID');
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(port.apiKey)}&cx=${encodeURIComponent(port.engineId)}&q=${encodeURIComponent(query.trim())}&num=${limit}`;
  const get = port.get ?? (async (target, child) => {
    const response = await fetch(target, { method: 'GET', redirect: 'error', signal: AbortSignal.any([child, AbortSignal.timeout(10000)]) });
    const text = await response.text();
    if (Buffer.byteLength(text) > 512 * 1024) throw new Error('SEARCH_RESPONSE_INVALID');
    return { ok: response.ok, text };
  });
  const response = await get(url, signal);
  signal.throwIfAborted();
  let body: { items?: unknown };
  try { body = JSON.parse(response.text); } catch { throw new Error('SEARCH_RESPONSE_INVALID'); }
  if (!response.ok || !body || (body.items !== undefined && !Array.isArray(body.items))) throw new Error('SEARCH_UNAVAILABLE');
  const items = Array.isArray(body.items) ? body.items.slice(0, limit) : [];
  const result: CustomSearchHit[] = [];
  for (const value of items) {
    const item = value as { title?: unknown; snippet?: unknown; link?: unknown };
    const title = clean(item.title, 200), snippet = clean(item.snippet, 400), link = clean(item.link, 500);
    if (!title || !snippet || !link || !HTTPS.test(link)) continue;
    result.push({ title, snippet, url: link });
  }
  return Object.freeze(result);
}
