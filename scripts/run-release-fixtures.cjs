'use strict';
/** Fast isolated fixture runner for D1 (Radar) and D2 (LINE) testable state. Does not start long-lived HTTP servers. */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
function run(label, cmd, args, extra = {}) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...extra });
  if (result.status !== 0) throw new Error(`${label}_FAILED`);
  console.log(`${label}_OK`);
}

function main() {
  if (root !== '/home/azureuser/Shannon-dev' || !fs.existsSync(path.join(root, '.dev-runtime-lock'))) {
    throw new Error('DEV_CHECKOUT_REQUIRED');
  }
  // TypeScript does not delete outputs for source files that were moved or removed. A stale tool can
  // shadow the current implementation at runtime, so every release fixture starts from an empty dist.
  fs.rmSync(path.join(root, 'backend/dist'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'common/dist'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'common/tsconfig.tsbuildinfo'), { force: true });
  run('BACKEND_BUILD', 'bash', ['-lc', 'npm run build -w common && cd backend && NODE_OPTIONS="--max-old-space-size=12288" npx tsc --noCheck --skipLibCheck']);
  run('BACKEND_DIST_RUNTIME', process.execPath, [path.join(__dirname, 'probe-backend-dist-runtime.cjs')]);
  run('LINE_BUNDLE_BUILD', process.execPath, [path.join(__dirname, 'build-line-service.cjs')]);
  run('RADAR_CATALOG_FIXTURE', process.execPath, [path.join(__dirname, 'probe-radar-catalog-mongo.cjs'), '--isolated-fixture']);
  run('LINE_MONGO_FIXTURE', process.execPath, [path.join(__dirname, 'test-line-mongo.cjs'), '--isolated-fixture']);
  run('BACKEND_STRICT', 'npm', ['run', 'check:backend-strict', '-w', 'backend']);
  run('BACKEND_OFFLINE_TESTS', 'npm', ['run', 'test:offline', '-w', 'backend']);
  console.log(JSON.stringify({
    fixtures: ['probe-backend-dist-runtime', 'probe-radar-catalog-mongo', 'test-line-mongo', 'build-line-service'],
    note: 'For full Radar HTTP runtime use: npm run test:radar-runtime-fixture -w backend',
  }));
}

try { main(); } catch (error) {
  console.error(error.message ?? 'RELEASE_FIXTURES_FAILED');
  process.exitCode = 1;
}
