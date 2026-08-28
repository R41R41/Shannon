import { createHash, randomUUID } from 'node:crypto';
import { requireCapability, type RequestContext } from '../../modules/access/index.js';
import { audienceKey, eligibleContent, rankCandidates, timestamp, validId, type RadarAudience } from '../../modules/radar/content.js';
import { createQuietCard } from '../../modules/radar/drafts.js';
import { decideDelivery } from '../../modules/radar/deliveryPolicy.js';
import { MAX_ACTIVE_SOURCES, MAX_SOURCE_IDS, MAX_CATALOG_RECORDS, mergeCatalog,
  type PersonalCatalog, type PersonalCatalogPort, type CatalogAudit } from '../../modules/radar/catalog.js';
import { snapshotSubscription, validFeedSubscription,
  type FeedRecord, type FeedRegistryPort, type FeedSubscription } from '../../modules/radar/sourceRegistry.js';
import { articleUrl, feedUrl, type FeedConnectorPort } from './feedConnector.js';
import { FeedCollector } from './collectFeed.js';

import { appendCatalogAudit, catalogAuditView, retainedAudit, validCatalogAudit } from '../../modules/radar/audit.js';

import { AcquisitionError, acquisitionTime, assertAcquisitionLease, reserveAcquisition, releaseAcquisition, validAcquisitionState,
  type AcquisitionPolicy, type AcquisitionState } from '../../modules/radar/acquisition.js';

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
  private readonly collectionPolicy?: AcquisitionPolicy;
  constructor(private readonly repository: PersonalCatalogPort, private readonly clock: () => number = Date.now, policy?: AcquisitionPolicy) {
    this.collectionPolicy = policy ? Object.freeze({ ...policy }) : undefined;
  }
  private async read(owner: string): Promise<PersonalCatalog> {
    const row = await this.repository.read(owner);
    if (!row) return { owner, revision: 0, sources: [], audit: [] };
    if (row.owner !== owner || !revision(row.revision) || row.revision === 0 || !Array.isArray(row.sources)
      || row.sources.length > MAX_SOURCE_IDS || !Array.isArray(row.audit) || !validCatalogAudit(row.audit, row.revision)
      || row.sources.filter(s => s.source !== null).length > MAX_ACTIVE_SOURCES
      || new Set(row.sources.map(s => s.id)).size !== row.sources.length
      || row.sources.some(s => !validId(s.id) || !Array.isArray(s.records) || s.records.length > MAX_CATALOG_RECORDS
        || (s.source === null ? s.records.length !== 0 : s.source.id !== s.id || audienceKey(s.source.audience) !== audienceKey(personalAudience(owner)))))
      throw new PersonalRadarError('UNAVAILABLE');
    if (row.acquisition !== undefined && !validAcquisitionState(row.acquisition)) throw new PersonalRadarError('UNAVAILABLE');
    return structuredClone(row);
  }
  private async commit(context: RequestContext, current: PersonalCatalog, sources: PersonalCatalog['sources'], event: Omit<CatalogAudit, 'revision' | 'at'>, reauthorize: ReauthorizeRadar, signal?: AbortSignal, acquisition = current.acquisition, leaseId?: string) {
    if (personalRadarOwner(context, this.clock()) !== current.owner) throw new PersonalRadarError('UNAVAILABLE');
    if (typeof reauthorize !== 'function' || personalRadarOwner(await reauthorize(), this.clock()) !== current.owner)
      throw new PersonalRadarError('CONFLICT');
    personalRadarOwner(context, this.clock());
    if (signal?.aborted) throw new PersonalRadarError('CANCELLED');
    const now = this.clock();
    if (current.acquisition) acquisitionTime(current.acquisition, now);
    if (leaseId) assertAcquisitionLease(current.acquisition, leaseId, now);
    if (event.action === 'reserve') assertAcquisitionLease(acquisition, event.attemptId!, now);
    const affected = sources.find(s => s.id === event.sourceId)?.source;
    if (!['revoke', 'maintain'].includes(event.action) && (!affected || !validFeedSubscription({ ...affected, enabled: true }, personalAudience(current.owner), this.clock())))
      throw new PersonalRadarError('CONFLICT');
    const next: PersonalCatalog = { owner: current.owner, revision: current.revision + 1, sources,
      ...(acquisition ? { acquisition: { ...acquisition, observedAt: now } } : {}),
      audit: appendCatalogAudit(current.audit, { ...event, revision: current.revision + 1, at: now }) };
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
      source: s.source ? snapshotSubscription(s.source) : null })), audit: retainedAudit(row.audit, this.clock()).map(e => ({
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
  /** Internal only. A server-owned policy and a durable reservation are mandatory before connector I/O. */
  async collect(context: RequestContext, id: string, connector: FeedConnectorPort, signal: AbortSignal, reauthorize: ReauthorizeRadar, expectedRevision?: number) {
    const owner = personalRadarOwner(context, this.clock());
    if (typeof reauthorize !== 'function' || personalRadarOwner(await reauthorize(), this.clock()) !== owner)
      throw new PersonalRadarError('CONFLICT');
    if (signal.aborted) throw new PersonalRadarError('CANCELLED');
    if (!this.collectionPolicy) throw new PersonalRadarError('UNAVAILABLE');
    if (expectedRevision !== undefined && !revision(expectedRevision)) throw new PersonalRadarError('INVALID_INPUT');
    const before = await this.read(owner);
    if (expectedRevision !== undefined && before.revision !== expectedRevision) throw new PersonalRadarError('CONFLICT');
    const entry = before.sources.find(s => s.id === id);
    if (!entry?.source || !validFeedSubscription(entry.source, personalAudience(owner), this.clock())) throw new PersonalRadarError('NOT_FOUND');
    const source = snapshotSubscription(entry.source); const startedAt = this.clock();
    const lease = { id: randomUUID(), sourceId: id, sourceRevision: source.revision, startedAt,
      expiresAt: Math.min(startedAt + this.collectionPolicy.leaseMs, source.consentExpiresAt, context.expiresAtMs) };
    const acquisition = reserveAcquisition(before.acquisition, this.collectionPolicy, lease);
    // An uncertain reservation write must never be followed by HTTP; leave it for explicit recovery.
    const reservation = await this.commit(context, before, before.sources,
      { sourceId: id, action: 'reserve', attemptId: lease.id, added: 0, updated: 0, unchanged: 0 }, reauthorize, signal, acquisition);
    // Read the committed audit as well: completion cannot overwrite the reservation evidence.
    let reserved: PersonalCatalog;
    try {
      reserved = await this.read(owner);
      if (reserved.revision !== reservation.revision) throw new PersonalRadarError('CONFLICT');
      assertAcquisitionLease(reserved.acquisition, lease.id, this.clock());
      if (signal.aborted) throw new PersonalRadarError('CANCELLED');
      const registry: FeedRegistryPort = { get: async (sourceId, audience) => {
        if (audienceKey(audience) !== audienceKey(personalAudience(owner))) return null;
        const current = await this.read(owner);
        assertAcquisitionLease(current.acquisition, lease.id, this.clock());
        if (current.revision !== reserved.revision) return null;
        return current.sources.find(s => s.id === sourceId)?.source ?? null;
      } };
      const result = await withAcquisitionDeadline(
        child => new FeedCollector(registry, connector, this.clock).collect(id, source.audience, child),
        signal, lease.expiresAt - this.clock());
      if (signal.aborted) throw new PersonalRadarError('CANCELLED');
      personalRadarOwner(context, this.clock());
      assertAcquisitionLease(reserved.acquisition, lease.id, this.clock());
      if (result.status !== 'collected') throw new PersonalRadarError(result.status === 'denied' ? 'CONFLICT' : 'UNAVAILABLE');
      const now = this.clock();
      if (!validFeedSubscription(source, source.audience, now)) throw new PersonalRadarError('CONFLICT');
      const incoming = result.records.map(r => checkedRecord(r, source, now));
      if (new Set(incoming.map(r => r.provenance.entityKey)).size !== incoming.length) throw new PersonalRadarError('UNAVAILABLE');
      const previous = entry.records.filter(r => r.content.expiresAt > now).map(r => checkedRecord(r, source, now));
      const merged = mergeCatalog(previous, incoming, now);
      return await this.commit(context, reserved, reserved.sources.map(s => s.id === id ? { id, source, records: merged.records } : s),
        { sourceId: id, action: 'collect', attemptId: lease.id, added: merged.added, updated: merged.updated, unchanged: merged.unchanged },
        reauthorize, signal, releaseAcquisition(reserved.acquisition!, now), lease.id);
    } catch (error) {
      // Best effort metadata-only settlement. No new authority, source content, refund, or automatic fetch retry.
      // If settlement is unavailable/conflicted, the durable lease remains recoverable after expiry.
      await this.settleFailed(owner, lease.id, signal.aborted ? 'cancelled' : error instanceof AcquisitionError && error.code === 'LEASE_EXPIRED'
        ? 'expired' : error instanceof PersonalRadarError && error.code === 'CONFLICT' ? 'conflict' : 'failed').catch(() => undefined);
      throw error;
    }
  }
  private async settleFailed(owner: string, attemptId: string, outcome: NonNullable<CatalogAudit['outcome']>) {
    const row = await this.read(owner); const state = row.acquisition;
    if (!state?.lease || state.lease.id !== attemptId) return;
    const now = this.clock(); const acquisition = releaseAcquisition(state, now);
    const event: CatalogAudit = { sourceId: state.lease.sourceId, revision: row.revision + 1, at: now,
      action: 'collect_failed', attemptId, outcome, added: 0, updated: 0, unchanged: 0 };
    await this.repository.compareAndSwap(owner, row.revision, { ...row, revision: row.revision + 1,
      acquisition, audit: appendCatalogAudit(row.audit, event) });
  }
  /** Explicit owner-scoped maintenance; no scan, timer, network, account enumeration or automatic retry.
   * Keeps configuration/ID tombstones and budget history; never TTL-deletes the owner document.
   */
  async maintain(context: RequestContext, expected: number, reauthorize: ReauthorizeRadar) {
    const owner = personalRadarOwner(context, this.clock());
    if (!revision(expected)) throw new PersonalRadarError('INVALID_INPUT');
    const row = await this.read(owner); const now = this.clock();
    if (row.revision !== expected) throw new PersonalRadarError('CONFLICT');
    if (row.acquisition) acquisitionTime(row.acquisition, now);
    let removed = 0;
    const sources = row.sources.map(entry => {
      const records = entry.records.filter(r => entry.source && validFeedSubscription(entry.source, personalAudience(owner), now) && r.content.expiresAt > now);
      removed += entry.records.length - records.length;
      return { ...entry, records };
    });
    const recovered = !!row.acquisition?.lease && row.acquisition.lease.expiresAt <= now;
    const acquisition = recovered ? releaseAcquisition(row.acquisition!, now) : row.acquisition;
    const expiredAudit = retainedAudit(row.audit, now).length !== row.audit.length;
    if (!removed && !recovered && !expiredAudit) {
      if (typeof reauthorize !== 'function' || personalRadarOwner(await reauthorize(), this.clock()) !== owner) throw new PersonalRadarError('CONFLICT');
      await this.assertCurrent(context, expected);
      return { revision: expected, removed: 0, recovered: false };
    }
    const result = await this.commit(context, row, sources, { sourceId: row.acquisition?.lease?.sourceId ?? 'catalog', action: 'maintain',
      ...(recovered ? { attemptId: row.acquisition!.lease!.id, outcome: 'recovered' as const } : {}), removed, added: 0, updated: 0, unchanged: 0 },
      reauthorize, undefined, acquisition);
    return { ...result, removed, recovered };
  }
  /** Owner-only recent history with explicit coverage gaps; no durable/global audit claim. */
  async audit(context: RequestContext, reauthorize: ReauthorizeRadar) {
    const owner = personalRadarOwner(context, this.clock());
    const row = await this.read(owner);
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

/** Bound even a connector that ignores cancellation. Late values have no persistence continuation. */
async function withAcquisitionDeadline<T>(work: (signal: AbortSignal) => Promise<T>, outer: AbortSignal, remaining: number): Promise<T> {
  if (outer.aborted) throw new PersonalRadarError('CANCELLED');
  if (remaining <= 0) throw new AcquisitionError('LEASE_EXPIRED');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => { controller.abort(); reject(new PersonalRadarError('CANCELLED')); };
    outer.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new AcquisitionError('LEASE_EXPIRED')); }, remaining);
  });
  try { return await Promise.race([stopped, work(controller.signal)]); }
  finally { clearTimeout(timer); outer.removeEventListener('abort', cancel); controller.abort(); }
}
