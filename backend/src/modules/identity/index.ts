import { requireCapability, type RequestContext } from '../access/index.js';
import {
  buildIdentityStatus,
  emptyProfile,
  mergeProfileAfterAudience,
  mergeProfileAfterLink,
  mergeProfileAfterUnlink,
  parseAudienceUpdateInput,
  parseLinkBindingInput,
  parseWritableChannel,
  requireExplicitConfirm,
  storedBindingForLink,
  type IdentityProfileRecord,
  type IdentityProfileRepository,
  IdentityInputError,
  type WritableChannelKind,
} from './bindingWrite.js';
import type {
  BindingManifestPlanSummary,
  BindingManifestV1,
  IdentityStatusSnapshot,
  MigrationUserRecord,
  BindingManifestPlanner,
} from './types.js';

export type {
  IdentityChannelKind,
  BindingStatus,
  ChannelBindingView,
  AudiencePolicyView,
  IdentityStatusSnapshot,
  BindingManifestV1,
  BindingManifestPlanSummary,
  MigrationUserRecord,
  BindingManifestPlanner,
} from './types.js';
export type {
  WritableChannelKind,
  StoredChannelBinding,
  IdentityProfileRecord,
  LinkBindingInput,
  UnlinkBindingInput,
  AudienceUpdateInput,
  AllowedMemoryChannel,
} from './bindingWrite.js';
export {
  ALLOWED_MEMORY_CHANNELS,
  defaultAudience,
  buildIdentityStatus,
  parseLinkBindingInput,
  parseAudienceUpdateInput,
  parseWritableChannel,
} from './bindingWrite.js';
export { IdentityInputError };

export interface IdentityStatusRepository {
  snapshotFor(context: RequestContext): Promise<IdentityStatusSnapshot> | IdentityStatusSnapshot;
}

export interface IdentityMigrationUserRepository {
  listUsers(): Promise<readonly MigrationUserRecord[]>;
}

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

export class IdentityStatusService {
  constructor(
    private readonly repository: IdentityStatusRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async read(context: RequestContext | null): Promise<IdentityStatusSnapshot> {
    requireCapability(context, 'profile:read', this.now());
    const snapshot = this.repository.snapshotFor(context);
    return snapshot instanceof Promise ? await snapshot : snapshot;
  }
}

export class IdentityBindingWriteService {
  constructor(
    private readonly profiles: IdentityProfileRepository,
    private readonly now: () => number = Date.now,
  ) {}

  private async load(context: RequestContext): Promise<IdentityProfileRecord> {
    return (await this.profiles.find(context)) ?? emptyProfile(context);
  }

  async link(context: RequestContext | null, channelRaw: unknown, body: unknown): Promise<IdentityStatusSnapshot> {
    requireCapability(context, 'profile:read', this.now());
    const channel = parseWritableChannel(channelRaw);
    const input = parseLinkBindingInput(channel, body);
    const profile = await this.load(context);
    const binding = storedBindingForLink(channel, input, context, new Date(this.now()).toISOString());
    const saved = await this.profiles.save(context, mergeProfileAfterLink(profile, channel, binding));
    return buildIdentityStatus(context, saved, this.now());
  }

  async unlink(context: RequestContext | null, channelRaw: unknown, body: unknown): Promise<IdentityStatusSnapshot> {
    requireCapability(context, 'profile:read', this.now());
    const channel = parseWritableChannel(channelRaw);
    requireExplicitConfirm(body);
    const profile = await this.load(context);
    const saved = await this.profiles.save(context, mergeProfileAfterUnlink(profile, channel));
    return buildIdentityStatus(context, saved, this.now());
  }

  async updateAudience(context: RequestContext | null, body: unknown): Promise<IdentityStatusSnapshot> {
    requireCapability(context, 'profile:read', this.now());
    const audience = parseAudienceUpdateInput(body);
    const profile = await this.load(context);
    const saved = await this.profiles.save(context, mergeProfileAfterAudience(profile, audience));
    return buildIdentityStatus(context, saved, this.now());
  }
}

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

/** @deprecated use buildIdentityStatus via repository */
export function buildDefaultIdentityStatus(context: RequestContext): IdentityStatusSnapshot {
  return buildIdentityStatus(context, null, Date.now());
}
