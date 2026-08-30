import type { RadarContext } from './radarAccess.js';
import { audienceKey, validId } from '../../modules/radar/content.js';
import { MAX_SOURCE_IDS, MAX_ACTIVE_SOURCES, MAX_CATALOG_RECORDS, type PersonalCatalog, type PersonalCatalogPort, type CatalogAudit } from '../../modules/radar/catalog.js';
import { catalogShape, type VersionedCatalog } from '../../modules/radar/catalogVersion.js';
import { validFeedSubscription } from '../../modules/radar/sourceRegistry.js';
import { validCatalogAudit, appendCatalogAudit } from '../../modules/radar/audit.js';
import { acquisitionTime, assertAcquisitionLease, validAcquisitionState } from '../../modules/radar/acquisition.js';
import { temporalEntryShape, temporalActive, temporalVisible } from './temporalCatalogData.js';
import { PersonalRadarError, personalRadarOwner, type ReauthorizeRadar } from './radarAccess.js';
const personalAudience = (owner: string) => ({ kind: 'personal' as const, subjectId: owner });
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) < Number.MAX_SAFE_INTEGER;
/** Shared CAS boundary for feed and private temporal state. No owner scan, I/O defaults or jobs. */
export class OwnerRadarCatalog {
  constructor(private readonly repository: PersonalCatalogPort, private readonly clock: () => number = Date.now) {}
  async read(owner: string): Promise<VersionedCatalog> {
    const stored = await this.repository.read(owner);
    let row: VersionedCatalog;
    try { row = catalogShape(stored ?? { owner, revision: 0, sources: [], audit: [] }); } catch { throw new PersonalRadarError('UNAVAILABLE'); }
    if (!stored) return row;
    if (row.owner !== owner || !revision(row.revision) || row.revision === 0 || !Array.isArray(row.sources)
      || row.sources.length > MAX_SOURCE_IDS || !Array.isArray(row.audit) || !validCatalogAudit(row.audit, row.revision)
      || row.sources.filter(s => s.source !== null).length > MAX_ACTIVE_SOURCES
      || new Set(row.sources.map(s => s.id)).size !== row.sources.length
      || row.sources.some(s => !validId(s.id) || !Array.isArray(s.records) || s.records.length > MAX_CATALOG_RECORDS
        || (s.source === null ? s.records.length !== 0 : s.source.id !== s.id || audienceKey(s.source.audience) !== audienceKey(personalAudience(owner)))))
      throw new PersonalRadarError('UNAVAILABLE');
    const ids = [...row.sources, ...row.temporalSources];
    if (ids.length > MAX_SOURCE_IDS || ids.filter(s => s.source).length > MAX_ACTIVE_SOURCES
      || new Set(ids.map(s => s.id)).size !== ids.length || row.temporalSources.some(e => !temporalEntryShape(e, owner))) throw new PersonalRadarError('UNAVAILABLE');
    if (row.acquisition !== undefined && !validAcquisitionState(row.acquisition)) throw new PersonalRadarError('UNAVAILABLE');
    return structuredClone(row);
  }
  async commit(context: RadarContext, current: VersionedCatalog, sources: PersonalCatalog['sources'], event: Omit<CatalogAudit, 'revision' | 'at'>, reauthorize: ReauthorizeRadar, signal?: AbortSignal, acquisition = current.acquisition, leaseId?: string, temporalSources = current.temporalSources) {
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
    const temporal = temporalSources.find(s => s.id === event.sourceId)?.source;
    if (!['revoke', 'maintain'].includes(event.action) && !(affected ? validFeedSubscription({ ...affected, enabled: true }, personalAudience(current.owner), now) : temporal && temporalActive({ ...temporal, enabled: true }, current.owner, now)))
      throw new PersonalRadarError('CONFLICT');
    if (event.action === 'collect' && temporal && !temporalVisible(temporalSources.find(s => s.id === event.sourceId)!, current.owner, now)) throw new PersonalRadarError('CONFLICT');
    const next: VersionedCatalog = { schemaVersion: 2, temporalSources, owner: current.owner, revision: current.revision + 1, sources,
      ...(acquisition ? { acquisition: { ...acquisition, observedAt: now } } : {}),
      audit: appendCatalogAudit(current.audit, { ...event, revision: current.revision + 1, at: now }) };
    const ids = [...sources, ...temporalSources];
    if (ids.length > MAX_SOURCE_IDS || ids.filter(s => s.source).length > MAX_ACTIVE_SOURCES || new Set(ids.map(s => s.id)).size !== ids.length
      || temporalSources.some(e => !temporalEntryShape(e, current.owner))) throw new PersonalRadarError('UNAVAILABLE');
    if (!await this.repository.compareAndSwap(current.owner, current.revision, next)) throw new PersonalRadarError('CONFLICT');
    return { revision: next.revision };
  }
}
