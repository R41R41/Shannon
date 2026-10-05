#!/usr/bin/env node
// One-off repair of the learned-knowledge store: undo the generalising merges
// and bring the specific lessons back (see restoreMergedLessons). Keeps a
// timestamped backup beside the store and takes the same lock as the runs.
import fs from 'node:fs';
import path from 'node:path';
import { restoreMergedLessons, type KnowledgeStoreState } from '../src/modules/minecraftLearning/index.js';
import { acquireExclusiveFileLock, writeFileAtomically } from '../src/services/minebot/utils/exclusiveFileLock.js';

const directory = path.resolve(process.env.MINECRAFT_LEARNING_DIRECTORY ?? 'saves/minecraft/learning/dev-isolated-lab');
if (!directory.includes(`${path.sep}saves${path.sep}minecraft${path.sep}learning${path.sep}`)) throw new Error('KNOWLEDGE_UNMERGE_DIRECTORY_INVALID');
const file = path.join(directory, 'knowledge.json');
const dryRun = process.env.MINECRAFT_KNOWLEDGE_UNMERGE_APPLY !== 'true';
const lock = acquireExclusiveFileLock(`${file}.lock`);
try {
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as KnowledgeStoreState;
  const before = state.items.filter(item => !item.retired).length;
  const result = restoreMergedLessons(state, new Date().toISOString());
  const after = state.items.filter(item => !item.retired).length;
  console.log(JSON.stringify({ dryRun, items: state.items.length, activeBefore: before, activeAfter: after,
    restored: result.restored.length, retiredProducts: result.retiredProducts.length, overLimit: result.overLimit.length }));
  if (!dryRun) {
    const backup = path.join(directory, `knowledge.before-unmerge-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.copyFileSync(file, backup);
    writeFileAtomically(file, JSON.stringify(state, null, 1));
    console.log(`KNOWLEDGE_UNMERGE_BACKUP ${backup}`);
  }
} finally { fs.closeSync(lock); fs.unlinkSync(`${file}.lock`); }
