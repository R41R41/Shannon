#!/usr/bin/env node
// Read-only verification: hash preserved sources, never the current working tree.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const manifest = path.resolve(process.argv[2] ?? 'saves/minecraft/progressive_reports/execution-source-archives.json');
const entries = JSON.parse(fs.readFileSync(manifest, 'utf8'));
const results = entries.map(entry => {
  if (entry.fingerprintVersion !== 2 || !/^[\w-]+\.tar\.gz$/.test(entry.archive)) {
    throw new Error('Unsupported archive manifest entry');
  }
  const archive = path.join(path.dirname(manifest), entry.archive);
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  const bytes = name => execFileSync('tar', ['-xOf', archive, name]);
  const hash = createHash('sha256');
  for (const directory of ['instantSkills', 'constantSkills', 'combat', 'utils', 'testing', 'execution', 'types', 'cognition']) {
    const prefix = `backend/src/services/minebot/${directory}/`;
    const files = names.filter(name => name.startsWith(prefix)
      && /^[^/]+\.ts$/.test(name.slice(prefix.length))).sort();
    if (!files.length) throw new Error(`Missing selected source directory: ${directory}`);
    for (const file of files) hash.update(`${directory}/${path.basename(file)}\0`).update(bytes(file));
  }
  const focusedActual = entry.focusedSourceFingerprint
    ? hash.copy().update(bytes('backend/scripts/minecraft-execution-live-probe.ts')).digest('hex') : null;
  hash.update(bytes('backend/scripts/minecraft-progressive-live-probe.ts'));
  for (const file of ['src/services/llm/graph/ShannonExecutor.ts', 'src/services/llm/graph/shannonGraph.ts', 'src/config/env.ts']) {
    hash.update(`${file}\0`).update(bytes(`backend/${file}`));
  }
  const actual = hash.digest('hex');
  return { archive: entry.archive, expected: entry.sourceFingerprint, actual,
    focusedExpected: entry.focusedSourceFingerprint ?? null, focusedActual,
    matches: actual === entry.sourceFingerprint && (!entry.focusedSourceFingerprint || focusedActual === entry.focusedSourceFingerprint) };
});
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
process.exitCode = results.every(result => result.matches) ? 0 : 1;
