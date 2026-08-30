import type { PersonalCatalog } from './catalog.js';
import type { TemporalSource, PersonalTemporalSnapshot, WeatherDay, CalendarOccurrence } from './temporalSources.js';

export const CATALOG_SCHEMA_VERSION = 2 as const;
export type TemporalSnapshot = (PersonalTemporalSnapshot<WeatherDay> & { readonly kind: 'weather' })
  | (PersonalTemporalSnapshot<CalendarOccurrence> & { readonly kind: 'calendar' });
/** Opaque authority epoch, not a credential or calendar identifier. Revalidated before every return. */
export interface TemporalGrant { readonly stamp: string; readonly expiresAt: number }
export interface TemporalCatalogEntry {
  readonly id: string;
  readonly source: TemporalSource | null;
  readonly snapshot: { readonly content: TemporalSnapshot; readonly grant: TemporalGrant } | null;
}
export interface VersionedCatalog extends PersonalCatalog {
  readonly schemaVersion: 2;
  readonly temporalSources: readonly TemporalCatalogEntry[];
}
/** Deployment prerequisite. No implicit createCollection/collMod on application startup.
 * Strict/error rejects legacy replacement documents that omit the new fields.
 * Existing legacy documents remain readable until an explicit owner write upgrades them.
 */
export const CATALOG_VALIDATOR = { $jsonSchema: {
  bsonType: 'object', required: ['_id', 'owner', 'revision', 'sources', 'audit', 'schemaVersion', 'temporalSources'], additionalProperties: false,
  properties: { _id: { bsonType: 'string' }, owner: { bsonType: 'string' }, revision: { bsonType: ['int', 'long', 'double'] },
    sources: { bsonType: 'array', maxItems: 32 }, audit: { bsonType: 'array', maxItems: 64 },
    schemaVersion: { enum: [2] }, temporalSources: { bsonType: 'array', maxItems: 32 }, acquisition: { bsonType: 'object' } },
} };
export function catalogShape(row: PersonalCatalog): VersionedCatalog {
  const value = row as unknown as Record<string, unknown>;
  const allowed = ['owner', 'revision', 'sources', 'audit', 'acquisition', 'schemaVersion', 'temporalSources'];
  if (!value || Object.keys(value).some(k => !allowed.includes(k))
    || (value.schemaVersion !== undefined && value.schemaVersion !== CATALOG_SCHEMA_VERSION)
    || (value.schemaVersion === undefined ? value.temporalSources !== undefined : !Array.isArray(value.temporalSources)))
    throw new Error('RADAR_CATALOG_SCHEMA');
  return { ...row, schemaVersion: CATALOG_SCHEMA_VERSION, temporalSources: (value.temporalSources ?? []) as readonly TemporalCatalogEntry[] };
}
