'use strict';
// Explicit standalone dev entry. It neither imports server.js nor loads .env.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const privateRoot = '/home/azureuser/.config/shannon-radar-dev';
function privateJson(name) {
  const dir = fs.lstatSync(privateRoot);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || dir.uid !== process.getuid()) throw Error();
  const file = path.join(privateRoot, name);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 32768 || stat.nlink !== 1) throw Error();
    const text = fs.readFileSync(fd, 'utf8'); if (Buffer.byteLength(text) > 32768) throw Error();
    return JSON.parse(text);
  } finally { fs.closeSync(fd); }
}
async function main() {
  if (root !== '/home/azureuser/Shannon-dev' || fs.realpathSync(root) !== root || !fs.existsSync(path.join(root, '.shannon-development'))
    || !['--check', '--serve'].includes(process.argv[2]) || process.argv.length !== 3 || Number(process.versions.node.split('.')[0]) !== 22) throw Error();
  if (process.argv[2] === '--serve' && fs.existsSync(path.join(root, '.dev-runtime-lock'))) throw Error();
  const load = file => import(pathToFileURL(path.join(root, 'backend/dist/services/radar', file)).href);
  const { radarRuntimeConfig } = await load('runtimeConfig.js');
  const config = radarRuntimeConfig(privateJson('runtime.json'));
  if (process.argv[2] === '--check') {
    console.log(JSON.stringify({ configValid: true, devRuntimeLocked: fs.existsSync(path.join(root, '.dev-runtime-lock')), credentialsVerified: false, databaseVerified: false, liveStarted: false })); return;
  }
  if (fs.existsSync(path.join(root, '.dev-runtime-lock'))) throw Error();
  const credential = privateJson('firebase.json');
  const { openRadarFirebase, RadarMongoUsers, radarDatabaseReady } = await load('runtimeAdapters.js');
  const { MongoPersonalCatalog } = await load('mongoPersonalCatalog.js');
  const { createRadarApplication } = await load('runtimeApplication.js');
  const { listenRadarHost } = await load('runtimeHost.js');
  const { SafeFeedHttp, SafePublicJsonHttp } = await load('safeFeedHttp.js');
  const mongoose = await import('mongoose');
  const client = new mongoose.default.mongo.MongoClient('mongodb://127.0.0.1:27017/shannon_dev', { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 10000 });
  let firebase; let closed = false;
  const close = async () => { if (closed) return; closed = true; try { await firebase?.close(); } finally { await client.close(); } };
  try {
    await client.connect(); const db = client.db('shannon_dev'); await radarDatabaseReady(db);
    firebase = await openRadarFirebase(config.firebase.projectId, credential);
    const runtime = createRadarApplication(config, { identity: firebase.identity, users: new RadarMongoUsers(db), catalog: new MongoPersonalCatalog(db),
      feedHttp: new SafeFeedHttp(), weatherHttp: new SafePublicJsonHttp(), ready: () => radarDatabaseReady(db) });
    const express = (await import('express')).default;
    const site = path.join(root, 'frontend/dist-radar');
    if (!fs.existsSync(path.join(site, 'index.html'))) throw Error();
    runtime.app.use('/assets', express.static(path.join(site, 'assets'), { dotfiles: 'deny', redirect: false, etag: false, lastModified: false }));
    runtime.app.get(['/', '/radar'], (_req, res) => res.sendFile(path.join(site, 'index.html')));
    runtime.app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
    const host = await listenRadarHost(runtime, config.port, close, config.permitUntil);
    const stop = () => { void host.stop().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    console.log(JSON.stringify({ service: 'radar', host: '127.0.0.1', port: config.port, calendar: false, bots: false }));
  } catch { await close(); throw Error(); }
}
main().catch(() => { console.error('RADAR_DEV_START_REFUSED'); process.exitCode = 1; });
