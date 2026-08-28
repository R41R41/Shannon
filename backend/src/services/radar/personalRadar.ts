import { ReservedRadarAcquisition } from './reservedAcquisition.js';
import { OwnerRadarCatalog } from './ownerRadarCatalog.js';
import { temporalVisible } from './temporalCatalogData.js';
import { createHash } from 'node:crypto';
import { type RequestContext } from '../../modules/access/index.js';
import { audienceKey, eligibleContent, rankCandidates, timestamp, validId, type RadarAudience } from '../../modules/radar/content.js';
import { createQuietCard } from '../../modules/radar/drafts.js';
import { decideDelivery } from '../../modules/radar/deliveryPolicy.js';
import { MAX_ACTIVE_SOURCES, MAX_SOURCE_IDS, mergeCatalog,
  type PersonalCatalogPort } from '../../modules/radar/catalog.js';
import { snapshotSubscription, validFeedSubscription,
  type FeedRecord, type FeedRegistryPort, type FeedSubscription } from '../../modules/radar/sourceRegistry.js';
import { articleUrl, feedUrl, type FeedConnectorPort } from './feedConnector.js';
import { FeedCollector } from './collectFeed.js';

import { catalogAuditView, retainedAudit } from '../../modules/radar/audit.js';

import { acquisitionTime, assertAcquisitionLease, releaseAcquisition,
  type AcquisitionPolicy } from '../../modules/radar/acquisition.js';

import { PersonalRadarError, personalRadarOwner, type ReauthorizeRadar } from './radarAccess.js';
export { PersonalRadarError, personalRadarOwner, type ReauthorizeRadar } from './radarAccess.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
  private readonly acquisition: ReservedRadarAcquisition;
  private readonly catalog: OwnerRadarCatalog;
  constructor(private readonly repository: PersonalCatalogPort, private readonly clock: () => number = Date.now, policy?: AcquisitionPolicy) {
    this.catalog = new OwnerRadarCatalog(repository, clock);
    this.acquisition = new ReservedRadarAcquisition(repository, clock, policy);
  }
  async assertCurrent(context: RequestContext, expected: number): Promise<void> {
    const row = await this.catalog.read(personalRadarOwner(context, this.clock()));
    personalRadarOwner(context, this.clock());
    if (row.revision !== expected) throw new PersonalRadarError('CONFLICT');
  }
  async sources(context: RequestContext) {
    const row = await this.catalog.read(personalRadarOwner(context, this.clock()));
    personalRadarOwner(context, this.clock());
    return { revision: row.revision, sources: row.sources.map(s => ({ id: s.id,
      source: s.source ? snapshotSubscription(s.source) : null })), audit: retainedAudit(row.audit, this.clock()).map(e => ({
      revision: e.revision, at: e.at, sourceId: e.sourceId, action: e.action, added: e.added, updated: e.updated, unchanged: e.unchanged })) };
  }
  async configure(context: RequestContext, id: string, body: unknown, reauthorize: ReauthorizeRadar) {
    const owner = personalRadarOwner(context, this.clock());
    if (!validId(id) || !object(body) || !exactKeys(body, ['expectedRevision', 'source']) || !revision(body.expectedRevision)
      || !object(body.source) || !exactKeys(body.source, ['enabled', 'consentExpiresAt', 'kind', 'locator', 'articleHosts', 'topicIds', 'maxItems', 'retentionMs']))
      throw new PersonalRadarError('INVALID_INPUT');
    const input = structuredClone(body);
    const row = await this.catalog.read(owner);
    if (row.revision !== input.expectedRevision) throw new PersonalRadarError('CONFLICT');
    if (row.temporalSources.some(s => s.id === id)) throw new PersonalRadarError('CONFLICT');
    const previous = row.sources.find(s => s.id === id);
    if (previous && !previous.source) throw new PersonalRadarError('CONFLICT');
    if (!previous && ([...row.sources, ...row.temporalSources].length >= MAX_SOURCE_IDS || [...row.sources, ...row.temporalSources].filter(s => s.source).length >= MAX_ACTIVE_SOURCES))
      throw new PersonalRadarError('LIMIT');
    const source = { ...(input.source as Record<string, unknown>), id, revision: (previous?.source?.revision ?? 0) + 1, audience: personalAudience(owner) } as unknown as FeedSubscription;
    if (typeof source.enabled !== 'boolean' || !validFeedSubscription({ ...source, enabled: true }, source.audience, this.clock())
      || source.consentExpiresAt > this.clock() + 30 * 86400000) throw new PersonalRadarError('INVALID_INPUT');
    try { feedUrl(source); } catch { throw new PersonalRadarError('INVALID_INPUT'); }
    // Any configuration change invalidates all derived metadata, including a disable/re-enable cycle.
    const entry = { id, source: snapshotSubscription(source), records: [] };
    return this.catalog.commit(context, row, [...row.sources.filter(s => s.id !== id), entry],
      { sourceId: id, action: 'configure', added: 0, updated: 0, unchanged: 0 }, reauthorize);
  }
  async revoke(context: RequestContext, id: string, expected: unknown, reauthorize: ReauthorizeRadar) {
    const row = await this.catalog.read(personalRadarOwner(context, this.clock()));
    if (!validId(id) || !revision(expected)) throw new PersonalRadarError('INVALID_INPUT');
    if (row.revision !== expected) throw new PersonalRadarError('CONFLICT');
    const source = row.sources.find(s => s.id === id);
    if (!source?.source) throw new PersonalRadarError('NOT_FOUND');
    return this.catalog.commit(context, row, row.sources.map(s => s.id === id ? { id, source: null, records: [] } : s),
      { sourceId: id, action: 'revoke', added: 0, updated: 0, unchanged: 0 }, reauthorize);
  }
  /** Internal only. A server-owned policy and a durable reservation are mandatory before connector I/O. */
  async collect(context: RequestContext, id: string, connector: FeedConnectorPort, signal: AbortSignal, reauthorize: ReauthorizeRadar, expectedRevision?: number) {
    return this.acquisition.run(context, id, signal, reauthorize, expectedRevision, 'feed', async (reserved, leaseId, child) => {
      const owner = reserved.owner; const entry = reserved.sources.find(s => s.id === id);
      if (!entry?.source) throw new PersonalRadarError('NOT_FOUND');
      const source = snapshotSubscription(entry.source);
      const registry: FeedRegistryPort = { get: async (sourceId, audience) => {
        if (audienceKey(audience) !== audienceKey(personalAudience(owner))) return null;
        const current = await this.catalog.read(owner); assertAcquisitionLease(current.acquisition, leaseId, this.clock());
        if (current.revision !== reserved.revision) return null;
        return current.sources.find(s => s.id === sourceId)?.source ?? null;
      } };
      const result = await new FeedCollector(registry, connector, this.clock).collect(id, source.audience, child);
      // Preserve authority/lease errors even when the collector returns a generic failure.
      personalRadarOwner(context, this.clock());
      assertAcquisitionLease(reserved.acquisition, leaseId, this.clock());
      if (result.status !== 'collected') throw new PersonalRadarError(result.status === 'denied' ? 'CONFLICT' : 'UNAVAILABLE');
      const now = this.clock(); if (!validFeedSubscription(source, source.audience, now)) throw new PersonalRadarError('CONFLICT');
      const incoming = result.records.map(r => checkedRecord(r, source, now));
      if (new Set(incoming.map(r => r.provenance.entityKey)).size !== incoming.length) throw new PersonalRadarError('UNAVAILABLE');
      const merged = mergeCatalog(entry.records.filter(r => r.content.expiresAt > now).map(r => checkedRecord(r, source, now)), incoming, now);
      return { sources: reserved.sources.map(s => s.id === id ? { id, source, records: merged.records } : s), temporalSources: reserved.temporalSources,
        added: merged.added, updated: merged.updated, unchanged: merged.unchanged };
    });
  }
  /** Explicit owner-scoped maintenance; no scan, timer, network, account enumeration or automatic retry.
   * Keeps configuration/ID tombstones and budget history; never TTL-deletes the owner document.
   */
  async maintain(context: RequestContext, expected: number, reauthorize: ReauthorizeRadar) {
    const owner = personalRadarOwner(context, this.clock());
    if (!revision(expected)) throw new PersonalRadarError('INVALID_INPUT');
    const row = await this.catalog.read(owner); const now = this.clock();
    if (row.revision !== expected) throw new PersonalRadarError('CONFLICT');
    if (row.acquisition) acquisitionTime(row.acquisition, now);
    let removed = 0;
    const sources = row.sources.map(entry => {
      const records = entry.records.filter(r => entry.source && validFeedSubscription(entry.source, personalAudience(owner), now) && r.content.expiresAt > now);
      removed += entry.records.length - records.length;
      return { ...entry, records };
    });
    const temporalSources = row.temporalSources.map(e => {
      if (e.snapshot && !temporalVisible(e, owner, now)) { removed += e.snapshot.content.items.length || 1; return { ...e, snapshot: null }; } return e;
    });
    const recovered = !!row.acquisition?.lease && row.acquisition.lease.expiresAt <= now;
    const acquisition = recovered ? releaseAcquisition(row.acquisition!, now) : row.acquisition;
    const expiredAudit = retainedAudit(row.audit, now).length !== row.audit.length;
    if (!removed && !recovered && !expiredAudit) {
      if (typeof reauthorize !== 'function' || personalRadarOwner(await reauthorize(), this.clock()) !== owner) throw new PersonalRadarError('CONFLICT');
      await this.assertCurrent(context, expected);
      return { revision: expected, removed: 0, recovered: false };
    }
    const result = await this.catalog.commit(context, row, sources, { sourceId: row.acquisition?.lease?.sourceId ?? 'catalog', action: 'maintain',
      ...(recovered ? { attemptId: row.acquisition!.lease!.id, outcome: 'recovered' as const } : {}), removed, added: 0, updated: 0, unchanged: 0 },
      reauthorize, undefined, acquisition, undefined, temporalSources);
    return { ...result, removed, recovered };
  }
  /** Owner-only recent history with explicit coverage gaps; no durable/global audit claim. */
  async audit(context: RequestContext, reauthorize: ReauthorizeRadar) {
    const owner = personalRadarOwner(context, this.clock());
    const row = await this.catalog.read(owner);
    if (typeof reauthorize !== 'function') throw new PersonalRadarError('CONFLICT');
    const latest = await reauthorize();
    if (personalRadarOwner(latest, this.clock()) !== owner) throw new PersonalRadarError('CONFLICT');
    await this.assertCurrent(latest, row.revision);
    personalRadarOwner(context, this.clock());
    const now = this.clock(); const view = catalogAuditView(row.audit, row.revision, now);
    return { ...view, validUntil: Math.min(context.expiresAtMs, latest.expiresAtMs, now + 60000,
      ...view.events.map(e => e.at + view.retentionMs)) };
  }
  async preview(context: RequestContext) {
    const owner = personalRadarOwner(context, this.clock()); const row = await this.catalog.read(owner);
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
