#!/usr/bin/env node
// Explicit maintenance of one reviewed original receipt; no network, actuator, scheduler or automatic discovery.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function reconcileReviewedOriginal(args, dependencies = {}) {
  const flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (flags.has(key) || !['--journal', '--review', '--stopped-operator-pid', '--apply-reviewed-original'].includes(key)) throw Error('LIFECYCLE_REVIEW_ARGUMENTS');
    if (key === '--apply-reviewed-original') flags.set(key, true);
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error('LIFECYCLE_REVIEW_ARGUMENTS'); flags.set(key, args[++i]); }
  }
  if (flags.size !== 4 || flags.get('--apply-reviewed-original') !== true) throw Error('LIFECYCLE_REVIEW_ARGUMENTS');
  const operatorPid = flags.get('--stopped-operator-pid');
  if (!/^[1-9][0-9]*$/.test(operatorPid) || !Number.isSafeInteger(Number(operatorPid))) throw Error('LIFECYCLE_REVIEW_ARGUMENTS');
  // The release operator must also ensure no replacement writer runs. Never stop a process here.
  try { (dependencies.processExists ?? (pid => process.kill(pid, 0)))(Number(operatorPid)); throw Error('LIFECYCLE_OPERATOR_NOT_STOPPED'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  const reviewFile = path.resolve(flags.get('--review')), journalFile = path.resolve(flags.get('--journal'));
  if (!fs.existsSync(journalFile) || reviewFile === journalFile || fs.statSync(reviewFile).size > 65536) throw Error('LIFECYCLE_REVIEW_FILE');
  const reviewed = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  if (!reviewed || Object.keys(reviewed).sort().join(',') !== 'expectedUnknown,receipt,review') throw Error('LIFECYCLE_REVIEW_FILE');
  const Journal = dependencies.Journal ?? (await import('../backend/dist/services/integration/minecraftLifecycleOperator.js')).LifecycleOperationJournal;
  const journal = new Journal(journalFile);
  journal.reconcileOriginalReceipt(reviewed.expectedUnknown, reviewed.receipt, reviewed.review);
  return { id: reviewed.receipt.id, receiptRevised: true, actuatorInvoked: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await reconcileReviewedOriginal(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
