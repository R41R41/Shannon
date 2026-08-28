/** Browser DTOs are explicitly decoded; backend/domain objects are never shared as unchecked casts. */
export interface SourceInput {
  enabled: boolean; consentExpiresAt: number; kind: 'youtube' | 'web'; locator: string;
  articleHosts: string[]; topicIds: string[]; maxItems: number; retentionMs: number;
}
export interface SourceEntry { id: string; source: (SourceInput & { revision: number }) | null }
export interface SourcesSnapshot { revision: number; sources: SourceEntry[] }
export interface PreviewItem {
  contentId: string; sourceId: string; sourceRevision: number; score: number; matchedTopicIds: string[];
  card: { title: string; fact: string; sourceUrl: string; metadata: string[]; tags: string[]; mentions: 'none'; notify: false; thread: 'none' };
}
export interface PreviewSnapshot { revision: number; items: PreviewItem[]; notify: false; validUntil: number; servedAt: number }
export type RadarErrorCode = 'authorization' | 'conflict' | 'invalid' | 'unavailable' | 'network' | 'uncertain';
export class RadarClientError extends Error { constructor(readonly code: RadarErrorCode) { super(code); } }
export interface RadarClient {
  sources(signal: AbortSignal): Promise<SourcesSnapshot>;
  preview(signal: AbortSignal): Promise<PreviewSnapshot>;
  save(id: string, expectedRevision: number, source: SourceInput, signal: AbortSignal): Promise<{ revision: number }>;
  revoke(id: string, expectedRevision: number, signal: AbortSignal): Promise<{ revision: number }>;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
export const sourceIdValid = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(v);
const strings = (v: unknown, count: number, max: number): v is string[] => Array.isArray(v) && v.length <= count && v.every(s => text(s, max));
const invalid = (): never => { throw new RadarClientError('invalid'); };
/** Rendering links never grants permission to fetch. No HTML, credentials, non-HTTPS or private schemes. */
export function safeRadarLink(value: unknown): value is string {
  if (!text(value, 2048) || !/^https:\/\//.test(value) || /[\s\\]/.test(value)) return false;
  try { const u = new URL(value); return !u.username && !u.password && !u.hash && !u.port
    && /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,63}$/.test(u.hostname)
    && !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(u.hostname); } catch { return false; }
}
export function sourceInput(value: unknown): SourceInput {
  if (!record(value) || typeof value.enabled !== 'boolean' || !integer(value.consentExpiresAt)
    || !['youtube', 'web'].includes(String(value.kind)) || !text(value.locator, 2048)
    || !strings(value.articleHosts, 10, 253) || value.articleHosts.length < 1
    || !value.articleHosts.every(h => /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,63}$/.test(h))
    || !strings(value.topicIds, 10, 128) || !value.topicIds.every(sourceIdValid)
    || !integer(value.maxItems) || value.maxItems < 1 || value.maxItems > 20
    || !integer(value.retentionMs) || value.retentionMs < 60000 || value.retentionMs > 7 * 86400000) return invalid();
  if (value.kind === 'youtube' ? !/^UC[A-Za-z0-9_-]{22}$/.test(value.locator)
    || value.articleHosts.length !== 1 || value.articleHosts[0] !== 'www.youtube.com'
    : !safeRadarLink(value.locator) || !!new URL(value.locator).search) return invalid();
  return { enabled: value.enabled, consentExpiresAt: value.consentExpiresAt, kind: value.kind as SourceInput['kind'], locator: value.locator,
    articleHosts: [...value.articleHosts], topicIds: [...value.topicIds], maxItems: value.maxItems, retentionMs: value.retentionMs };
}
export function decodeSources(value: unknown): SourcesSnapshot {
  if (!record(value) || !integer(value.revision) || !Array.isArray(value.sources) || value.sources.length > 32) return invalid();
  const sources = value.sources.map(s => {
    if (!record(s) || !sourceIdValid(s.id)) return invalid();
    if (s.source === null) return { id: s.id, source: null };
    if (!record(s.source) || s.source.id !== s.id || !integer(s.source.revision) || s.source.revision < 1) return invalid();
    return { id: s.id, source: { ...sourceInput(s.source), revision: s.source.revision } };
  });
  if (new Set(sources.map(s => s.id)).size !== sources.length || sources.filter(s => s.source).length > 10) return invalid();
  return { revision: value.revision, sources };
}
export function decodePreview(value: unknown): PreviewSnapshot {
  if (!record(value) || !integer(value.revision) || value.notify !== false || !integer(value.validUntil)
    || !integer(value.servedAt) || value.validUntil <= value.servedAt || !Array.isArray(value.items) || value.items.length > 3) return invalid();
  const items = value.items.map(item => {
    if (!record(item) || !sourceIdValid(item.contentId) || !sourceIdValid(item.sourceId)
      || !integer(item.sourceRevision) || item.sourceRevision < 1 || typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 1
      || !strings(item.matchedTopicIds, 10, 128) || !item.matchedTopicIds.every(sourceIdValid) || !record(item.card)) return invalid();
    const c = item.card;
    if (!text(c.title, 360) || !c.title.trim() || !text(c.fact, 1000) || !c.fact.trim() || !safeRadarLink(c.sourceUrl)
      || !strings(c.metadata, 5, 200) || !strings(c.tags, 10, 256) || c.mentions !== 'none' || c.notify !== false || c.thread !== 'none') return invalid();
    return { contentId: item.contentId, sourceId: item.sourceId, sourceRevision: item.sourceRevision, score: item.score,
      matchedTopicIds: [...item.matchedTopicIds], card: { title: c.title, fact: c.fact, sourceUrl: c.sourceUrl,
        metadata: [...c.metadata], tags: [...c.tags], mentions: 'none' as const, notify: false as const, thread: 'none' as const } };
  });
  if (new Set(items.map(i => i.contentId)).size !== items.length) return invalid();
  return { revision: value.revision, items, notify: false, validUntil: value.validUntil, servedAt: value.servedAt };
}
/** Transport must be bound to the current authenticated session; response bodies never supply an owner. */
export function createRadarClient(fetcher: (path: string, init: RequestInit) => Promise<Response>): RadarClient {
  const request = async (path: string, signal: AbortSignal, method = 'GET', body?: unknown) => {
    try {
      const response = await fetcher(path, { signal, method, headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw { status: response.status };
      if (Number(response.headers.get('content-length')) > 131072) return invalid();
      const raw = await response.text(); if (raw.length > 131072 || signal.aborted) return invalid();
      return JSON.parse(raw) as unknown;
    } catch (error) {
      if (error instanceof RadarClientError) throw error;
      const status = record(error) ? error.status : undefined;
      throw new RadarClientError(status === 401 || status === 403 ? 'authorization' : status === 409 ? 'conflict'
        : status === 400 || status === 413 ? 'invalid' : status === 404 || status === 503 ? 'unavailable' : 'network');
    }
  };
  const mutate = async (id: string, expectedRevision: number, signal: AbortSignal, source?: SourceInput) => {
    if (!sourceIdValid(id) || !integer(expectedRevision)) return invalid();
    const result = await request(`/api/radar/sources/${encodeURIComponent(id)}`, signal, source ? 'PUT' : 'DELETE',
      { expectedRevision, ...(source ? { source: sourceInput(source) } : {}) });
    if (!record(result) || !integer(result.revision) || result.revision !== expectedRevision + 1) return invalid();
    return { revision: result.revision };
  };
  return { sources: async s => decodeSources(await request('/api/radar/sources', s)), preview: async s => decodePreview(await request('/api/radar/preview', s)),
    save: (id, rev, source, s) => mutate(id, rev, s, source), revoke: (id, rev, s) => mutate(id, rev, s) };
}
