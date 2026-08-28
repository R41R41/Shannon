import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { classifyMetadata, auditMemoryMetadata, PROJECTION } = require('../../../scripts/lib/memory-scope-audit.cjs');
const { validateInvocation } = require('../../../scripts/audit-dev-memory-scopes.cjs');
const dm = { scopeVersion: 1, scopeKey: JSON.stringify(['discord', 'dm', '123', '456', 'conversation', 'thread']), visibilityScope: 'private_user', ownerUserId: 'discord:123' };

describe('read-only legacy memory inventory', () => {
  it('never grants automatic migration to legacy private/public data or pooled person memories', () => {
    expect(classifyMetadata('shannonmemories', { visibilityScope: 'shared_channel' })).toBe('legacy_scope_missing');
    expect(classifyMetadata('memorywriteevents', {})).toBe('legacy_scope_missing');
    expect(classifyMetadata('personmemories', dm)).toBe('person_source_and_audience_review_required');
  });
  it('distinguishes structural stamps from content/envelope review', () => {
    expect(classifyMetadata('shannonmemories', dm)).toBe('structurally_scoped_not_content_reviewed');
    expect(classifyMetadata('memorywriteevents', dm)).toBe('stamped_job_envelope_review_required');
  });
  it.each([{ ...dm, scopeVersion: 2 }, { ...dm, scopeKey: '{}' }, { ...dm, scopeKey: '["arbitrary"]' },
    { ...dm, visibilityScope: 'shared_channel' }, { ...dm, ownerUserId: 'discord:999' }, { ...dm, scopeKey: undefined }])('quarantines invalid or inconsistent stamps (%#)', row => {
    expect(classifyMetadata('shannonmemories', row)).toBe('invalid_or_unsupported_scope_stamp');
  });
  it('reads only whitelisted metadata and returns counts without keys, identities, names or text', async () => {
    const cursors: any[] = [];
    const find = vi.fn(() => {
      const cursor = { limit: vi.fn(() => cursor), close: vi.fn(async () => {}),
        async *[Symbol.asyncIterator]() { yield dm; yield {}; } };
      cursors.push(cursor); return cursor;
    });
    const collection = vi.fn(() => ({ find }));
    const result = await auditMemoryMetadata({ collection });
    expect(collection.mock.calls.map(([name]) => name)).toEqual(['shannonmemories', 'personmemories', 'memorywriteevents']);
    for (const call of find.mock.calls as any) expect(call).toEqual([{}, { projection: PROJECTION, maxTimeMS: 10000, batchSize: 500 }]);
    for (const cursor of cursors) expect(cursor.close).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ automaticMigrationCandidates: 0, contentRead: false, complete: true });
    const output = JSON.stringify(result);
    for (const sensitive of ['discord:123', 'conversation', 'scopeKey', 'private_user']) expect(output).not.toContain(sensitive);
    expect(result.collections.personmemories.counts.person_source_and_audience_review_required).toBe(2);
  });
  it('reports truncation instead of describing a bounded scan as complete', async () => {
    const cursor = { limit: () => cursor, close: async () => {}, async *[Symbol.asyncIterator]() { yield {}; yield {}; } };
    const result = await auditMemoryMetadata({ collection: () => ({ find: () => cursor }) }, 1);
    expect(result.complete).toBe(false); expect(result.collections.shannonmemories.scanned).toBe(1);
  });
  it('closes cursor on failure and does not turn a failed read into an empty successful report', async () => {
    const cursor = { limit: () => cursor, close: vi.fn(async () => {}), async *[Symbol.asyncIterator]() { throw new Error('read failed'); } };
    await expect(auditMemoryMetadata({ collection: () => ({ find: () => cursor }) })).rejects.toThrow('read failed');
    expect(cursor.close).toHaveBeenCalledOnce();
  });
  it.each([
    [[], '/home/azureuser/Shannon-dev', true], [['--apply'], '/home/azureuser/Shannon-dev', true],
    [['--dev-read-only', '--uri=prod'], '/home/azureuser/Shannon-dev', true],
    [['--dev-read-only'], '/home/azureuser/Shannon-prod', true], [['--dev-read-only'], '/home/azureuser/Shannon-dev', false],
  ])('refuses unapproved targets, write flags, and unlocked app use (%#)', (args, root, lock) => {
    expect(() => validateInvocation(args, root, lock)).toThrow();
  });
  it('accepts only the locked dev read-only entrypoint', () => {
    expect(() => validateInvocation(['--dev-read-only'], '/home/azureuser/Shannon-dev', true)).not.toThrow();
  });
});
