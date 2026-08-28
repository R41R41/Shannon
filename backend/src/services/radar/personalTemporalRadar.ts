import type { RequestContext } from '../../modules/access/index.js';
import { MAX_ACTIVE_SOURCES, MAX_SOURCE_IDS, type PersonalCatalogPort } from '../../modules/radar/catalog.js';
import type { TemporalSource } from '../../modules/radar/temporalSources.js';
import type { TemporalCatalogEntry, TemporalGrant, TemporalSnapshot } from '../../modules/radar/catalogVersion.js';
import { validId } from '../../modules/radar/content.js';
import type { AcquisitionPolicy } from '../../modules/radar/acquisition.js';
import { assertAcquisitionLease } from '../../modules/radar/acquisition.js';
import { OwnerRadarCatalog } from './ownerRadarCatalog.js';
import { ReservedRadarAcquisition } from './reservedAcquisition.js';
import { PersonalRadarError, personalRadarOwner, type ReauthorizeRadar } from './radarAccess.js';
import { checkedGrant, checkedTemporalSnapshot, temporalActive, temporalVisible } from './temporalCatalogData.js';
import { temporalRead } from './temporalParsing.js';
export interface TemporalCatalogReader {
  /** Server-owned, current source/owner/binding authority. No token, raw account ID or ambient ADC. */
  authorize(source: TemporalSource, signal: AbortSignal): Promise<TemporalGrant>;
  read(source: TemporalSource, signal: AbortSignal): Promise<TemporalSnapshot>;
}
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) < Number.MAX_SAFE_INTEGER;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Private temporal context stays outside feed ranking, conversation memory and Discord cards.
 * Internal API only until owner UI, broker and HTTP wiring have been reviewed. */
export class PersonalTemporalRadar {
  private readonly catalog: OwnerRadarCatalog;
  private readonly acquisition: ReservedRadarAcquisition;
  constructor(repository: PersonalCatalogPort, private readonly reader: TemporalCatalogReader, private readonly clock: () => number = Date.now, policy?: AcquisitionPolicy) {
    this.catalog = new OwnerRadarCatalog(repository, clock); this.acquisition = new ReservedRadarAcquisition(repository, clock, policy);
  }
  private async grant(source: TemporalSource, signal: AbortSignal) {
    if (!temporalActive(source, source.owner, this.clock())) throw new PersonalRadarError('CONFLICT');
    return checkedGrant(await temporalRead(signal, child => this.reader.authorize(structuredClone(source), child)), this.clock());
  }
  private async renew(context: RequestContext, owner: string, reauthorize: ReauthorizeRadar) {
    personalRadarOwner(context, this.clock());
    if (typeof reauthorize !== 'function') throw new PersonalRadarError('CONFLICT');
    const current = await reauthorize();
    if (personalRadarOwner(current, this.clock()) !== owner) throw new PersonalRadarError('CONFLICT');
    personalRadarOwner(context, this.clock()); return current;
  }
  async configure(context: RequestContext, id: string, body: unknown, reauthorize: ReauthorizeRadar, signal: AbortSignal) {
    const owner = personalRadarOwner(context, this.clock());
    if (!validId(id) || !object(body) || Object.keys(body).length !== 2 || !revision(body.expectedRevision) || !object(body.source)) throw new PersonalRadarError('INVALID_INPUT');
    const input = structuredClone(body.source); const expected = body.expectedRevision;
    const keys = ['kind','enabled','consentExpiresAt','timeZone', ...(input.kind === 'weather' ? ['latitudeTenth','longitudeTenth'] : ['bindingId','days'])];
    if (Object.keys(input).length !== keys.length || Object.keys(input).some(k => !keys.includes(k)) || typeof input.enabled !== 'boolean') throw new PersonalRadarError('INVALID_INPUT');
    const row = await this.catalog.read(owner);
    if (row.revision !== expected || row.sources.some(s => s.id === id)) throw new PersonalRadarError('CONFLICT');
    const previous = row.temporalSources.find(s => s.id === id);
    if (previous && (!previous.source || previous.source.kind !== input.kind)) throw new PersonalRadarError('CONFLICT');
    const all = [...row.sources,...row.temporalSources];
    if (!previous && (all.length >= MAX_SOURCE_IDS || all.filter(s => s.source).length >= MAX_ACTIVE_SOURCES)) throw new PersonalRadarError('LIMIT');
    const source = { ...input, id, owner, revision: (previous?.source?.revision ?? 0) + 1 } as TemporalSource;
    if (!temporalActive({ ...source, enabled: true }, owner, this.clock()) || source.consentExpiresAt > this.clock() + 30 * 86400000) throw new PersonalRadarError('INVALID_INPUT');
    await this.renew(context, owner, reauthorize);
    const grant = source.enabled ? await this.grant(source, signal) : undefined;
    const refresh = async () => {
      const current = await this.renew(context, owner, reauthorize);
      if (grant && (await this.grant(source, signal)).stamp !== grant.stamp) throw new PersonalRadarError('CONFLICT');
      return current;
    };
    const entry: TemporalCatalogEntry = { id, source, snapshot: null };
    return this.catalog.commit(context, row, row.sources, { sourceId: id, action: 'configure', added: 0, updated: 0, unchanged: 0 },
      refresh, signal, row.acquisition, undefined, [...row.temporalSources.filter(s => s.id !== id),entry]);
  }
  async revoke(context: RequestContext, id: string, expected: number, reauthorize: ReauthorizeRadar, signal: AbortSignal) {
    const owner = personalRadarOwner(context, this.clock());
    if (!validId(id) || !revision(expected)) throw new PersonalRadarError('INVALID_INPUT');
    const row = await this.catalog.read(owner);
    if (row.revision !== expected) throw new PersonalRadarError('CONFLICT');
    if (!row.temporalSources.find(s => s.id === id)?.source) throw new PersonalRadarError('NOT_FOUND');
    return this.catalog.commit(context, row, row.sources, { sourceId: id, action: 'revoke', added: 0, updated: 0, unchanged: 0 },
      reauthorize, signal, row.acquisition, undefined, row.temporalSources.map(e => e.id === id ? { id, source: null, snapshot: null } : e));
  }
  async sources(context: RequestContext, reauthorize: ReauthorizeRadar) {
    const owner = personalRadarOwner(context, this.clock()); const row = await this.catalog.read(owner);
    await this.renew(context, owner, reauthorize); const current = await this.catalog.read(owner);
    if (current.revision !== row.revision) throw new PersonalRadarError('CONFLICT');
    personalRadarOwner(context, this.clock());
    return { revision: row.revision, sources: row.temporalSources.map(e => ({ id: e.id, source: e.source ? (({ owner: ignored, ...s }) => s)(e.source) : null })) };
  }
  async collect(context: RequestContext, id: string, expected: number, reauthorize: ReauthorizeRadar, signal: AbortSignal) {
    if (!revision(expected) || !validId(id)) throw new PersonalRadarError('INVALID_INPUT');
    let source: TemporalSource | undefined; let grant: TemporalGrant | undefined;
    const refresh = async () => {
      const current = await this.renew(context, personalRadarOwner(context, this.clock()), reauthorize);
      if (source && grant) {
        const latest = await this.grant(source, signal);
        if (latest.stamp !== grant.stamp || latest.expiresAt < grant.expiresAt) throw new PersonalRadarError('CONFLICT');
      }
      return current;
    };
    return this.acquisition.run(context, id, signal, refresh, expected, 'temporal', async (reserved, leaseId, child) => {
      const entry = reserved.temporalSources.find(s => s.id === id);
      if (!temporalActive(entry?.source ?? null, reserved.owner, this.clock())) throw new PersonalRadarError('NOT_FOUND');
      source = structuredClone(entry!.source!); const startedAt = this.clock(); grant = await this.grant(source, child);
      const beforeRead = await this.catalog.read(reserved.owner); assertAcquisitionLease(beforeRead.acquisition, leaseId, this.clock());
      if (child.aborted || beforeRead.revision !== reserved.revision) throw new PersonalRadarError('CONFLICT');
      const content = checkedTemporalSnapshot(await temporalRead(child, s => this.reader.read(structuredClone(source!), s)), source, this.clock());
      if (content.fetchedAt < startedAt || content.validUntil > grant.expiresAt) throw new PersonalRadarError('CONFLICT');
      await refresh();
      const current = await this.catalog.read(reserved.owner); assertAcquisitionLease(current.acquisition, leaseId, this.clock());
      if (current.revision !== reserved.revision || child.aborted) throw new PersonalRadarError('CONFLICT');
      return { sources: reserved.sources, temporalSources: reserved.temporalSources.map(e => e.id === id ? { id, source: source!, snapshot: { content, grant: grant! } } : e),
        added: entry!.snapshot ? 0 : content.items.length, updated: entry!.snapshot ? content.items.length : 0, unchanged: 0 };
    });
  }
  async preview(context: RequestContext, reauthorize: ReauthorizeRadar, signal: AbortSignal) {
    const owner = personalRadarOwner(context, this.clock()); const row = await this.catalog.read(owner);
    await this.renew(context, owner, reauthorize);
    const entries = row.temporalSources.filter(e => temporalVisible(e, owner, this.clock())).slice(0,3);
    for (const e of entries) {
      const grant = await this.grant(e.source!, signal);
      if (grant.stamp !== e.snapshot!.grant.stamp || grant.expiresAt < e.snapshot!.content.validUntil) throw new PersonalRadarError('CONFLICT');
    }
    const latest = await this.renew(context, owner, reauthorize);
    for (const e of entries) {
      const grant = await this.grant(e.source!, signal);
      if (grant.stamp !== e.snapshot!.grant.stamp || grant.expiresAt < e.snapshot!.content.validUntil) throw new PersonalRadarError('CONFLICT');
    }
    const current = await this.catalog.read(owner);
    if (signal.aborted || current.revision !== row.revision || entries.some(e => !temporalVisible(e, owner, this.clock()))) throw new PersonalRadarError('CONFLICT');
    personalRadarOwner(context, this.clock()); personalRadarOwner(latest, this.clock());
    return { revision: row.revision, notify: false as const,
      validUntil: Math.min(context.expiresAtMs, latest.expiresAtMs, this.clock()+60000, ...entries.map(e => e.snapshot!.content.validUntil)),
      entries: entries.map(e => ({ sourceId: e.id, sourceRevision: e.source!.revision, timeZone: e.source!.timeZone,
        content: (({ owner: ignored, ...content }) => content)(e.snapshot!.content) })) };
  }
}
