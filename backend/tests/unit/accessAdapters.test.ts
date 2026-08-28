import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn(), initializeApp: vi.fn(() => ({ name: 'test' })), applicationDefault: vi.fn(() => ({})), findOne: vi.fn() }));
vi.mock('firebase-admin/app', () => ({ initializeApp: mocks.initializeApp, applicationDefault: mocks.applicationDefault, getApps: () => [] }));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken: mocks.verifyIdToken }) }));
vi.mock('../../src/models/User.js', () => ({ User: { findOne: mocks.findOne } }));
import { FirebaseIdentityVerifier } from '../../src/adapters/access/FirebaseIdentityVerifier.js';
import { MongoAccessUserRepository } from '../../src/adapters/access/MongoAccessUserRepository.js';
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe('Firebase adapter', () => {
  it('is lazy and requires expiry/signature verification plus revocation checking by the official SDK', async () => {
    const verifier = new FirebaseIdentityVerifier('test-project'); expect(mocks.initializeApp).not.toHaveBeenCalled();
    mocks.verifyIdToken.mockResolvedValue({ uid: 'uid', aud: 'test-project', iss: 'https://securetoken.google.com/test-project', email: 'x@example.test', email_verified: true, exp: 123 });
    expect(await verifier.verify('token')).toMatchObject({ uid: 'uid', projectId: 'test-project', expiresAtMs: 123000 });
    expect(mocks.verifyIdToken).toHaveBeenCalledWith('token', true);
  });
  it.each(['auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled', 'auth/invalid-id-token'])('rejects SDK failure %s', async code => {
    mocks.verifyIdToken.mockRejectedValue({ code });
    await expect(new FirebaseIdentityVerifier('test-project').verify('token')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it('fails closed for configuration/credential failure, never switches to emulator or unsigned verification', async () => {
    await expect(new FirebaseIdentityVerifier('').verify('token')).rejects.toMatchObject({ code: 'AUTH_UNAVAILABLE' });
    vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', 'localhost:9999');
    await expect(new FirebaseIdentityVerifier('test-project').verify('token')).rejects.toMatchObject({ code: 'AUTH_UNAVAILABLE' });
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
  });
  it('rejects another project even if a verifier returns a token', async () => {
    mocks.verifyIdToken.mockResolvedValue({ aud: 'other', iss: 'other' });
    await expect(new FirebaseIdentityVerifier('test-project').verify('token')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
it('Mongo adapter queries the reviewed project/UID binding and does not create users or bind by email', async () => {
  const exec = vi.fn(async () => null); const lean = vi.fn(() => ({ exec })); const select = vi.fn(() => ({ lean }));
  mocks.findOne.mockReturnValue({ select });
  expect(await new MongoAccessUserRepository().findByIdentity('project', 'uid')).toBeNull();
  expect(mocks.findOne).toHaveBeenCalledWith({ firebaseProjectId: 'project', firebaseUid: 'uid' });
  expect(exec).toHaveBeenCalledOnce();
});
