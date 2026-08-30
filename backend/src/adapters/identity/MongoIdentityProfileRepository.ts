import type { RequestContext } from '../../modules/access/index.js';
import {
  buildIdentityStatus,
  type IdentityProfileRecord,
  type IdentityProfileRepository,
  type IdentityStatusRepository,
} from '../../modules/identity/index.js';
import { IdentityProfile } from '../../models/IdentityProfile.js';

function toRecord(doc: {
  firebaseProjectId: string;
  firebaseUid: string;
  bindings: IdentityProfileRecord['bindings'];
  audience: IdentityProfileRecord['audience'];
  revision: number;
}): IdentityProfileRecord {
  return Object.freeze({
    firebaseProjectId: doc.firebaseProjectId,
    firebaseUid: doc.firebaseUid,
    bindings: Object.freeze({ ...doc.bindings }),
    audience: Object.freeze({
      memoryChannels: Object.freeze([...doc.audience.memoryChannels]),
      lineDeliveryEnabled: doc.audience.lineDeliveryEnabled,
      radarPersonalFeed: doc.audience.radarPersonalFeed,
    }),
    revision: doc.revision,
  });
}

export class MongoIdentityProfileRepository implements IdentityProfileRepository {
  async find(context: RequestContext): Promise<IdentityProfileRecord | null> {
    const doc = await IdentityProfile.findOne({
      firebaseProjectId: context.principal.projectId,
      firebaseUid: context.principal.uid,
    }).lean().exec();
    if (!doc) return null;
    return toRecord(doc as IdentityProfileRecord);
  }

  async findByDiscordUserId(projectId: string, discordUserId: string): Promise<IdentityProfileRecord | null> {
    const doc = await IdentityProfile.findOne({
      firebaseProjectId: projectId,
      'bindings.discord.externalId': discordUserId,
    }).lean().exec();
    if (!doc) return null;
    return toRecord(doc as IdentityProfileRecord);
  }

  async findByFirebaseUid(projectId: string, firebaseUid: string): Promise<IdentityProfileRecord | null> {
    const doc = await IdentityProfile.findOne({ firebaseProjectId: projectId, firebaseUid }).lean().exec();
    if (!doc) return null;
    return toRecord(doc as IdentityProfileRecord);
  }

  async findByLineUserId(projectId: string, lineUserId: string): Promise<IdentityProfileRecord | null> {
    const doc = await IdentityProfile.findOne({
      firebaseProjectId: projectId,
      'bindings.line.externalId': lineUserId,
    }).lean().exec();
    if (!doc) return null;
    return toRecord(doc as IdentityProfileRecord);
  }

  async save(context: RequestContext, profile: IdentityProfileRecord): Promise<IdentityProfileRecord> {
    if (profile.firebaseProjectId !== context.principal.projectId || profile.firebaseUid !== context.principal.uid) {
      throw new Error('IDENTITY_SCOPE_MISMATCH');
    }
    const existing = await IdentityProfile.findOne({
      firebaseProjectId: context.principal.projectId,
      firebaseUid: context.principal.uid,
    }).lean().exec();
    if (existing && existing.revision !== profile.revision - 1) {
      throw new Error('IDENTITY_REVISION_CONFLICT');
    }
    const doc = await IdentityProfile.findOneAndUpdate(
      { firebaseProjectId: context.principal.projectId, firebaseUid: context.principal.uid },
      {
        $set: {
          bindings: profile.bindings,
          audience: profile.audience,
          revision: profile.revision,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          firebaseProjectId: context.principal.projectId,
          firebaseUid: context.principal.uid,
        },
      },
      { upsert: true, new: true },
    ).lean().exec();
    if (!doc) throw new Error('IDENTITY_PROFILE_SAVE_FAILED');
    return toRecord(doc as IdentityProfileRecord);
  }
}

export class ProfileIdentityStatusRepository implements IdentityStatusRepository {
  constructor(
    private readonly profiles: IdentityProfileRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async snapshotFor(context: RequestContext) {
    const profile = await this.profiles.find(context);
    return buildIdentityStatus(context, profile, this.now());
  }
}

export class InMemoryIdentityProfileRepository implements IdentityProfileRepository {
  private readonly store = new Map<string, IdentityProfileRecord>();

  private key(context: RequestContext): string {
    return `${context.principal.projectId}:${context.principal.uid}`;
  }

  async find(context: RequestContext): Promise<IdentityProfileRecord | null> {
    return this.store.get(this.key(context)) ?? null;
  }

  async findByDiscordUserId(projectId: string, discordUserId: string): Promise<IdentityProfileRecord | null> {
    for (const profile of this.store.values()) {
      if (profile.firebaseProjectId === projectId && profile.bindings.discord?.externalId === discordUserId) return profile;
    }
    return null;
  }

  async findByFirebaseUid(projectId: string, firebaseUid: string): Promise<IdentityProfileRecord | null> {
    return this.store.get(`${projectId}:${firebaseUid}`) ?? null;
  }

  async findByLineUserId(projectId: string, lineUserId: string): Promise<IdentityProfileRecord | null> {
    for (const profile of this.store.values()) {
      if (profile.firebaseProjectId === projectId && profile.bindings.line?.externalId === lineUserId) return profile;
    }
    return null;
  }

  async save(context: RequestContext, profile: IdentityProfileRecord): Promise<IdentityProfileRecord> {
    this.store.set(this.key(context), profile);
    return profile;
  }
}
