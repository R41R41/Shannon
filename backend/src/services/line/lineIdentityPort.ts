import type { mongo } from 'mongoose';
import type { IdentityProfileRecord } from '../../modules/identity/bindingWrite.js';
import { assertLinePersonalAccess } from '../../modules/identity/lineIdentityGate.js';

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

export interface LineIdentityPort {
  findByLineUserId(projectId: string, lineUserId: string): Promise<IdentityProfileRecord | null>;
}

export function createMongoLineIdentityPort(db: mongo.Db): LineIdentityPort {
  return {
    async findByLineUserId(projectId, lineUserId) {
      const doc = await db.collection('identityprofiles').findOne({
        firebaseProjectId: projectId,
        'bindings.line.externalId': lineUserId,
      });
      if (!doc) return null;
      return toRecord(doc as unknown as IdentityProfileRecord);
    },
  };
}

export async function authorizeLinePersonal(
  port: LineIdentityPort | undefined,
  projectId: string | undefined,
  lineUserId: string,
  now = Date.now(),
): Promise<void> {
  if (!port || !projectId) return;
  const profile = await port.findByLineUserId(projectId, lineUserId);
  assertLinePersonalAccess(profile, lineUserId, now);
}

export class InMemoryLineIdentityPort implements LineIdentityPort {
  private readonly store = new Map<string, IdentityProfileRecord>();

  seed(profile: IdentityProfileRecord): void {
    const key = `${profile.firebaseProjectId}:${profile.bindings.line?.externalId ?? ''}`;
    this.store.set(key, profile);
  }

  async findByLineUserId(projectId: string, lineUserId: string): Promise<IdentityProfileRecord | null> {
    return this.store.get(`${projectId}:${lineUserId}`) ?? null;
  }
}
