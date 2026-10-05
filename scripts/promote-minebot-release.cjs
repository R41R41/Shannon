'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const node = '/home/azureuser/.nvm/versions/node/v22.21.1/bin/node';
const current = '/home/azureuser/Shannon-current';
const releases = '/home/azureuser/Shannon-releases';
const service = 'shannon.service';
const dropin = '/etc/systemd/system/shannon.service.d/minebot-adaptive.conf';
const candidate = process.argv[2];
const promote = process.argv[3] === '--promote';
if (!candidate || path.dirname(candidate) !== releases || !path.basename(candidate).startsWith('minebot-adaptive-')
  || process.argv.length !== (promote ? 4 : 3)) throw new Error('EXACT_MINEBOT_CANDIDATE_REQUIRED');
const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'minebot-release-manifest.json')));
if (fs.realpathSync(current) !== manifest.parentRelease) throw new Error('CURRENT_RELEASE_CHANGED');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const checks = path.join(candidate, 'release-checks'); fs.mkdirSync(checks, { recursive: true });
function verifySources() {
  for (const [file, expected] of Object.entries(manifest.sourceHashes)) {
    const packaged = file.startsWith('backend/saves/') ? path.join(candidate, 'minebot-reviewed-fixtures', path.basename(file)) : path.join(candidate, file);
    if (hash(packaged) !== expected) throw new Error(`SOURCE_HASH_MISMATCH:${file}`);
  }
  if (fs.realpathSync(path.join(candidate, 'backend/saves')) !== '/home/azureuser/Shannon-runtime/backend-saves') throw new Error('RUNTIME_DATA_CHANGED');
  for (const file of fs.readdirSync(path.join(candidate, 'minebot-reviewed-fixtures'))) {
    const existing = path.join(candidate, 'backend/saves/minecraft/self_test_cases', file);
    if (fs.existsSync(existing) && hash(existing) !== hash(path.join(candidate, 'minebot-reviewed-fixtures', file))) throw new Error(`RUNTIME_FIXTURE_CONFLICT:${file}`);
  }
}
verifySources();
const validation = path.join(checks, 'promotion-validation.json');
if (!promote) {
  const unitResult = spawnSync(node, [path.join(candidate, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/unit',
    'tests/selfImprove/nightlySchedule.test.ts', '--maxWorkers=1', '--minWorkers=1', '--reporter=json',
    '--outputFile=' + path.join(checks, 'backend-unit-final.json')], {
      cwd: path.join(candidate, 'backend'), timeout: 300000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=2048', SHANNON_ISOLATED_MINEBOT_PROBE: 'true',
        OPENAI_API_KEY: 'offline-test-not-used', MONGODB_URI: 'mongodb://127.0.0.1:27017/shannon-offline-not-used' } });
  fs.writeFileSync(path.join(checks, 'backend-unit-final.log'), (unitResult.stdout ?? '') + (unitResult.stderr ?? ''));
  const units = JSON.parse(fs.readFileSync(path.join(checks, 'backend-unit-final.json')));
  if (unitResult.status !== 0 || !units.success || units.numFailedTests || units.numPassedTests < 1348) throw new Error('COMPLETE_OFFLINE_UNIT_GATE_REQUIRED');
  console.log(JSON.stringify({ gate: 'offline-unit', passed: units.numPassedTests }));
  const results = {};
  for (const [name, args] of [['backend-build', ['--noCheck', '--skipLibCheck']], ['core-strict', ['-p', 'tsconfig.minecraft-execution.json', '--noEmit']]]) {
    const result = spawnSync(node, [path.join(candidate, 'node_modules/typescript/bin/tsc'), ...args], {
      cwd: path.join(candidate, 'backend'), timeout: 90000, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' } });
    fs.writeFileSync(path.join(checks, `${name}-promotion.log`), (result.stdout ?? '') + (result.stderr ?? ''));
    results[name] = { status: result.status, signal: result.signal };
    if (result.status !== 0) throw new Error(`VALIDATION_FAILED:${name}`);
  }
  verifySources();
  fs.writeFileSync(validation, JSON.stringify({ checkedAt: new Date().toISOString(), sourceFingerprint: manifest.sourceFingerprint,
    passedUnits: units.numPassedTests, results }, null, 2));
  console.log(JSON.stringify({ validated: true, sourceFingerprint: manifest.sourceFingerprint, passedUnits: units.numPassedTests }));
  process.exit(0);
}
const verified = JSON.parse(fs.readFileSync(validation));
if (verified.sourceFingerprint !== manifest.sourceFingerprint || Date.now() - Date.parse(verified.checkedAt) > 3600000) throw new Error('FRESH_VALIDATION_REQUIRED');
const command = (name, args) => execFileSync(name, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
const sudo = (...args) => command('sudo', ['-n', ...args]);
const backup = fs.mkdtempSync('/home/azureuser/.codex-shannon-preservation/minebot-cutover-'); fs.chmodSync(backup, 0o700);
fs.writeFileSync(path.join(backup, 'service-before.txt'), command('systemctl', ['cat', service]), { mode: 0o600 });
const oldDropin = fs.existsSync(dropin) ? fs.readFileSync(dropin) : null;
if (oldDropin) fs.writeFileSync(path.join(backup, 'dropin-before.conf'), oldDropin, { mode: 0o600 });
fs.writeFileSync(path.join(backup, 'cutover.json'), JSON.stringify({ parent: manifest.parentRelease, candidate, sourceFingerprint: manifest.sourceFingerprint }), { mode: 0o600 });
function switchTo(target) {
  const temporary = `${current}.minebot-next`;
  if (fs.existsSync(temporary)) throw new Error('CUTOVER_LINK_ALREADY_EXISTS');
  fs.symlinkSync(target, temporary); fs.renameSync(temporary, current);
}
async function ready() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:5001/api/ready', { signal: AbortSignal.timeout(1500) });
      if (response.ok && (await response.json()).status === 'ready') return;
    } catch { /* startup is bounded */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('PRODUCTION_READINESS_TIMEOUT');
}
(async () => {
  let stopped = false, switched = false, configurationChanged = false;
  try {
    await ready(); verifySources();
    sudo('systemctl', 'stop', service); stopped = true;
    if (command('systemctl', ['show', service, '-p', 'MainPID', '--value']).toString().trim() !== '0') throw new Error('BACKEND_NOT_STOPPED');
    command('tar', ['-C', '/home/azureuser/Shannon-runtime', '-cf', path.join(backup, 'backend-saves.tar'), 'backend-saves']);
    fs.chmodSync(path.join(backup, 'backend-saves.tar'), 0o600);
    // No credentials in argv/logs. Protected mongodump config is ephemeral and
    // only the already configured production DB is backed up; never restored here.
    const env = dotenv.parse(fs.readFileSync(path.join(manifest.parentRelease, 'backend/.env')));
    const uri = env.MONGODB_URI;
    if (!uri || !/\/shannon(?:\?|$)/.test(uri)) throw new Error('EXACT_PRODUCTION_DB_REQUIRED');
    const mongoConfig = path.join(backup, 'mongo-dump-config.yaml');
    fs.writeFileSync(mongoConfig, `uri: ${JSON.stringify(uri)}\n`, { mode: 0o600 });
    try { command('mongodump', ['--config', mongoConfig, '--archive=' + path.join(backup, 'mongo.archive'), '--gzip']); }
    finally { fs.unlinkSync(mongoConfig); }
    fs.chmodSync(path.join(backup, 'mongo.archive'), 0o600);
    sudo('install', '-m', '0644', path.join(candidate, 'deploy/minebot-adaptive.conf'), dropin); configurationChanged = true;
    sudo('systemctl', 'daemon-reload');
    switchTo(candidate); switched = true;
    sudo('systemctl', 'start', service); stopped = false;
    await ready();
    for (const [route, status] of [['/api/health', 200], ['/api/public/chat', 503], ['/api/identity/bindings', 401]]) {
      const response = await fetch(`http://127.0.0.1:5001${route}`, { signal: AbortSignal.timeout(3000) });
      if (response.status !== status) throw new Error(`SECURITY_OR_HEALTH_GATE_FAILED:${route}:${response.status}`);
    }
    const fixtureDirectory = path.join(candidate, 'backend/saves/minecraft/self_test_cases'); fs.mkdirSync(fixtureDirectory, { recursive: true });
    for (const file of fs.readdirSync(path.join(candidate, 'minebot-reviewed-fixtures'))) {
      const target = path.join(fixtureDirectory, file);
      if (!fs.existsSync(target)) fs.copyFileSync(path.join(candidate, 'minebot-reviewed-fixtures', file), target, fs.constants.COPYFILE_EXCL);
    }
    const result = { deployed: true, candidate, parent: manifest.parentRelease, sourceFingerprint: manifest.sourceFingerprint,
      backup, mainPid: command('systemctl', ['show', service, '-p', 'MainPID', '--value']).toString().trim(), deployedAt: new Date().toISOString(),
      cognitionMode: 'shadow-preserved', supervisionMode: 'shadow', publicChat: '503-preserved', dbMigration: false };
    fs.writeFileSync(path.join(backup, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 }); console.log(JSON.stringify(result));
  } catch (error) {
    if (switched) sudo('systemctl', 'stop', service);
    if (switched) switchTo(manifest.parentRelease);
    if (configurationChanged) {
      if (oldDropin) sudo('install', '-m', '0644', path.join(backup, 'dropin-before.conf'), dropin);
      else sudo('unlink', dropin); // exact new file created by this promotion only
      sudo('systemctl', 'daemon-reload');
    }
    if (stopped || switched) sudo('systemctl', 'start', service);
    console.log(JSON.stringify({ deployed: false, rolledBack: switched, backup, reason: error.message })); process.exitCode = 1;
  }
})().catch(() => { console.error('PROMOTION_RECOVERY_FAILED_MANUAL_ATTENTION_REQUIRED'); process.exitCode = 1; });
