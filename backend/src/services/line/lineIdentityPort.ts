import type { mongo } from 'mongoose';
import type { IdentityProfileRecord } from '../../modules/identity/bindingWrite.js';
import { assertLinePersonalAccess } from '../../modules/identity/lineIdentityGate.js';
import { assertRadarPersonalFeedAccess } from '../../modules/identity/resolveBinding.js';
import { catalogShape } from '../../modules/radar/catalogVersion.js';
import { validFeedSubscription } from '../../modules/radar/sourceRegistry.js';
import { firebasePersonalRadarOwner } from '../radar/radarAccess.js';
import type { PersonalCatalog } from '../../modules/radar/catalog.js';
import type { LineFeedSetting } from './radarPolicy.js';

type RadarCatalogDocument = PersonalCatalog & { _id: string };

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
  readWebRadarSync(projectId: string, lineUserId: string, now?: number): Promise<LineWebRadarSync>;
}

export type LineWebRadarSync = Readonly<{
  state: 'legacy' | 'blocked' | 'linked';
  feeds: readonly LineFeedSetting[];
  topicIds: readonly string[];
  validUntil: number;
}>;

const emptySync = (state: 'legacy' | 'blocked', now: number): LineWebRadarSync => Object.freeze({
  state, feeds: Object.freeze([]), topicIds: Object.freeze([]), validUntil: now,
});

function bindingValidUntil(profile: IdentityProfileRecord, now: number): number {
  const raw = profile.bindings.line?.expiresAtIso;
  if (!raw) return Number.MAX_SAFE_INTEGER;
  const value = Date.parse(raw);
  return Number.isFinite(value) && value > now ? value : now;
}

function webRadarSync(profile: IdentityProfileRecord | null, catalog: PersonalCatalog | null, lineUserId: string, now: number): LineWebRadarSync {
  if (!profile) return emptySync('legacy', now);
  try {
    assertLinePersonalAccess(profile, lineUserId, now);
    assertRadarPersonalFeedAccess(profile, now);
  } catch {
    return emptySync('blocked', now);
  }
  const owner = firebasePersonalRadarOwner(profile.firebaseProjectId, profile.firebaseUid);
  const row = catalog ? catalogShape(catalog) : null;
  const sources = (row?.sources ?? []).flatMap(entry => {
    const source = entry.source;
    const audience = { kind: 'personal' as const, subjectId: owner };
    if (!source || !validFeedSubscription(source, audience, now)) return [];
    return [{ source, setting: Object.freeze({ id: source.id, kind: source.kind, locator: source.locator,
      articleHosts: Object.freeze([...source.articleHosts]), topicIds: Object.freeze([...source.topicIds]),
      maxItems: source.maxItems, retentionMs: source.retentionMs }) }];
  }).slice(0, 3);
  const feeds = Object.freeze(sources.map(entry => entry.setting));
  const topicIds = Object.freeze([...new Set(sources.flatMap(entry => entry.source.topicIds))].slice(0, 20));
  const validUntil = Math.min(bindingValidUntil(profile, now), ...sources.map(entry => entry.source.consentExpiresAt));
  return Object.freeze({ state: 'linked' as const, feeds, topicIds, validUntil });
}

export function createMongoLineIdentityPort(db: mongo.Db): LineIdentityPort {
  const findByLineUserId = async (projectId: string, lineUserId: string): Promise<IdentityProfileRecord | null> => {
    const doc = await db.collection('identityprofiles').findOne({
      firebaseProjectId: projectId,
      'bindings.line.externalId': lineUserId,
    });
    if (!doc) return null;
    return toRecord(doc as unknown as IdentityProfileRecord);
  };
  return {
    findByLineUserId,
    async readWebRadarSync(projectId, lineUserId, now = Date.now()) {
      const profile = await findByLineUserId(projectId, lineUserId);
      if (!profile) return emptySync('legacy', now);
      const owner = firebasePersonalRadarOwner(profile.firebaseProjectId, profile.firebaseUid);
      const doc = await db.collection<RadarCatalogDocument>('radarpersonalcatalogs').findOne({ _id: owner, owner },
        { maxTimeMS: 5000, readPreference: 'primary' });
      const catalog = doc ? (({ _id: _ignored, ...value }) => value)(doc) as unknown as PersonalCatalog : null;
      return webRadarSync(profile, catalog, lineUserId, now);
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

export async function authorizeLineRadarPersonal(
  port: LineIdentityPort | undefined,
  projectId: string | undefined,
  lineUserId: string,
  now = Date.now(),
): Promise<void> {
  if (!port || !projectId) return;
  const profile = await port.findByLineUserId(projectId, lineUserId);
  assertLinePersonalAccess(profile, lineUserId, now);
  assertRadarPersonalFeedAccess(profile, now);
}

export class InMemoryLineIdentityPort implements LineIdentityPort {
  private readonly store = new Map<string, IdentityProfileRecord>();
  private readonly catalogs = new Map<string, PersonalCatalog>();

  seed(profile: IdentityProfileRecord): void {
    const key = `${profile.firebaseProjectId}:${profile.bindings.line?.externalId ?? ''}`;
    this.store.set(key, profile);
  }

  seedRadarCatalog(profile: IdentityProfileRecord, catalog: PersonalCatalog): void {
    this.catalogs.set(firebasePersonalRadarOwner(profile.firebaseProjectId, profile.firebaseUid), catalog);
  }

  async findByLineUserId(projectId: string, lineUserId: string): Promise<IdentityProfileRecord | null> {
    return this.store.get(`${projectId}:${lineUserId}`) ?? null;
  }

  async readWebRadarSync(projectId: string, lineUserId: string, now = Date.now()): Promise<LineWebRadarSync> {
    const profile = await this.findByLineUserId(projectId, lineUserId);
    const catalog = profile ? this.catalogs.get(firebasePersonalRadarOwner(profile.firebaseProjectId, profile.firebaseUid)) ?? null : null;
    return webRadarSync(profile, catalog, lineUserId, now);
  }
}
