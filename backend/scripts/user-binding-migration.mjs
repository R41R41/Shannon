import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const fields = ['firebaseProjectId', 'firebaseUid', 'isAuthorized', 'isAdmin'];
const stableHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = x => typeof x === 'string' && x.length > 0 && x.length <= 128 && !/\s/.test(x);
export function planBindings(users, manifest) {
  if (!manifest || manifest.version !== 1 || !validId(manifest.projectId) || !validId(manifest.reviewedBy) || !Array.isArray(manifest.bindings)) throw new Error('INVALID_MANIFEST');
  const seenIds = new Set(), seenUids = new Set(), operations = [];
  for (const binding of manifest.bindings) {
    if (!validId(binding.userId) || !validId(binding.uid) || typeof binding.isAuthorized !== 'boolean' || typeof binding.isAdmin !== 'boolean' || (binding.isAdmin && !binding.isAuthorized)) throw new Error('INVALID_BINDING');
    if (seenIds.has(binding.userId) || seenUids.has(binding.uid)) throw new Error('DUPLICATE_BINDING');
    seenIds.add(binding.userId); seenUids.add(binding.uid);
    const user = users.find(u => String(u._id) === binding.userId);
    if (!user || !user.email || typeof user.email !== 'string') throw new Error('USER_NOT_FOUND');
    if ((user.firebaseUid && user.firebaseUid !== binding.uid) || (user.firebaseProjectId && user.firebaseProjectId !== manifest.projectId)) throw new Error('REBIND_REQUIRES_SEPARATE_REVIEW');
    const before = Object.fromEntries(fields.map(k => [k, Object.hasOwn(user,k) ? user[k] : null]));
    const after = { firebaseProjectId: manifest.projectId, firebaseUid: binding.uid, isAuthorized: binding.isAuthorized, isAdmin: binding.isAdmin };
    operations.push({ userId: String(user._id), email: user.email, before, after });
  }
  const resulting = users.map(u => ({...u, ...(operations.find(o=>o.userId===String(u._id))?.after ?? {})}));
  const seen = new Set();
  for (const user of resulting) {
    if (user.firebaseProjectId !== undefined && user.firebaseProjectId !== null && !validId(user.firebaseProjectId)) throw new Error('INVALID_EXISTING_PROJECT');
    if (user.firebaseUid !== undefined && user.firebaseUid !== null && !validId(user.firebaseUid)) throw new Error('INVALID_EXISTING_UID');
    if (!!user.firebaseProjectId !== !!user.firebaseUid) throw new Error('PARTIAL_EXISTING_BINDING');
    if (user.firebaseProjectId && user.firebaseUid) {
      const key=JSON.stringify([user.firebaseProjectId,user.firebaseUid]); if(seen.has(key))throw new Error('DUPLICATE_EXISTING_IDENTITY'); seen.add(key);
    }
  }
  const plan = { version:1, projectId:manifest.projectId, reviewedBy:manifest.reviewedBy, operations,
    unboundAfter:resulting.filter(u=>!u.firebaseUid || !u.firebaseProjectId).length };
  return {...plan,sha256:stableHash(plan)};
}

export async function verifyIdentities(plan, getUser) {
  // Verify all identities before performing ANY database writes.
  for (const op of plan.operations) {
    const identity = await getUser(op.after.firebaseUid);
    if (identity.uid !== op.after.firebaseUid || identity.email !== op.email || !identity.emailVerified || identity.disabled) throw new Error('FIREBASE_IDENTITY_MISMATCH');
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 && args.length !== 4) throw new Error('Usage: user-binding-migration.mjs MANIFEST OUTPUT [--apply EXPECTED_PLAN_SHA256]');
  const [manifestFile,output,mode,expectedHash]=args;
  if (mode && mode !== '--apply') throw new Error('INVALID_MODE');
  const root = resolve(import.meta.dirname, '..');
  if (!realpathSync(root).endsWith('/Shannon-dev/backend')) throw new Error('DEV_CHECKOUT_REQUIRED');
  const dotenv=await import('dotenv'); const env=dotenv.parse(readFileSync(resolve(root,'.env')));
  const mongoose=(await import('mongoose')).default;
  const client=new mongoose.mongo.MongoClient(env.MONGODB_URI,{serverSelectionTimeoutMS:5000});
  try {
    await client.connect(); const db=client.db(); if(db.databaseName !== 'shannon_dev')throw new Error('DEV_DATABASE_REQUIRED');
    const users=await db.collection('users').find({}).sort({_id:1}).toArray();
    const manifest=JSON.parse(readFileSync(manifestFile,'utf8')); const plan=planBindings(users,manifest);
    // Plans contain account identifiers: store outside Git, mode 0600, never print the records.
    writeFileSync(output,JSON.stringify(plan,null,2),{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({mode:mode?'apply':'dry-run',count:plan.operations.length,unboundAfter:plan.unboundAfter,sha256:plan.sha256}));
    if (!mode) return;
    if (plan.sha256 !== expectedHash || plan.projectId !== env.FIREBASE_PROJECT_ID || process.env.FIREBASE_AUTH_EMULATOR_HOST)throw new Error('REVIEW_OR_PROJECT_MISMATCH');
    const {initializeApp,applicationDefault}=await import('firebase-admin/app'); const {getAuth}=await import('firebase-admin/auth');
    // Credentials are supplied by the operator; never infer them from frontend configuration.
    if (env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.GOOGLE_APPLICATION_CREDENTIALS) process.env.GOOGLE_APPLICATION_CREDENTIALS=env.GOOGLE_APPLICATION_CREDENTIALS;
    const app=initializeApp({projectId:plan.projectId,credential:applicationDefault()},'shannon-dev-user-migration');
    await verifyIdentities(plan,uid=>getAuth(app).getUser(uid));
    // Add the unique constraint before writes so concurrency cannot create duplicate identities.
    await db.collection('users').createIndex({firebaseProjectId:1,firebaseUid:1},{name:'firebase_identity_unique',unique:true,
      partialFilterExpression:{firebaseProjectId:{$type:'string'},firebaseUid:{$type:'string'}}});
    for (const op of plan.operations) {
      const filter={_id:new mongoose.mongo.ObjectId(op.userId),email:op.email,...op.before};
      const result=await db.collection('users').updateOne(filter,{$set:op.after});
      if(result.matchedCount !== 1)throw new Error('CONCURRENT_CHANGE_STOPPED_REMAINING_OPERATIONS');
    }
    console.log('Applied reviewed development bindings; verify login before any production migration.');
  } finally { await client.close(); }
}
if(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message?.match(/^[A-Z_]+$/)?.[0] ?? 'MIGRATION_FAILED');process.exitCode=1});
