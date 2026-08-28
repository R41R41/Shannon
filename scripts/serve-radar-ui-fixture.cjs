'use strict';
// Explicit UI test harness. Starts neither Shannon nor Mongo nor Firebase nor a real feed connector.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
async function main() {
  const root = fs.realpathSync(path.join(__dirname, '..'));
  assert.equal(root, '/home/azureuser/Shannon-dev'); assert.deepEqual(process.argv.slice(2), ['--isolated-fixture']);
  assert(fs.existsSync(path.join(root, '.dev-runtime-lock')));
  const out = '/home/azureuser/.codex-shannon-preservation/radar-ui-20260828'; fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const { build } = await import('vite');
  await build({ configFile: false, envDir: false, root: path.join(root, 'frontend/tests/fixtures/radar'),
    resolve: { alias: { '@styles': path.join(root, 'frontend/src/styles') } },
    cacheDir: path.join(out, 'vite-cache'), esbuild: { jsx: 'automatic' },
    build: { outDir: path.join(out, 'site'), emptyOutDir: false, minify: false }, logLevel: 'warn' });
  const load = file => import(pathToFileURL(path.join(root, 'backend/dist', file)).href);
  const { AccessService, AccessError } = await load('modules/access/index.js');
  const { registerRadarRoutes } = await load('routes/radarRoutes.js');
  const { PersonalRadarService } = await load('services/radar/personalRadar.js');
  const { parseFeed } = await load('services/radar/feedConnector.js');
  const express = require('express'); const app = express();
  const rows = new Map();
  const store = { read: async owner => structuredClone(rows.get(owner) ?? null), compareAndSwap: async (owner, expected, next) => {
    if ((rows.get(owner)?.revision ?? 0) !== expected) return false; rows.set(owner, structuredClone(next)); return true;
  } };
  const access = new AccessService({ verify: async token => {
    if (!['fixture-alice', 'fixture-bob'].includes(token)) throw new AccessError('UNAUTHENTICATED');
    return { projectId: 'isolated-ui-fixture', uid: token, email: 'synthetic@example.test', emailVerified: true, expiresAtMs: Date.now() + 3600000 };
  } }, { findByIdentity: async (projectId, uid) => ({ projectId, uid, name: 'Synthetic', email: 'synthetic@example.test', isAuthorized: true, isAdmin: false }) }, () => 'fixture-request');
  const radar = new PersonalRadarService(store);
  const alice = await access.authenticate('fixture-alice');
  const seeds = [
    ['game-news', '任天堂の新作情報をチェック', 'games'],
    ['science-feed', '海の深くで見つかった、不思議な光', 'science'],
    ['creator-feed', '配信とものづくりの新しい話題', 'creative'],
  ];
  for (const [id, title, topic] of seeds) {
    const state = await radar.sources(alice);
    await radar.configure(alice, id, { expectedRevision: state.revision, source: { enabled: true, consentExpiresAt: Date.now() + 86400000,
      kind: 'web', locator: `https://example.org/${id}/feed`, articleHosts: ['example.org'], topicIds: [topic], maxItems: 10, retentionMs: 86400000 } }, () => access.authenticate('fixture-alice'));
    const xml = `<feed><entry><id>${id}-1</id><title>${title}（架空fixture）</title><link href="https://example.org/${id}/item"/><published>${new Date(Date.now() - 60000).toISOString()}</published></entry></feed>`;
    await radar.collect(alice, id, { read: async source => parseFeed(xml, source, Date.now()) }, new AbortController().signal, () => access.authenticate('fixture-alice'));
  }
  app.use((req, res, next) => {
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return res.sendStatus(403);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; object-src 'none'; frame-ancestors 'none'"); next();
  });
  let requestCount = 0; app.use('/api/radar', (_req, _res, next) => { requestCount++; next(); });
  registerRadarRoutes(app, access, radar);
  app.use(express.static(path.join(out, 'site'), { etag: false, lastModified: false, cacheControl: false }));
  const server = app.listen(13002, '127.0.0.1', () => {
    const info = { fixtureOnly: true, pid: process.pid, port: 13002, host: '127.0.0.1', firebase: false, applicationStarted: false,
      normalDbWritten: false, realSourcesFetched: false, fixtureOwners: 1, seededSources: 3 };
    fs.writeFileSync(path.join(out, 'ui-fixture-start.json'), JSON.stringify(info, null, 2)); console.log(JSON.stringify(info));
  });
  server.on('error', () => { console.error('RADAR_UI_FIXTURE_LISTENER_FAILED'); process.exitCode = 1; });
  const stop = () => { server.closeAllConnections(); server.close(() => {
    fs.writeFileSync(path.join(out, 'ui-fixture-stop.json'), JSON.stringify({ fixtureOnly: true, stopped: true, requestCount, normalDbWritten: false }));
    console.log('RADAR_UI_FIXTURE_STOPPED'); process.exit(0);
  }); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
main().catch(() => { console.error('RADAR_UI_FIXTURE_FAILED'); process.exitCode = 1; });
