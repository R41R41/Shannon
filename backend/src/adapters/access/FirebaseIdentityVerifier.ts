import { AccessError, type IdentityVerifier, type VerifiedIdentity } from '../../modules/access/index.js';
import type { Auth } from 'firebase-admin/auth';

/** Lazy SDK initialization: construction never reads credentials or contacts Firebase. */
export class FirebaseIdentityVerifier implements IdentityVerifier {
  private auth: Auth | null = null;
  constructor(private readonly projectId: string) {}
  async verify(idToken: string): Promise<VerifiedIdentity> {
    // The real app must not accidentally accept unsigned emulator tokens.
    if (!this.projectId || process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new AccessError('AUTH_UNAVAILABLE');
    try {
      if (!this.auth) {
        const { initializeApp, getApps, applicationDefault } = await import('firebase-admin/app');
        const { getAuth } = await import('firebase-admin/auth');
        const name = `shannon-web-${this.projectId}`;
        const app = getApps().find(candidate => candidate.name === name)
          ?? initializeApp({ projectId: this.projectId, credential: applicationDefault() }, name);
        this.auth = getAuth(app);
      }
      const token = await this.auth.verifyIdToken(idToken, true);
      if (token.aud !== this.projectId || token.iss !== `https://securetoken.google.com/${this.projectId}`) {
        throw new AccessError('UNAUTHENTICATED');
      }
      return { projectId: this.projectId, uid: token.uid, email: token.email ?? '',
        emailVerified: token.email_verified === true, expiresAtMs: token.exp * 1000 };
    } catch (error) {
      if (error instanceof AccessError) throw error;
      const code = (error as { code?: string })?.code;
      if (['auth/argument-error', 'auth/invalid-id-token', 'auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled', 'auth/user-not-found'].includes(code ?? '')) {
        throw new AccessError('UNAUTHENTICATED');
      }
      // Do not expose tokens, SDK errors, credentials or project details to clients/logs.
      throw new AccessError('AUTH_UNAVAILABLE');
    }
  }
}
