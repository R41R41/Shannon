import { requireCapability, type RequestContext } from '../access/index.js';

export type IdentityChannelKind = 'web' | 'discord' | 'line' | 'minecraft' | 'radar';
export type BindingStatus = 'linked' | 'unlinked' | 'expired';

export interface ChannelBindingView {
  readonly channel: IdentityChannelKind;
  readonly status: BindingStatus;
  readonly label: string;
  readonly expiresAtIso?: string;
}

export interface AudiencePolicyView {
  readonly memoryChannels: readonly string[];
  readonly radarPersonalFeed: boolean;
  readonly lineDeliveryEnabled: boolean;
}

export interface IdentityStatusSnapshot {
  readonly identity: Readonly<{ projectId: string; uid: string; email: string; name: string }>;
  readonly bindings: readonly ChannelBindingView[];
  readonly audience: AudiencePolicyView;
}

export interface BindingManifestV1 {
  readonly version: 1;
  readonly projectId: string;
  readonly reviewedBy: string;
  readonly bindings: readonly Readonly<{
    readonly userId: string;
    readonly uid: string;
    readonly isAuthorized: boolean;
    readonly isAdmin: boolean;
  }>[];
}

export interface BindingManifestPlanSummary {
  readonly projectId: string;
  readonly reviewedBy: string;
  readonly operationCount: number;
  readonly unboundAfter: number;
  readonly sha256: string;
  readonly operations: readonly Readonly<{
    readonly userId: string;
    readonly email: string;
    readonly after: Readonly<{ firebaseProjectId: string; firebaseUid: string; isAuthorized: boolean; isAdmin: boolean }>;
  }>[];
}

export interface IdentityStatusRepository {
  snapshotFor(context: RequestContext): IdentityStatusSnapshot;
}

export interface MigrationUserRecord {
  readonly _id: string;
  readonly email: string;
  readonly firebaseUid?: string | null;
  readonly firebaseProjectId?: string | null;
  readonly isAuthorized?: boolean;
  readonly isAdmin?: boolean;
}

export interface IdentityMigrationUserRepository {
  listUsers(): Promise<readonly MigrationUserRecord[]>;
}

export type BindingManifestPlanner = (
  users: readonly MigrationUserRecord[],
  manifest: BindingManifestV1,
) => BindingManifestPlanSummary;

const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/.test(value);

export function parseBindingManifest(raw: unknown): BindingManifestV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new IdentityInputError('INVALID_MANIFEST');
  const manifest = raw as Record<string, unknown>;
  if (manifest.version !== 1 || !id(manifest.projectId) || !id(manifest.reviewedBy) || !Array.isArray(manifest.bindings)) {
    throw new IdentityInputError('INVALID_MANIFEST');
  }
  const bindings = manifest.bindings.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new IdentityInputError('INVALID_BINDING');
    const binding = entry as Record<string, unknown>;
    if (!id(binding.userId) || !id(binding.uid) || typeof binding.isAuthorized !== 'boolean' || typeof binding.isAdmin !== 'boolean') {
      throw new IdentityInputError('INVALID_BINDING');
    }
    if (binding.isAdmin === true && binding.isAuthorized !== true) throw new IdentityInputError('INVALID_BINDING');
    return Object.freeze({
      userId: binding.userId,
      uid: binding.uid,
      isAuthorized: binding.isAuthorized,
      isAdmin: binding.isAdmin,
    });
  });
  return Object.freeze({
    version: 1,
    projectId: manifest.projectId,
    reviewedBy: manifest.reviewedBy,
    bindings: Object.freeze(bindings),
  });
}

export class IdentityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityInputError';
  }
}

/** Read-only Identity–Binding–Audience view. No secrets, no writes. */
export class IdentityStatusService {
  constructor(
    private readonly repository: IdentityStatusRepository,
    private readonly now: () => number = Date.now,
  ) {}

  read(context: RequestContext | null): IdentityStatusSnapshot {
    requireCapability(context, 'profile:read', this.now());
    return this.repository.snapshotFor(context);
  }
}

/** Admin-only dry-run manifest review; does not mutate users or Firebase. */
export class IdentityManifestReviewService {
  constructor(
    private readonly users: IdentityMigrationUserRepository,
    private readonly planBindings: BindingManifestPlanner,
    private readonly now: () => number = Date.now,
  ) {}

  async review(context: RequestContext | null, rawManifest: unknown): Promise<BindingManifestPlanSummary> {
    requireCapability(context, 'console:access', this.now());
    const manifest = parseBindingManifest(rawManifest);
    const users = await this.users.listUsers();
    return this.planBindings(users, manifest);
  }
}

export function buildDefaultIdentityStatus(context: RequestContext): IdentityStatusSnapshot {
  const { principal } = context;
  return Object.freeze({
    identity: Object.freeze({
      projectId: principal.projectId,
      uid: principal.uid,
      email: principal.email,
      name: principal.name,
    }),
    bindings: Object.freeze([
      Object.freeze({ channel: 'web', status: 'linked', label: 'Firebase ログイン' }),
      Object.freeze({ channel: 'discord', status: 'unlinked', label: '未連携（明示連携 UI は未実装）' }),
      Object.freeze({ channel: 'line', status: 'unlinked', label: '未連携' }),
      Object.freeze({ channel: 'minecraft', status: 'unlinked', label: 'server/world ID 未配線' }),
      Object.freeze({ channel: 'radar', status: 'unlinked', label: 'Radar owner 文書未接続' }),
    ] satisfies ChannelBindingView[]),
    audience: Object.freeze({
      memoryChannels: Object.freeze(['discord_text', 'web']),
      radarPersonalFeed: false,
      lineDeliveryEnabled: false,
    }),
  });
}
