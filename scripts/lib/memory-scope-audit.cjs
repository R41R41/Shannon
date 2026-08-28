'use strict';

// Inventory only. A structurally stamped record is NOT certified safe to expose or migrate.
const COLLECTIONS = Object.freeze(['shannonmemories', 'personmemories', 'memorywriteevents']);
const PROJECTION = Object.freeze({ _id: 0, scopeVersion: 1, scopeKey: 1, visibilityScope: 1, ownerUserId: 1 });
const nonempty = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\x00-\x1f]/.test(value);
const snowflake = value => nonempty(value) && /^\d+$/.test(value);

function classifyMetadata(collection, row) {
  if (!COLLECTIONS.includes(collection)) throw new Error('UNSUPPORTED_MEMORY_COLLECTION');
  // Old person records pooled sources and audiences. Never infer safety from a new-looking field.
  if (collection === 'personmemories') return 'person_source_and_audience_review_required';
  if (row.scopeVersion == null && row.scopeKey == null) return 'legacy_scope_missing';
  if (row.scopeVersion !== 1 || !nonempty(row.scopeKey)) return 'invalid_or_unsupported_scope_stamp';
  let parts;
  try { parts = JSON.parse(row.scopeKey); } catch { return 'invalid_or_unsupported_scope_stamp'; }
  if (!Array.isArray(parts) || !parts.every(nonempty) || JSON.stringify(parts) !== row.scopeKey) return 'invalid_or_unsupported_scope_stamp';
  const dm = parts.length === 6 && parts[0] === 'discord' && parts[1] === 'dm' && snowflake(parts[2]) && snowflake(parts[3]);
  const channel = parts.length === 6 && parts[0] === 'discord' && parts[1] === 'channel' && snowflake(parts[2]) && snowflake(parts[3]);
  const world = parts.length === 5 && parts[0] === 'minecraft' && parts[1] === 'world'
    && !['default', 'unknown'].includes(parts[2]) && !['default', 'unknown'].includes(parts[3])
    && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(parts[4]);
  if (!(dm || channel || world) || !nonempty(row.ownerUserId)) return 'invalid_or_unsupported_scope_stamp';
  if (dm && row.ownerUserId !== `discord:${parts[2]}`) return 'invalid_or_unsupported_scope_stamp';
  if (collection === 'memorywriteevents') return 'stamped_job_envelope_review_required';
  const visibility = dm ? 'private_user' : channel ? 'shared_channel' : 'shared_world';
  return row.visibilityScope === visibility ? 'structurally_scoped_not_content_reviewed' : 'invalid_or_unsupported_scope_stamp';
}

async function auditMemoryMetadata(db, maxPerCollection = 100000) {
  if (!Number.isInteger(maxPerCollection) || maxPerCollection < 1 || maxPerCollection > 100000) throw new Error('INVALID_AUDIT_LIMIT');
  const report = { mode: 'read-only-dry-run', automaticMigrationCandidates: 0,
    contentRead: false, complete: true, maxPerCollection, collections: {} };
  for (const name of COLLECTIONS) {
    const counts = {}; let scanned = 0; let truncated = false;
    const cursor = db.collection(name).find({}, { projection: { ...PROJECTION }, maxTimeMS: 10000, batchSize: 500 }).limit(maxPerCollection + 1);
    try {
      for await (const row of cursor) {
        if (scanned >= maxPerCollection) { truncated = true; break; }
        scanned++;
        const reason = classifyMetadata(name, row);
        counts[reason] = (counts[reason] || 0) + 1;
      }
    } finally { await cursor.close(); }
    report.collections[name] = { scanned, truncated, counts };
    if (truncated) report.complete = false;
  }
  return report;
}
module.exports = { COLLECTIONS, PROJECTION, classifyMetadata, auditMemoryMetadata };
