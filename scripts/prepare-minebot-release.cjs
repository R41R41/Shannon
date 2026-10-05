'use strict';
// Prepare only. Never restart a service, mutate production sources, or read
// credential contents. The parent is the actual running release, not prod HEAD.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const development = '/home/azureuser/Shannon-dev';
const current = '/home/azureuser/Shannon-current';
const releases = '/home/azureuser/Shannon-releases';
const git = (...args) => execFileSync('git', ['-C', development, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
if (fs.realpathSync(path.join(__dirname, '..')) !== development) throw new Error('DEV_PREPARATION_ONLY');
const parent = fs.realpathSync(current);
if (!parent.startsWith(`${releases}/`)) throw new Error('UNEXPECTED_PRODUCTION_RELEASE');
const parentManifest = JSON.parse(fs.readFileSync(path.join(parent, 'release-manifest.json')));
const sourceCommit = git('rev-parse', 'HEAD').toString().trim();
if (parentManifest.sourceCommit !== sourceCommit) throw new Error('PARENT_SOURCE_BASE_CHANGED_REVIEW_REQUIRED');
const sourcePaths = git('ls-files', '--modified', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean);
const allowed = file => file.startsWith('backend/src/services/minebot/')
  || /^backend\/src\/services\/llm\/graph\/(ShannonExecutor.ts|shannonGraph.ts|types.ts|cognitive\/selfImprove\/(SelfTestRunner.ts|types.ts))$/.test(file)
  || /^backend\/tests\/unit\/(minecraft[^/]+.test.ts|config\/env.test.ts|graphCancellation.test.ts|fcaSessionIsolation.test.ts|taskTreePublisher.test.ts)$/.test(file)
  || /^backend\/scripts\/(minecraft-[^/]+|benchmark-minecraft-cognition|jev-credential-probe|summarize-minecraft-[^/]+|verify-minecraft-execution-source-archives)\.(ts|mjs|cjs)$/.test(file)
  || /^backend\/saves\/minecraft\/self_test_cases\/(practical-[^/]+|command-oracle-smoke)\.json$/.test(file)
  || ['backend/src/config/env.ts', 'backend/package.json', 'backend/tsconfig.minecraft-execution.json', '.gitignore',
    'docs/README.md', 'docs/architecture-current.md', 'docs/test-cases.md', 'scripts/prepare-minebot-release.cjs',
    'scripts/promote-minebot-release.cjs', 'deploy/minebot-adaptive.conf'].includes(file)
  || /^docs\/minecraft-[^/]+\.md$/.test(file);
const unrelated = sourcePaths.filter(file => !allowed(file));
if (unrelated.length) throw new Error(`UNREVIEWED_DEV_CHANGES:${unrelated.join(',')}`);
const hashes = {};
for (const file of sourcePaths) {
  const from = path.join(development, file);
  if (!fs.statSync(from).isFile()) throw new Error(`REGULAR_SOURCE_REQUIRED:${file}`);
  let baseline;
  try { baseline = git('show', `${sourceCommit}:${file}`); } catch { /* new source */ }
  const existing = path.join(parent, file);
  // Runtime saves live outside releases and are checked separately, never replaced here.
  if (!file.startsWith('backend/saves/') && baseline && (!fs.existsSync(existing) || hash(existing) !== digest(baseline))) {
    throw new Error(`PRODUCTION_SOURCE_DIVERGENCE:${file}`);
  }
  if (!file.startsWith('backend/saves/') && !baseline && fs.existsSync(existing)) throw new Error(`NEW_SOURCE_COLLISION:${file}`);
  hashes[file] = hash(from);
}
const refresh = process.argv[2] === '--refresh' ? process.argv[3] : undefined;
if (process.argv.length > 2 && (!refresh || process.argv.length !== 4)) throw new Error('INVALID_PREPARATION_ARGUMENTS');
if (refresh && (!refresh.startsWith(`${releases}/minebot-adaptive-`) || path.dirname(refresh) !== releases
  || fs.realpathSync(refresh) === parent || JSON.parse(fs.readFileSync(path.join(refresh, 'minebot-release-manifest.json'))).parentRelease !== parent)) throw new Error('INACTIVE_CANDIDATE_REQUIRED');
const release = refresh ?? fs.mkdtempSync(path.join(releases, 'minebot-adaptive-'));
execFileSync('rsync', ['-a', '--exclude=.git', '--exclude=node_modules', '--exclude=backend/.env',
  '--exclude=backend/saves', '--exclude=backend/dist', '--exclude=frontend/.env*', '--exclude=.dev-runtime-lock', '--exclude=.shannon-development',
  `${parent}/`, `${release}/`]);
for (const file of sourcePaths.filter(file => !file.startsWith('backend/saves/'))) {
  const target = path.join(release, file); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(development, file), target);
  if (hash(target) !== hashes[file]) throw new Error(`COPY_HASH_MISMATCH:${file}`);
}
const link = (target, name) => {
  if (fs.existsSync(name)) { if (!fs.lstatSync(name).isSymbolicLink() || fs.realpathSync(name) !== fs.realpathSync(target)) throw new Error(`LINK_COLLISION:${name}`); }
  else fs.symlinkSync(target, name);
};
link('/home/azureuser/Shannon-prod/node_modules', path.join(release, 'node_modules'));
for (const workspace of ['backend', 'frontend', 'common']) {
  const dependencies = path.join(parent, workspace, 'node_modules');
  if (fs.existsSync(dependencies)) link(dependencies, path.join(release, workspace, 'node_modules'));
}
link(path.join(parent, 'backend/.env'), path.join(release, 'backend/.env'));
for (const name of ['.env', '.env.production', '.env.local', '.env.production.local']) {
  const existing = path.join(parent, 'frontend', name);
  if (fs.existsSync(existing)) link(existing, path.join(release, 'frontend', name));
}
link('/home/azureuser/Shannon-runtime/backend-saves', path.join(release, 'backend/saves'));
// Never overwrite runtime fixtures. Keep reviewed cases in a separate package;
// install them explicitly after backing up the runtime directory at cutover.
for (const file of sourcePaths.filter(file => file.startsWith('backend/saves/'))) {
  const target = path.join(release, 'minebot-reviewed-fixtures', path.basename(file));
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(development, file), target);
}
const manifest = { version: 1, purpose: 'minebot-adaptive-architecture', sourceCommit, parentRelease: parent,
  createdAt: new Date().toISOString(), sourceHashes: hashes, sourceFingerprint: digest(Buffer.from(JSON.stringify(hashes))),
  productionData: '/home/azureuser/Shannon-runtime/backend-saves', promotion: 'prepared-not-active' };
if (refresh) fs.copyFileSync(path.join(release, 'minebot-release-manifest.json'), path.join(release, `minebot-release-manifest-before-${Date.now()}.json`));
fs.writeFileSync(path.join(release, 'minebot-release-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ release, parent, files: sourcePaths.length, sourceFingerprint: manifest.sourceFingerprint }));
