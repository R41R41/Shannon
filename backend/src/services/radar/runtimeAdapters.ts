import { randomUUID } from 'node:crypto';
import type { mongo } from 'mongoose';
import { AccessError, type AccessUserRepository, type IdentityVerifier } from '../../modules/access/index.js';
import { CATALOG_VALIDATOR } from '../../modules/radar/catalogVersion.js';

/** No global Mongoose model, index creation, auto-enrolment or role escalation. */
export class RadarMongoUsers implements AccessUserRepository {
  constructor(private readonly db: mongo.Db) {}
  async findByIdentity(projectId: string, uid: string) {
    const rows = await this.db.collection('users').find({ firebaseProjectId: projectId, firebaseUid: uid }, {
      projection: { _id: 0, firebaseProjectId: 1, firebaseUid: 1, name: 1, email: 1, isAuthorized: 1 },
      maxTimeMS: 5000, readPreference: 'primary',
    }).limit(2).toArray();
    if (rows.length !== 1 || typeof rows[0].name !== 'string' || typeof rows[0].email !== 'string') return null;
    return { projectId: rows[0].firebaseProjectId, uid: rows[0].firebaseUid, name: rows[0].name,
      email: rows[0].email, isAuthorized: rows[0].isAuthorized === true, isAdmin: false };
  }
}
export async function radarDatabaseReady(db: mongo.Db) {
  await db.command({ ping: 1 }, { maxTimeMS: 5000 });
  const rows = await db.listCollections({ name: 'radarpersonalcatalogs' }, { nameOnly: false }).toArray();
  const options = rows[0]?.options;
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  if (rows.length !== 1 || options?.validationLevel !== 'strict' || options?.validationAction !== 'error'
    || canonical(options.validator) !== canonical(CATALOG_VALIDATOR)) throw new Error('RADAR_CATALOG_FENCE_REQUIRED');
}
/** Explicit credentials and a uniquely owned SDK app: never ADC, getApps reuse or emulator auth. */
export async function openRadarFirebase(projectId: string, credential: unknown): Promise<{ identity: IdentityVerifier; close(): Promise<void> }> {
  const c = credential as { type?: string; project_id?: string; client_email?: string; private_key?: string } | null;
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST || !c || c.type !== 'service_account' || c.project_id !== projectId
    || typeof c.client_email !== 'string' || !c.client_email.endsWith(`@${projectId}.iam.gserviceaccount.com`)
    || typeof c.private_key !== 'string' || !c.private_key.startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error('RADAR_FIREBASE_CREDENTIAL');
  const { initializeApp, cert, deleteApp } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const app = initializeApp({ projectId, credential: cert({ projectId, clientEmail: c.client_email, privateKey: c.private_key }) }, `radar-${randomUUID()}`);
  try {
    const auth = getAuth(app);
    return { close: () => deleteApp(app), identity: { verify: async token => {
      try {
        if (process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new AccessError('AUTH_UNAVAILABLE');
        const v = await auth.verifyIdToken(token, true);
        if (v.aud !== projectId || v.iss !== `https://securetoken.google.com/${projectId}` || v.firebase?.tenant) throw new AccessError('UNAUTHENTICATED');
        return { projectId, uid: v.uid, email: v.email ?? '', emailVerified: v.email_verified === true, expiresAtMs: v.exp * 1000 };
      } catch (e) {
        if (e instanceof AccessError) throw e;
        const code = (e as { code?: string })?.code;
        throw new AccessError(['auth/argument-error','auth/invalid-id-token','auth/id-token-expired','auth/id-token-revoked','auth/user-disabled','auth/user-not-found'].includes(code ?? '') ? 'UNAUTHENTICATED' : 'AUTH_UNAVAILABLE');
      }
    } } };
  } catch { await deleteApp(app); throw new Error('RADAR_FIREBASE_INIT'); }
}
