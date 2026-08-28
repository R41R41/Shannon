import type { mongo } from 'mongoose';
import type { PersonalCatalog, PersonalCatalogPort } from '../../modules/radar/catalog.js';

type Document = PersonalCatalog & { _id: string };
/** Explicit DB injection, no global connection, constructor I/O, indexes, timers or migration. */
export class MongoPersonalCatalog implements PersonalCatalogPort {
  private readonly collection: mongo.Collection<Document>;
  constructor(db: mongo.Db) { this.collection = db.collection<Document>('radarpersonalcatalogs'); }
  async read(owner: string): Promise<PersonalCatalog | null> {
    if (!/^firebase:[a-f0-9]{64}$/.test(owner)) throw new Error('RADAR_CATALOG_UNAVAILABLE');
    const row = await this.collection.findOne({ _id: owner, owner }, { maxTimeMS: 5000 });
    if (!row) return null;
    return { owner: row.owner, revision: row.revision, sources: row.sources, audit: row.audit };
  }
  async compareAndSwap(owner: string, expected: number, next: PersonalCatalog): Promise<boolean> {
    if (!/^firebase:[a-f0-9]{64}$/.test(owner) || next.owner !== owner || !Number.isSafeInteger(expected)
      || expected < 0 || next.revision !== expected + 1 || Buffer.byteLength(JSON.stringify(next)) > 1024 * 1024)
      throw new Error('RADAR_CATALOG_UNAVAILABLE');
    const document: Document = { ...next, _id: owner };
    if (expected === 0) {
      try { await this.collection.insertOne(document); return true; }
      catch (error) { if ((error as { code?: number }).code === 11000) return false; throw error; }
    }
    const result = await this.collection.replaceOne({ _id: owner, owner, revision: expected }, document, { upsert: false });
    return result.matchedCount === 1;
  }
}
