/** Pure application boundary: no SDK, database, environment, timer or transport. */
export type Capability = 'profile:read' | 'models:read' | 'models:write' | 'console:access';
export interface VerifiedIdentity {
  readonly projectId: string;
  readonly uid: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly expiresAtMs: number;
}
export interface IdentityVerifier {
  verify(idToken: string): Promise<VerifiedIdentity>;
}
export interface AccessUser {
  readonly uid: string;
  readonly projectId: string;
  readonly name: string;
  readonly email: string;
  readonly isAuthorized: boolean;
  readonly isAdmin: boolean;
}
export interface AccessUserRepository {
  findByIdentity(projectId: string, uid: string): Promise<AccessUser | null>;
}
export interface RequestContext {
  readonly requestId: string;
  readonly principal: Readonly<{ uid: string; projectId: string; name: string; email: string }>;
  readonly capabilities: readonly Capability[];
  readonly expiresAtMs: number;
}
export class AccessError extends Error {
  constructor(public readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'AUTH_UNAVAILABLE') {
    super(code);
    this.name = 'AccessError';
  }
}
export function requireCapability(context: RequestContext | null | undefined, capability: Capability, now = Date.now()): asserts context is RequestContext {
  if (!context || !Number.isFinite(context.expiresAtMs) || context.expiresAtMs <= now) {
    throw new AccessError('UNAUTHENTICATED');
  }
  if (!context.capabilities.includes(capability)) throw new AccessError('FORBIDDEN');
}
export class AccessService {
  constructor(
    private readonly verifier: IdentityVerifier,
    private readonly users: AccessUserRepository,
    private readonly newRequestId: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  async authenticate(idToken: unknown): Promise<RequestContext> {
    if (typeof idToken !== 'string' || !idToken || idToken.length > 16384 || /\s/.test(idToken)) {
      throw new AccessError('UNAUTHENTICATED');
    }
    let identity: VerifiedIdentity;
    try { identity = await this.verifier.verify(idToken); }
    catch (error) {
      if (error instanceof AccessError) throw error;
      throw new AccessError('AUTH_UNAVAILABLE');
    }
    if (!identity.uid || !identity.projectId || !identity.email || !identity.emailVerified ||
        !Number.isFinite(identity.expiresAtMs) || identity.expiresAtMs <= this.now()) {
      throw new AccessError('UNAUTHENTICATED');
    }
    let user: AccessUser | null;
    try { user = await this.users.findByIdentity(identity.projectId, identity.uid); }
    catch { throw new AccessError('AUTH_UNAVAILABLE'); }
    // Never bind by email or copy the historical auto-admin flags to a new UID.
    if (!user || user.isAuthorized !== true || user.uid !== identity.uid || user.projectId !== identity.projectId) {
      throw new AccessError('FORBIDDEN');
    }
    const capabilities: Capability[] = ['profile:read'];
    if (user.isAdmin === true) capabilities.push('models:read', 'models:write', 'console:access');
    const context: RequestContext = Object.freeze({
      requestId: this.newRequestId(),
      principal: Object.freeze({ uid: identity.uid, projectId: identity.projectId, name: user.name, email: identity.email }),
      capabilities: Object.freeze(capabilities),
      expiresAtMs: identity.expiresAtMs,
    });
    requireCapability(context, 'profile:read', this.now());
    return context;
  }
}
