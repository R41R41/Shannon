import type { FeedRecord, FeedSubscription } from './sourceRegistry.js';
import type { TemporalCatalogEntry } from './catalogVersion.js';
import type { AcquisitionState } from './acquisition.js';

/** One bounded owner aggregate: configuration, latest metadata and audit commit together. */
export interface CatalogSource {
  readonly id: string;
  readonly source: FeedSubscription | null;
  /** A null source is a permanent tombstone for this owner's ID, not a reusable empty slot. */
  readonly records: readonly FeedRecord[];
}
export interface CatalogAudit {
  readonly revision: number;
  readonly at: number;
  readonly sourceId: string;
  readonly action: 'configure' | 'revoke' | 'collect' | 'reserve' | 'collect_failed' | 'maintain';
  readonly attemptId?: string;
  readonly outcome?: 'failed' | 'cancelled' | 'expired' | 'conflict' | 'recovered';
  readonly removed?: number;
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
}
export interface PersonalCatalog {
  readonly schemaVersion?: 2;
  readonly temporalSources?: readonly TemporalCatalogEntry[];
  readonly owner: string;
  readonly revision: number;
  readonly sources: readonly CatalogSource[];
  /** Bounded recent history, not a complete/immutable compliance log. No titles, URLs or raw payload. */
  readonly audit: readonly CatalogAudit[];
  /** Absent only for legacy, never-reserved owners. Not part of browser DTOs. */
  readonly acquisition?: AcquisitionState;
}
export interface PersonalCatalogPort {
  read(owner: string): Promise<PersonalCatalog | null>;
  /** expected=0 inserts only. Never retries or upserts over a tombstone. */
  compareAndSwap(owner: string, expected: number, next: PersonalCatalog): Promise<boolean>;
}
export const MAX_ACTIVE_SOURCES = 10;
export const MAX_SOURCE_IDS = 32;
export const MAX_CATALOG_RECORDS = 20;
export const MAX_AUDIT_EVENTS = 64;

/** Retain the latest version per entity across reads/days, bounded by retention and capacity.
 * Missing feed entries are NOT deletions. An unchanged version does not extend its retention.
 * Older upstream timestamps cannot replace newer metadata. Equal timestamps may still contain corrections.
 */
export function mergeCatalog(previous: readonly FeedRecord[], incoming: readonly FeedRecord[], now: number) {
  const records = new Map(previous.filter(r => r.content.expiresAt > now).map(r => [r.provenance.entityKey, r]));
  let added = 0; let updated = 0; let unchanged = 0;
  for (const record of incoming) {
    const old = records.get(record.provenance.entityKey);
    if (!old) { records.set(record.provenance.entityKey, record); added++; }
    else if (old.provenance.versionHash === record.provenance.versionHash
      || old.provenance.updatedAt > record.provenance.updatedAt) unchanged++;
    else { records.set(record.provenance.entityKey, record); updated++; }
  }
  return { records: [...records.values()].sort((a, b) => b.provenance.updatedAt - a.provenance.updatedAt
    || a.provenance.entityKey.localeCompare(b.provenance.entityKey)).slice(0, MAX_CATALOG_RECORDS), added, updated, unchanged };
}
