import { createHash } from 'node:crypto';
import { requireCapability, type RequestContext } from '../../modules/access/index.js';
import { audienceKey, eligibleContent, rankCandidates, timestamp, validId, type RadarAudience } from '../../modules/radar/content.js';
import { createQuietCard } from '../../modules/radar/drafts.js';
import { decideDelivery } from '../../modules/radar/deliveryPolicy.js';
import { MAX_ACTIVE_SOURCES, MAX_AUDIT_EVENTS, MAX_SOURCE_IDS, MAX_CATALOG_RECORDS, mergeCatalog,
  type PersonalCatalog, type PersonalCatalogPort, type CatalogAudit } from '../../modules/radar/catalog.js';
import { snapshotSubscription, validFeedSubscription,
  type FeedRecord, type FeedRegistryPort, type FeedSubscription } from '../../modules/radar/sourceRegistry.js';
import { articleUrl, feedUrl, type FeedConnectorPort } from './feedConnector.js';
import { FeedCollector } from './collectFeed.js';

export class PersonalRadarError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'CONFLICT' | 'NOT_FOUND' | 'LIMIT' | 'UNAVAILABLE' | 'CANCELLED') { super(code); }
}
/** Server-owned callback: renew the same request's identity/authorization, never a body-supplied actor. */
export type ReauthorizeRadar = () => Promise<RequestContext>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Only call with a server-verified AccessService context. Never accepts a browser's subject/audience/admin flag. */
export function personalRadarOwner(context: RequestContext, now = Date.now()): string {
  requireCapability(context, 'profile:read', now);
  if (!context.principal.projectId || !context.principal.uid) throw new PersonalRadarError('INVALID_INPUT');
  return 'firebase:' + hash([context.principal.projectId, context.principal.uid]);
}
const personalAudience = (owner: string): RadarAudience => ({ kind: 'personal', subjectId: owner });
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) < Number.MAX_SAFE_INTEGER;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));

/** Rebuild a metadata-only record and check its content-addressed identity. No arbitrary connector extras survive. */
export function checkedRecord(record: FeedRecord, source: FeedSubscription, now: number): FeedRecord {
  const item = record?.content; const p = record?.provenance;
  let validLocation = false;
  try { validLocation = !!item && !!p && p.fetchedUrl === feedUrl(source) && articleUrl(item.sourceUrl, source) === item.sourceUrl; } catch { /* reject below */ }
  if (!item || !p || !eligibleContent(item, source.audience, now) || item.visibility !== 'public'
    || item.sourceId !== source.id || item.sourceKind !== source.kind || p.sourceRevision !== source.revision
    || !validLocation || p.fetchedAt !== item.fetchedAt || p.publishedAt !== item.publishedAt
    || !timestamp(p.updatedAt) || p.updatedAt < p.publishedAt || p.updatedAt > p.fetchedAt
    || typeof p.externalId !== 'string' || !p.externalId.trim() || p.externalId.length > 512 || /[\x00-\x1f\x7f]/.test(p.externalId)) throw new PersonalRadarError('UNAVAILABLE');
  if (source.kind === 'youtube' && (!/^[A-Za-z0-9_-]{11}$/.test(p.externalId)
    || item.sourceUrl !== `https://www.youtube.com/watch?v=${p.externalId}`)) throw new PersonalRadarError('UNAVAILABLE');
  const entityKey = hash([audienceKey(source.audience), source.id, p.externalId]);
  const versionHash = hash([p.externalId, item.title, item.sourceUrl, p.publishedAt, p.updatedAt]);
  if (p.entityKey !== entityKey || p.versionHash !== versionHash || item.id !== hash([entityKey, versionHash])
    || item.clusterId !== hash(item.sourceUrl) || item.expiresAt !== Math.min(p.updatedAt + source.retentionMs, source.consentExpiresAt))
    throw new PersonalRadarError('UNAVAILABLE');
  return { content: { id: item.id, revision: 1, clusterId: item.clusterId, sourceId: source.id, sourceKind: source.kind,
    sourceUrl: item.sourceUrl, fetchedAt: p.fetchedAt, publishedAt: p.publishedAt, expiresAt: item.expiresAt,
    visibility: 'public', verification: 'source_checked', title: item.title,
    fact: source.kind === 'youtube' ? '登録チャンネルのフィードに掲載された動画です。' : '登録ソースのフィードに掲載された項目です。',
    metadata: [new Date(p.publishedAt).toISOString()], topicIds: [...source.topicIds], novelty: 0, quality: 0.5 },
    provenance: { entityKey, versionHash, externalId: p.externalId, sourceRevision: source.revision,
      fetchedUrl: p.fetchedUrl, fetchedAt: p.fetchedAt, publishedAt: p.publishedAt, updatedAt: p.updatedAt } };
}

/** No default repository/connector, app boot, automatic fetch, timer, publisher or Discord identity linking. */
export class PersonalRadarService {
  constructor(private readonly repository: PersonalCatalogPort, private readonly clock: () => number = Date.now) {}
  private async read(owner: string): Promise<PersonalCatalog> {
    const row = await this.repository.read(owner);
    if (!row) return { owner, revision: 0, sources: [], audit: [] };
    if (row.owner !== owner || !revision(row.revision) || row.revision === 0 || !Array.isArray(row.sources)
      || row.sources.length > MAX_SOURCE_IDS || !Array.isArray(row.audit) || row.audit.length > MAX_AUDIT_EVENTS
      || row.sources.filter(s => s.source !== null).length > MAX_ACTIVE_SOURCES
      || new Set(row.sources.map(s => s.id)).size !== row.sources.length
      || row.sources.some(s => !validId(s.id) || !Array.isArray(s.records) || s.records.length > MAX_CATALOG_RECORDS
        || (s.source === null ? s.records.length !== 0 : s.source.id !== s.id || audienceKey(s.source.audience) !== audienceKey(personalAudience(owner)))))
      throw new PersonalRadarError('UNAVAILABLE');
    return structuredClone(row);
  }
  private async commit(context: RequestContext, current: PersonalCatalog, sources: PersonalCatalog['sources'], event: Omit<CatalogAudit, 'revision' | 'at'>, reauthorize: ReauthorizeRadar, signal?: AbortSignal) {
    if (personalRadarOwner(context, this.clock()) !== current.owner) throw new PersonalRadarError('UNAVAILABLE');
    if (typeof reauthorize !== 'function' || personalRadarOwner(await reauthorize(), this.clock()) !== current.owner)
      throw new PersonalRadarError('CONFLICT');
    personalRadarOwner(context, this.clock());
    if (signal?.aborted) throw new PersonalRadarError('CANCELLED');
    const affected = sources.find(s => s.id === event.sourceId)?.source;
    if (event.action !== 'revoke' && (!affected || !validFeedSubscription({ ...affected, enabled: true }, personalAudience(current.owner), this.clock())))
      throw new PersonalRadarError('CONFLICT');
    const next: PersonalCatalog = { owner: current.owner, revision: current.revision + 1, sources,
      audit: [...current.audit, { ...event, revision: current.revision + 1, at: this.clock() }].slice(-MAX_AUDIT_EVENTS) };
    if (!await this.repository.compareAndSwap(current.owner, current.revision, next)) throw new PersonalRadarError('CONFLICT');
    return { revision: next.revision };
  }
  async assertCurrent(context: RequestContext, expected: number): Promise<void> {
    const row = await this.read(personalRadarOwner(context, this.clock()));
    personalRadarOwner(context, this.clock());
    if (row.revision !== expected) throw new PersonalRadarError('CONFLICT');
  }
  async sources(context: RequestContext) {
    const row = await this.read(personalRadarOwner(context, this.clock()));
    personalRadarOwner(context, this.clock());
    return { revision: row.revision, sources: row.sources.map(s => ({ id: s.id,
      source: s.source ? snapshotSubscription(s.source) : null })), audit: row.audit.map(e => ({
      revision: e.revision, at: e.at, sourceId: e.sourceId, action: e.action, added: e.added, updated: e.updated, unchanged: e.unchanged })) };
  }
  async configure(context: RequestContext, id: string, body: unknown, reauthorize: ReauthorizeRadar) {
    const owner = personalRadarOwner(context, this.clock());
    if (!validId(id) || !object(body) || !exactKeys(body, ['expectedRevision', 'source']) || !revision(body.expectedRevision)
      || !object(body.source) || !exactKeys(body.source, ['enabled', 'consentExpiresAt', 'kind', 'locator', 'articleHosts', 'topicIds', 'maxItems', 'retentionMs']))
      throw new PersonalRadarError('INVALID_INPUT');
    const input = structuredClone(body);
    const row = await this.read(owner);
    if (row.revision !== input.expectedRevision) throw new PersonalRadarError('CONFLICT');
    const previous = row.sources.find(s => s.id === id);
    if (previous && !previous.source) throw new PersonalRadarError('CONFLICT');
    if (!previous && (row.sources.length >= MAX_SOURCE_IDS || row.sources.filter(s => s.source).length >= MAX_ACTIVE_SOURCES))
      throw new PersonalRadarError('LIMIT');
    const source = { ...(input.source as Record<string, unknown>), id, revision: (previous?.source?.revision ?? 0) + 1, audience: personalAudience(owner) } as unknown as FeedSubscription;
    if (typeof source.enabled !== 'boolean' || !validFeedSubscription({ ...source, enabled: true }, source.audience, this.clock())
      || source.consentExpiresAt > this.clock() + 30 * 86400000) throw new PersonalRadarError('INVALID_INPUT');
    try { feedUrl(source); } catch { throw new PersonalRadarError('INVALID_INPUT'); }
    // Any configuration change invalidates all derived metadata, including a disable/re-enable cycle.
    const entry = { id, source: snapshotSubscription(source), records: [] };
    return this.commit(context, row, [...row.sources.filter(s => s.id !== id), entry],
      { sourceId: id, action: 'configure', added: 0, updated: 0, unchanged: 0 }, reauthorize);
  }
  async revoke(context: RequestContext, id: string, expected: unknown, reauthorize: ReauthorizeRadar) {
    const row = await this.read(personalRadarOwner(context, this.clock()));
    if (!validId(id) || !revision(expected)) throw new PersonalRadarError('INVALID_INPUT');
    if (row.revision !== expected) throw new PersonalRadarError('CONFLICT');
    const source = row.sources.find(s => s.id === id);
    if (!source?.source) throw new PersonalRadarError('NOT_FOUND');
    return this.commit(context, row, row.sources.map(s => s.id === id ? { id, source: null, records: [] } : s),
      { sourceId: id, action: 'revoke', added: 0, updated: 0, unchanged: 0 }, reauthorize);
  }
  /** Internal explicit invocation only. HTTP has NO collect/refresh route. Rate reservation/lease is a later prerequisite. */
  async collect(context: RequestContext, id: string, connector: FeedConnectorPort, signal: AbortSignal, reauthorize: ReauthorizeRadar) {
    const owner = personalRadarOwner(context, this.clock());
    if (typeof reauthorize !== 'function' || personalRadarOwner(await reauthorize(), this.clock()) !== owner)
      throw new PersonalRadarError('CONFLICT');
    const row = await this.read(owner); const entry = row.sources.find(s => s.id === id);
    if (!entry?.source || !validFeedSubscription(entry.source, personalAudience(owner), this.clock())) throw new PersonalRadarError('NOT_FOUND');
    const source = snapshotSubscription(entry.source);
    const registry: FeedRegistryPort = { get: async (sourceId, audience) => {
      if (audienceKey(audience) !== audienceKey(personalAudience(owner))) return null;
      const current = await this.read(owner);
      return current.sources.find(s => s.id === sourceId)?.source ?? null;
    } };
    const result = await new FeedCollector(registry, connector, this.clock).collect(id, source.audience, signal);
    if (signal.aborted || result.status === 'cancelled') throw new PersonalRadarError('CANCELLED');
    if (result.status !== 'collected') throw new PersonalRadarError(result.status === 'denied' ? 'CONFLICT' : 'UNAVAILABLE');
    const now = this.clock();
    if (!validFeedSubscription(source, source.audience, now)) throw new PersonalRadarError('CONFLICT');
    const incoming = result.records.map(r => checkedRecord(r, source, now));
    if (new Set(incoming.map(r => r.provenance.entityKey)).size !== incoming.length) throw new PersonalRadarError('UNAVAILABLE');
    const previous = entry.records.filter(r => r.content.expiresAt > now).map(r => checkedRecord(r, source, now));
    const merged = mergeCatalog(previous, incoming, now);
    if (signal.aborted) throw new PersonalRadarError('CANCELLED');
    // The initial aggregate revision fences concurrent collectors/configuration/revocation; no blind retry.
    return this.commit(context, row, row.sources.map(s => s.id === id ? { id, source, records: merged.records } : s),
      { sourceId: id, action: 'collect', added: merged.added, updated: merged.updated, unchanged: merged.unchanged }, reauthorize, signal);
  }
  async preview(context: RequestContext) {
    const owner = personalRadarOwner(context, this.clock()); const row = await this.read(owner);
    const now = this.clock(); const audience = personalAudience(owner);
    const entries = row.sources.filter(s => s.source && validFeedSubscription(s.source, audience, now));
    const records = entries.flatMap(s => s.records.filter(r => r.content.expiresAt > now).map(r => checkedRecord(r, s.source!, now)));
    const preferences = [...new Set(entries.flatMap(s => s.source!.topicIds))].map(topicId => ({ topicId, weight: 1 }));
    const policy = { audience, revision: Math.max(1, row.revision), enabled: true, allowedSourceIds: entries.map(s => s.id),
      minimumScore: 0, maxPerHour: 0, maxPerDay: 0, minimumGapMs: 0, maxDigestItems: 3 };
    const delivery = { now, focusMode: true, quietUntil: now, usedThisHour: 0, usedToday: 0, lastDeliveryAt: null, deliveredOrReservedClusterIds: [] };
    const items = rankCandidates(records.map(r => r.content), { audience, now, preferences }).flatMap(candidate => {
      const card = createQuietCard(candidate, now);
      if (!card || decideDelivery(candidate, policy, delivery).kind !== 'digest') return [];
      return [{ card, contentId: candidate.item.id, sourceId: candidate.item.sourceId,
        sourceRevision: entries.find(s => s.id === candidate.item.sourceId)!.source!.revision,
        score: candidate.score, matchedTopicIds: candidate.matchedTopicIds }];
    }).slice(0, 3);
    await this.assertCurrent(context, row.revision);
    // A later recheck may cross consent/retention expiry even with an unchanged revision.
    if (entries.some(s => !validFeedSubscription(s.source!, audience, this.clock()))
      || records.some(r => r.content.expiresAt <= this.clock())) throw new PersonalRadarError('CONFLICT');
    return { revision: row.revision, items, notify: false as const,
      validUntil: Math.min(context.expiresAtMs, ...entries.map(s => s.source!.consentExpiresAt), ...records.map(r => r.content.expiresAt)) };
  }
}
