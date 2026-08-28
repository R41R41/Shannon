'use strict';
// The reviewed LINE-only permit never unlocks the main Shannon runtime.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function readPrivate(directory, name) {
  const dir = fs.lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || dir.uid !== process.getuid()) throw Error();
  const fd = fs.openSync(path.join(directory,name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o077) || s.nlink !== 1 || s.size > 32768) throw Error();
    return fs.readFileSync(fd,'utf8');
  } finally { fs.closeSync(fd); }
}
async function main() {
  const mode = process.argv[2], target = process.argv[3];
  if (process.argv.length !== 4 || !['--check','--serve'].includes(mode) || !['dev','prod'].includes(target)
    || Number(process.versions.node.split('.')[0]) !== 22 || fs.realpathSync(root) !== root) throw Error();
  if (target === 'dev' ? root !== '/home/azureuser/Shannon-dev' || !fs.existsSync(path.join(root,'.dev-runtime-lock'))
    || !fs.existsSync(path.join(root,'.shannon-development')) : !/^\/home\/azureuser\/shannon-line\/releases\/[a-f0-9]{40}$/.test(root)) throw Error();
  const directory = `/home/azureuser/.config/shannon-line-${target}`;
  const rawEnv = readPrivate(directory,'runtime.env'); const env = require('dotenv').parse(rawEnv);
  const rawPolicy = readPrivate(directory,'radar.json');
  const permit = JSON.parse(readPrivate(directory,'launch-permit.json'));
  const bundle = path.join(root,'backend/dist-line/runtime.mjs');
  if (permit.version !== 1 || permit.environment !== target || permit.envSha256 !== hash(rawEnv)
    || permit.policySha256 !== hash(rawPolicy) || permit.bundleSha256 !== hash(fs.readFileSync(bundle))
    || (target === 'dev' && (!Number.isSafeInteger(permit.expiresAt) || permit.expiresAt <= Date.now() || permit.expiresAt > Date.now()+86400000))) throw Error();
  if (mode === '--check') {
    console.log(JSON.stringify({ permitValid: true, environment: target, liveStarted: false, credentialsVerified: false, databaseVerified: false })); return;
  }
  const mongoose = require('mongoose');
  const dbName = target === 'dev' ? 'shannon_line_dev' : 'shannon_line_prod';
  const client = new mongoose.mongo.MongoClient(`mongodb://127.0.0.1:27017/${dbName}`, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 10000 });
  let runtime;
  try {
    await client.connect();
    const { openLineRuntime } = await import(pathToFileURL(bundle).href);
    const readPolicy = async () => {
      // Deleting/replacing the permit or env stops acquisition and delivery on the next authorization check.
      const p = JSON.parse(readPrivate(directory,'launch-permit.json'));
      if (JSON.stringify(p) !== JSON.stringify(permit) || hash(readPrivate(directory,'runtime.env')) !== permit.envSha256
        || hash(readPrivate(directory,'radar.json')) !== permit.policySha256
        || (target === 'dev' && p.expiresAt <= Date.now())) throw Error();
      return JSON.parse(readPrivate(directory,'radar.json'));
    };
    runtime = await openLineRuntime({ env, db: client.db(dbName), readPolicy, port: target === 'dev' ? 15040 : 15041,
      profile: fs.readFileSync(path.join(root,'backend/saves/prompts/others/line_chat.md'),'utf8'),
      ...(target === 'dev' ? { permitUntil: permit.expiresAt } : {}), closeResources: () => client.close() });
    const stop = () => { void runtime.stop().catch(() => { process.exitCode = 1; }); };
    process.once('SIGTERM',stop); process.once('SIGINT',stop);
    console.log(JSON.stringify({ service: 'line', environment: target, host: '127.0.0.1', port: target === 'dev' ? 15040 : 15041 }));
  } catch { await runtime?.stop(); await client.close(); throw Error(); }
}
main().catch(() => { console.error('LINE_SERVICE_START_REFUSED'); process.exitCode = 1; });
