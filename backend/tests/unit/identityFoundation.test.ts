import { describe, expect, it, vi } from 'vitest';
import { AccessError, type RequestContext } from '../../src/modules/access/index.js';
import {
  IdentityInputError,
  IdentityManifestReviewService,
  IdentityStatusService,
  buildDefaultIdentityStatus,
  parseBindingManifest,
} from '../../src/modules/identity/index.js';
import { StaticIdentityStatusRepository } from '../../src/adapters/identity/StaticIdentityStatusRepository.js';

const context: RequestContext = Object.freeze({
  requestId: 'req-1',
  principal: Object.freeze({ uid: 'firebase-user', projectId: 'dev-project', name: 'Test', email: 'test@example.test' }),
  capabilities: Object.freeze(['profile:read', 'models:read', 'models:write', 'console:access']),
  expiresAtMs: Date.now() + 60_000,
});

describe('identity foundation', () => {
  it('returns read-only binding status without secrets', async () => {
    const snapshot = await new IdentityStatusService(new StaticIdentityStatusRepository()).read(context);
    expect(snapshot.identity.uid).toBe('firebase-user');
    expect(snapshot.bindings.find(b => b.channel === 'web')?.status).toBe('linked');
    expect(snapshot.bindings.find(b => b.channel === 'discord')?.status).toBe('unlinked');
    expect(JSON.stringify(snapshot)).not.toMatch(/token|secret|refresh/i);
  });

  it('rejects unauthenticated status reads', async () => {
    await expect(new IdentityStatusService(new StaticIdentityStatusRepository()).read(null)).rejects.toThrow(AccessError);
  });

  it('validates manifest shape without touching users', () => {
    expect(() => parseBindingManifest({ version: 1, projectId: 'dev-project', reviewedBy: 'reviewer', bindings: [] })).not.toThrow();
    expect(() => parseBindingManifest({ version: 2 })).toThrow(IdentityInputError);
    expect(() => parseBindingManifest({
      version: 1,
      projectId: 'dev-project',
      reviewedBy: 'reviewer',
      bindings: [{ userId: 'u1', uid: 'uid1', isAuthorized: false, isAdmin: true }],
    })).toThrow(IdentityInputError);
  });

  it('reviews manifest plans through injected repository and planner', async () => {
    const listUsers = vi.fn(async () => [{ _id: 'user1', email: 'user@example.test', isAdmin: true, isAuthorized: true }]);
    const planBindings = vi.fn((_users, manifest) => ({
      projectId: manifest.projectId,
      reviewedBy: manifest.reviewedBy,
      operationCount: 1,
      unboundAfter: 0,
      sha256: 'abc',
      operations: [{ userId: 'user1', email: 'user@example.test', after: {
        firebaseProjectId: manifest.projectId,
        firebaseUid: 'firebase-user',
        isAuthorized: true,
        isAdmin: false,
      } }],
    }));
    const service = new IdentityManifestReviewService({ listUsers }, planBindings);
    const result = await service.review(context, {
      version: 1,
      projectId: 'dev-project',
      reviewedBy: 'reviewer',
      bindings: [{ userId: 'user1', uid: 'firebase-user', isAuthorized: true, isAdmin: false }],
    });
    expect(result.operationCount).toBe(1);
    expect(result.operations[0].after.isAdmin).toBe(false);
    expect(listUsers).toHaveBeenCalledOnce();
  });

  it('requires console access for manifest review', async () => {
    const limited = { ...context, capabilities: Object.freeze(['profile:read']) } as RequestContext;
    const service = new IdentityManifestReviewService({ listUsers: async () => [] }, () => ({
      projectId: 'dev-project',
      reviewedBy: 'reviewer',
      operationCount: 0,
      unboundAfter: 0,
      sha256: 'abc',
      operations: [],
    }));
    await expect(service.review(limited, { version: 1, projectId: 'dev-project', reviewedBy: 'r', bindings: [] }))
      .rejects.toThrow(AccessError);
  });

  it('buildDefaultIdentityStatus marks web linked only', () => {
    const snapshot = buildDefaultIdentityStatus(context);
    expect(snapshot.audience.memoryChannels).toContain('web');
    expect(snapshot.bindings.every(b => b.channel === 'web' ? b.status === 'linked' : b.status === 'unlinked')).toBe(true);
  });
});
