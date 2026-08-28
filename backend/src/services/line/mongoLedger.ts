import type { mongo } from 'mongoose';
import type { LineState, LineStatePort } from './ledger.js';
import { lineUserId } from '../../modules/conversation/lineConversation.js';
type Document = LineState & { _id: string };
const writeConcern = { w: 'majority' as const, j: true, wtimeoutMS: 5000 };
export const LINE_LEDGER_COLLECTION = 'linechannelledgers';
/** Explicit new collection. No use of global connections, legacy chat data, migrations or TTL deletion. */
export class MongoLineLedger implements LineStatePort {
  private readonly collection: mongo.Collection<Document>;
  constructor(db: mongo.Db) { this.collection = db.collection<Document>(LINE_LEDGER_COLLECTION); }
  async read(botUserId: string): Promise<LineState | null> {
    if (!lineUserId(botUserId)) throw new Error('LINE_LEDGER_INVALID');
    const row = await this.collection.findOne({ _id: botUserId }, { maxTimeMS: 5000, readPreference: 'primary' });
    if (!row) return null;
    const { _id, ...state } = row; this.validate(state); return state;
  }
  private validate(s: LineState) {
    if (s.schemaVersion !== 1 || !lineUserId(s.botUserId) || (s.personalUserId !== '' && !lineUserId(s.personalUserId))
      || !Number.isSafeInteger(s.revision) || s.revision < 1 || typeof s.optedIn !== 'boolean'
      || !Number.isSafeInteger(s.consentVersion) || s.consentVersion < 0 || !Number.isSafeInteger(s.controlAt)
      || !Array.isArray(s.entries) || s.entries.length > 2000 || Buffer.byteLength(JSON.stringify(s)) > 2 * 1024 * 1024
      || new Set(s.entries.map(e => e.id)).size !== s.entries.length
      || s.entries.some(e => !/^[a-f0-9]{64}$/.test(e.id) || !/^[a-f0-9]{64}$/.test(e.scope)
        || !['chat','control','push'].includes(e.kind) || !['reserved','pending','sending','accepted','unknown','failed','cancelled'].includes(e.status)
        || !Number.isSafeInteger(e.at) || !Number.isSafeInteger(e.expiresAt)
        || (e.text !== undefined && (e.kind !== 'push' || typeof e.text !== 'string' || e.text.length > 4500)))) throw new Error('LINE_LEDGER_INVALID');
  }
  async compareAndSwap(botUserId: string, expected: number, next: LineState): Promise<boolean> {
    this.validate(next);
    if (next.botUserId !== botUserId || !Number.isSafeInteger(expected) || expected < 0 || next.revision !== expected + 1) throw new Error('LINE_LEDGER_INVALID');
    if (expected === 0) {
      try { await this.collection.insertOne({ ...next, _id: botUserId }, { writeConcern }); return true; }
      catch (e) { if ((e as { code?: number }).code === 11000) return false; throw e; }
    }
    const document: Document = { ...next, _id: botUserId };
    const result = await this.collection.replaceOne({ _id: botUserId, schemaVersion: 1, revision: expected, personalUserId: next.personalUserId },
      document, { upsert: false, writeConcern });
    return result.matchedCount === 1;
  }
}
