export interface ShannonPlaceResult {
  reply: string;
  places: Array<{ name: string; address: string; reason: string; mapUrl: string }>;
  sources: unknown[];
}

/** Public place queries only: no user identity, private history, or owner binding crosses this bridge. */
export async function searchShannonPlaces(
  query: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: typeof fetch = fetch,
): Promise<ShannonPlaceResult | null> {
  const rawUrl = environment.SHANNON_CORE_PLATFORM_URL?.trim();
  const token = environment.SHANNON_CORE_PLATFORM_TOKEN?.trim();
  if (!rawUrl || !token) return null;
  if (token.length < 32 || !query.trim() || query.length > 300) throw new Error('Shannon place bridge configuration or query is invalid');
  const url = new URL(rawUrl);
  if (url.pathname !== '/v1/platform/turns' || url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '::1'].includes(url.hostname)))) {
    throw new Error('Shannon place bridge URL is invalid');
  }
  url.pathname = '/v1/platform/places';
  const response = await fetcher(url.toString(), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: query.trim() }),
    redirect: 'error',
    signal: AbortSignal.timeout(35_000),
  });
  if (!response.ok) throw new Error(`Shannon place search failed (${response.status})`);
  const result: unknown = await response.json();
  if (!isRecord(result) || typeof result.reply !== 'string' || result.reply.length > 12_000
    || !Array.isArray(result.places) || result.places.length > 8 || !Array.isArray(result.sources)) {
    throw new Error('Shannon place search returned an invalid result');
  }
  const places = result.places.map((place) => {
    if (!isRecord(place) || typeof place.name !== 'string' || typeof place.address !== 'string'
      || typeof place.reason !== 'string' || typeof place.mapUrl !== 'string'
      || place.name.length > 160 || place.address.length > 240 || place.reason.length > 500
      || !place.mapUrl.startsWith('https://maps.apple.com/?q=')) {
      throw new Error('Shannon place search returned an invalid place');
    }
    return { name: place.name, address: place.address, reason: place.reason, mapUrl: place.mapUrl };
  });
  return { reply: result.reply, places, sources: result.sources.slice(0, 8) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
