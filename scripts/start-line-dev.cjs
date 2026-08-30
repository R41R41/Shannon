'use strict';
// Dedicated entry: no main server, shared .env, Firebase, Discord bot or scheduler.
const fs = require('node:fs'); const path = require('node:path'); const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const privateRoot = '/home/azureuser/.config/shannon-line-dev';
async function main() {
  if (root !== '/home/azureuser/Shannon-dev' || fs.realpathSync(root) !== root || !fs.existsSync(path.join(root, '.shannon-development'))
    || !['--check', '--serve'].includes(process.argv[2]) || process.argv.length !== 3 || Number(process.versions.node.split('.')[0]) !== 22) throw Error();
  if (process.argv[2] === '--serve' && fs.existsSync(path.join(root, '.dev-runtime-lock'))) throw Error();
  const dir = fs.lstatSync(privateRoot);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || dir.uid !== process.getuid()) throw Error();
  const fd = fs.openSync(path.join(privateRoot, 'runtime.env'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let env;
  try {
    const st = fs.fstatSync(fd); if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() || (st.mode & 0o077) || st.size > 16384) throw Error();
    env = require('dotenv').parse(fs.readFileSync(fd));
  } finally { fs.closeSync(fd); }
  const load = file => import(pathToFileURL(path.join(root, 'backend/dist/services/line', file)).href);
  const { lineConfig } = await load('config.js'); const config = lineConfig(env);
  if (process.argv[2] === '--check') {
    console.log(JSON.stringify({ configValid: true, enabled: config.enabled, allowedGroups: config.allowedGroupIds.length,
      personalConfigured: !!config.personalUserId, liveStarted: false, credentialsVerified: false, locked: fs.existsSync(path.join(root, '.dev-runtime-lock')) })); return;
  }
  const permitUntil = Number(env.LINE_PERMIT_UNTIL);
  if (!config.enabled || !Number.isSafeInteger(permitUntil) || permitUntil <= Date.now() || permitUntil > Date.now() + 86400000
    || fs.existsSync(path.join(root, '.dev-runtime-lock'))) throw Error();
  const { createLineApplication } = await load('application.js');
  const { MongoLineLedger } = await load('mongoLedger.js'); const { LineHttpTransport } = await load('transport.js');
  const { createLineChatModel } = await load('chatModel.js');
  const chat = createLineChatModel({ apiKey: env.LINE_LLM_API_KEY, model: env.LINE_LLM_MODEL,
    profile: fs.readFileSync(path.join(root, 'backend/saves/prompts/others/line_chat.md'), 'utf8') });
  const mongoose = await import('mongoose');
  const client = new mongoose.default.mongo.MongoClient('mongodb://127.0.0.1:27017/shannon_line_dev', { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 10000 });
  let server; let runtime; let timer;
  try {
    await client.connect(); await client.db('shannon_line_dev').command({ ping: 1 });
    runtime = createLineApplication(config, { state: new MongoLineLedger(client.db('shannon_line_dev')), chat, transport: new LineHttpTransport(config.channelAccessToken) });
    server = await new Promise((resolve, reject) => { const s = runtime.app.listen(15040, '127.0.0.1', () => resolve(s)); s.once('error', reject); });
    server.requestTimeout = 10000; server.headersTimeout = 10000;
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; clearTimeout(timer); runtime.stop();
      await new Promise(resolve => server.close(resolve)); await runtime.drain(); await client.close(); };
    const end = () => { void stop().catch(() => { process.exitCode = 1; }); };
    process.once('SIGTERM', end); process.once('SIGINT', end); timer = setTimeout(end, permitUntil - Date.now());
    console.log(JSON.stringify({ service: 'line', host: '127.0.0.1', port: 15040, scheduler: false, personalPushWorker: false }));
  } catch { clearTimeout(timer); runtime?.stop(); server?.close(); await client.close(); throw Error(); }
}
main().catch(() => { console.error('LINE_DEV_START_REFUSED'); process.exitCode = 1; });
