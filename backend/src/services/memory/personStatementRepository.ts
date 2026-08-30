import { createHash } from 'node:crypto';
import { ScopedPersonStatement, type IScopedPersonStatement } from '../../models/ScopedPersonStatement.js';
import { hasPersonBinding, personFilter, personLimit, type PersonBinding, type PersonSource, type PersonStatement } from '../../modules/memory/personMemory.js';

export interface PersonStatementRepository {
  recall(binding: PersonBinding, limit?: number): Promise<PersonStatement[]>;
  insert(binding: PersonBinding, quote: string, source: PersonSource): Promise<PersonStatement | null>;
  correct(binding: PersonBinding, id: string, revision: number, quote: string, source: PersonSource): Promise<PersonStatement | null>;
  forget(binding: PersonBinding, id: string, revision: number): Promise<boolean>;
}
const validId = (id: string, revision: number) => /^[a-f0-9]{64}$/.test(id) && Number.isSafeInteger(revision) && revision >= 1;
function statement(row: IScopedPersonStatement | null): PersonStatement | null {
  if (!row || row.status !== 'active' || typeof row.quote !== 'string' || !row.quote.trim() || row.quote.length > 1000
      || !row.source || !/^\d+$/.test(row.source.messageId) || !Number.isFinite(Date.parse(row.source.receivedAt))
      || !validId(row._id, row.revision)) return null;
  return Object.freeze({ id: row._id, revision: row.revision, quote: row.quote, source: Object.freeze({
    messageId: row.source.messageId, requestId: row.source.requestId, receivedAt: row.source.receivedAt,
  }) });
}
function originId(binding: PersonBinding, source: PersonSource): string {
  // One selected excerpt per source message; edits/retries cannot allocate a new record to bypass a tombstone.
  return createHash('sha256').update(JSON.stringify([1, binding.scope.scopeKey, binding.subjectId, source.messageId])).digest('hex');
}

/** Stateless Mongo adapter. All operations require an issued binding; legacy PersonMemory is never touched. */
export const personStatementRepository: PersonStatementRepository = {
  async recall(binding, limit) {
    if (!hasPersonBinding(binding)) return [];
    const filter = { ...personFilter(binding), status: 'active' };
    const rows = await ScopedPersonStatement.find(filter).sort({ 'source.receivedAt': -1, _id: 1 }).limit(personLimit(limit)).lean();
    // Defense against malformed storage/fake adapters; no unscoped output even after hydration.
    return rows.filter(row => Object.entries(filter).every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value))
      .map(statement).filter((row): row is PersonStatement => !!row);
  },
  async insert(binding, quote, source) {
    if (!hasPersonBinding(binding)) return null;
    const filter = { _id: originId(binding, source), ...personFilter(binding) };
    try {
      const row = await ScopedPersonStatement.findOneAndUpdate(filter, { $setOnInsert: {
        ...filter, status: 'active', revision: 1, quote, source: { ...source },
      } }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: false }).lean();
      // A correction/tombstone must not be silently replaced by a retry of the old source.
      return row?.status === 'active' && row.revision === 1 && row.quote === quote && row.source?.messageId === source.messageId ? statement(row) : null;
    } catch (error) {
      // Concurrent upserts may race on the primary key; read only the same scoped origin.
      if ((error as { code?: number }).code !== 11000) throw error;
      const row = await ScopedPersonStatement.findOne(filter).lean();
      return row?.status === 'active' && row.revision === 1 && row.quote === quote ? statement(row) : null;
    }
  },
  async correct(binding, id, revision, quote, source) {
    if (!hasPersonBinding(binding) || !validId(id, revision)) return null;
    const row = await ScopedPersonStatement.findOneAndUpdate({ _id: id, ...personFilter(binding), status: 'active', revision, 'source.messageId': source.messageId },
      { $set: { quote, source: { ...source } }, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
    return statement(row);
  },
  async forget(binding, id, revision) {
    if (!hasPersonBinding(binding) || !validId(id, revision)) return false;
    const row = await ScopedPersonStatement.findOneAndUpdate({ _id: id, ...personFilter(binding), status: 'active', revision },
      { $set: { status: 'forgotten' }, $unset: { quote: '', source: '' }, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
    return row?.status === 'forgotten';
  },
};
