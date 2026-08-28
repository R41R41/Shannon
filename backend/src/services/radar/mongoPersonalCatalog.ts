import { CATALOG_VALIDATOR, catalogShape } from '../../modules/radar/catalogVersion.js';
import type { mongo } from 'mongoose';
import type { PersonalCatalog, PersonalCatalogPort } from '../../modules/radar/catalog.js';

type Document = PersonalCatalog & { _id: string };
const writeConcern = { w: 'majority' as const, j: true, wtimeoutMS: 5000 };
/** Explicit DB injection, no global connection, constructor I/O, indexes, timers or migration. */
export class MongoPersonalCatalog implements PersonalCatalogPort {
  private readonly collection: mongo.Collection<Document>;
  constructor(private readonly db: mongo.Db) { this.collection = db.collection<Document>('radarpersonalcatalogs'); }
  async read(owner: string): Promise<PersonalCatalog | null> {
    if (!/^firebase:[a-f0-9]{64}$/.test(owner)) throw new Error('RADAR_CATALOG_UNAVAILABLE');
    const row = await this.collection.findOne({ _id: owner, owner }, { maxTimeMS: 5000, readPreference: 'primary' });
    if (!row) return null;
    const { _id: ignored, ...value } = row;
    catalogShape(value);
    return value;
  }
  async compareAndSwap(owner: string, expected: number, next: PersonalCatalog): Promise<boolean> {
    if (!/^firebase:[a-f0-9]{64}$/.test(owner) || next.owner !== owner || !Number.isSafeInteger(expected)
      || expected < 0 || next.revision !== expected + 1 || Buffer.byteLength(JSON.stringify(next)) > 1024 * 1024)
      throw new Error('RADAR_CATALOG_UNAVAILABLE');
    if (next.schemaVersion !== 2 || !Array.isArray(next.temporalSources)) throw new Error('RADAR_CATALOG_SCHEMA');
    catalogShape(next);
    // Fail closed until an operator has installed the reviewed DB fence in a separate migration step.
    const info = await this.db.listCollections({ name: 'radarpersonalcatalogs' }, { nameOnly: false }).toArray();
    const options = info[0]?.options;
    const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
    if (info.length !== 1 || options?.validationLevel !== 'strict' || options?.validationAction !== 'error'
      || canonical(options.validator) !== canonical(CATALOG_VALIDATOR)) throw new Error('RADAR_CATALOG_FENCE_REQUIRED');
    const document: Document = { ...next, _id: owner };
    if (expected === 0) {
      try { await this.collection.insertOne(document, { writeConcern }); return true; }
      catch (error) { if ((error as { code?: number }).code === 11000) return false; throw error; }
    }
    const result = await this.collection.replaceOne({ _id: owner, owner, revision: expected, $or: [{ schemaVersion: 2 }, { schemaVersion: { $exists: false } }] }, document, { upsert: false, writeConcern });
    return result.matchedCount === 1;
  }
}
