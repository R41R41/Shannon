import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../../modules/access/index.js';
import type { PersonalCatalogPort, CatalogAudit } from '../../modules/radar/catalog.js';
import type { VersionedCatalog } from '../../modules/radar/catalogVersion.js';
import { validFeedSubscription } from '../../modules/radar/sourceRegistry.js';
import { AcquisitionError, assertAcquisitionLease, reserveAcquisition, releaseAcquisition, type AcquisitionPolicy } from '../../modules/radar/acquisition.js';
import { appendCatalogAudit } from '../../modules/radar/audit.js';
import { OwnerRadarCatalog } from './ownerRadarCatalog.js';
import { PersonalRadarError, personalRadarOwner, type ReauthorizeRadar } from './radarAccess.js';
import { temporalActive } from './temporalCatalogData.js';
export interface AcquisitionResult {
  readonly sources: VersionedCatalog['sources']; readonly temporalSources: VersionedCatalog['temporalSources'];
  readonly added: number; readonly updated: number; readonly unchanged: number;
}
/** One CAS budget for public feeds AND private temporal sources; never creates a parallel allowance. */
export class ReservedRadarAcquisition {
  private readonly catalog: OwnerRadarCatalog;
  private readonly policy?: AcquisitionPolicy;
  constructor(private readonly repository: PersonalCatalogPort, private readonly clock: () => number, policy?: AcquisitionPolicy) {
    this.catalog = new OwnerRadarCatalog(repository, clock); this.policy = policy && Object.freeze({ ...policy });
  }
  async run(context: RequestContext, id: string, signal: AbortSignal, reauthorize: ReauthorizeRadar, expected: number | undefined, kind: 'feed' | 'temporal',
    work: (reserved: VersionedCatalog, leaseId: string, child: AbortSignal) => Promise<AcquisitionResult>) {
    const owner = personalRadarOwner(context, this.clock());
    if (typeof reauthorize !== 'function' || personalRadarOwner(await reauthorize(), this.clock()) !== owner) throw new PersonalRadarError('CONFLICT');
    if (signal.aborted) throw new PersonalRadarError('CANCELLED');
    if (!this.policy) throw new PersonalRadarError('UNAVAILABLE');
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER)) throw new PersonalRadarError('INVALID_INPUT');
    const before = await this.catalog.read(owner);
    if (expected !== undefined && before.revision !== expected) throw new PersonalRadarError('CONFLICT');
    const feed = before.sources.find(s => s.id === id)?.source;
    const temporal = before.temporalSources.find(s => s.id === id)?.source;
    const source = feed ?? temporal;
    if (!source || (kind === 'feed' ? !feed : !temporal) || !(feed ? validFeedSubscription(feed, { kind: 'personal', subjectId: owner }, this.clock()) : temporalActive(temporal ?? null, owner, this.clock())))
      throw new PersonalRadarError('NOT_FOUND');
    const startedAt = this.clock(); const lease = { id: randomUUID(), sourceId: id, sourceRevision: source.revision, startedAt,
      expiresAt: Math.min(startedAt + this.policy.leaseMs, source.consentExpiresAt, context.expiresAtMs) };
    const acquisition = reserveAcquisition(before.acquisition, this.policy, lease);
    const reservation = await this.catalog.commit(context, before, before.sources,
      { sourceId: id, action: 'reserve', attemptId: lease.id, added: 0, updated: 0, unchanged: 0 }, reauthorize, signal, acquisition);
    try {
      const reserved = await this.catalog.read(owner);
      if (reserved.revision !== reservation.revision) throw new PersonalRadarError('CONFLICT');
      assertAcquisitionLease(reserved.acquisition, lease.id, this.clock());
      const result = await withAcquisitionDeadline(child => work(reserved, lease.id, child), signal, lease.expiresAt - this.clock());
      if (signal.aborted) throw new PersonalRadarError('CANCELLED');
      personalRadarOwner(context, this.clock()); const now = this.clock(); assertAcquisitionLease(reserved.acquisition, lease.id, now);
      return await this.catalog.commit(context, reserved, result.sources,
        { sourceId: id, action: 'collect', attemptId: lease.id, added: result.added, updated: result.updated, unchanged: result.unchanged },
        reauthorize, signal, releaseAcquisition(reserved.acquisition!, now), lease.id, result.temporalSources);
    } catch (error) {
      await this.settleFailed(owner, lease.id, signal.aborted ? 'cancelled' : error instanceof AcquisitionError && error.code === 'LEASE_EXPIRED'
        ? 'expired' : error instanceof PersonalRadarError && error.code === 'CONFLICT' ? 'conflict' : 'failed').catch(() => undefined);
      throw error;
    }
  }
  private async settleFailed(owner: string, attemptId: string, outcome: NonNullable<CatalogAudit['outcome']>) {
    const row = await this.catalog.read(owner); const state = row.acquisition;
    if (!state?.lease || state.lease.id !== attemptId) return;
    const now = this.clock(); const event: CatalogAudit = { sourceId: state.lease.sourceId, revision: row.revision + 1, at: now,
      action: 'collect_failed', attemptId, outcome, added: 0, updated: 0, unchanged: 0 };
    await this.repository.compareAndSwap(owner, row.revision, { ...row, revision: row.revision + 1,
      acquisition: releaseAcquisition(state, now), audit: appendCatalogAudit(row.audit, event) });
  }
}
async function withAcquisitionDeadline<T>(work: (signal: AbortSignal) => Promise<T>, outer: AbortSignal, remaining: number): Promise<T> {
  if (outer.aborted) throw new PersonalRadarError('CANCELLED');
  if (remaining <= 0) throw new AcquisitionError('LEASE_EXPIRED');
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; let cancel = () => {};
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => { controller.abort(); reject(new PersonalRadarError('CANCELLED')); };
    outer.addEventListener('abort', cancel, { once: true }); timer = setTimeout(() => { controller.abort(); reject(new AcquisitionError('LEASE_EXPIRED')); }, remaining);
  });
  try { return await Promise.race([stopped, work(controller.signal)]); }
  finally { clearTimeout(timer); outer.removeEventListener('abort', cancel); controller.abort(); }
}
