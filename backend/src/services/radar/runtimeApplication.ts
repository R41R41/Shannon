import express from 'express';
import { randomUUID } from 'node:crypto';
import { AccessError, AccessService, type IdentityVerifier, type AccessUserRepository } from '../../modules/access/index.js';
import type { PersonalCatalogPort } from '../../modules/radar/catalog.js';
import { authenticateRequest, sendAccessError } from '../../routes/accessHttp.js';
import { registerRadarRoutes } from '../../routes/radarRoutes.js';
import { PersonalRadarService } from './personalRadar.js';
import { PersonalTemporalRadar } from './personalTemporalRadar.js';
import { PersonalTemporalReaders } from './personalTemporalReaders.js';
import { PublicFeedConnector, feedUrl } from './feedConnector.js';
import type { FeedHttpPort } from './safeFeedHttp.js';
import { WeatherReadAdapter } from './weatherReadAdapter.js';
import { RadarWorkspace } from './radarWorkspace.js';
import { RadarSessionRunner } from './sessionRunner.js';
import { radarRuntimeConfig, type RadarRuntimeConfig } from './runtimeConfig.js';

export interface RadarRuntimePorts {
  identity: IdentityVerifier;
  users: AccessUserRepository;
  catalog: PersonalCatalogPort;
  feedHttp: FeedHttpPort;
  weatherHttp: FeedHttpPort;
  /** Read-only DB ping and exact validator check, no migrations or external provider requests. */
  ready(): Promise<void>;
}
/** Independent HTTP composition. No legacy server, bot, scheduler, model manager or operational sockets. */
export function createRadarApplication(input: RadarRuntimeConfig, ports: RadarRuntimePorts, now = Date.now) {
  const config = radarRuntimeConfig(input, now());
  const app = express(); app.disable('x-powered-by'); app.set('trust proxy', false);
  let accepting = true; let inFlight = 0;
  const active = () => accepting && now() < config.permitUntil;
  const access = new AccessService({ verify: async token => {
    if (!active()) throw new AccessError('AUTH_UNAVAILABLE');
    const identity = await ports.identity.verify(token);
    if (!active() || identity.projectId !== config.firebase.projectId || !config.allowedUids.includes(identity.uid)) throw new AccessError('FORBIDDEN');
    return identity;
  } }, ports.users, randomUUID, now);
  const feed = new PersonalRadarService(ports.catalog, now, config.acquisition);
  const connector = new PublicFeedConnector({ get: async (url, signal) => {
    if (!active() || !config.feedUrls.includes(url)) throw new Error('RADAR_SOURCE_NOT_APPROVED');
    return ports.feedHttp.get(url, signal);
  } }, now);
  const weather = config.weather ? new WeatherReadAdapter({ get: (url, signal) => {
    if (!active()) throw new Error('RADAR_RUNTIME_EXPIRED');
    return ports.weatherHttp.get(url, signal);
  } }, now) : undefined;
  const temporal = new PersonalTemporalRadar(ports.catalog, new PersonalTemporalReaders(weather), now, config.acquisition);
  const workspace = new RadarWorkspace(feed, temporal, { weatherAvailable: !!weather }, now);
  const runner = new RadarSessionRunner(access, feed, { read: (source, signal) => {
    if (!config.feedUrls.includes(feedUrl(source))) throw new Error('RADAR_SOURCE_NOT_APPROVED');
    return connector.read(source, signal);
  } }, now, temporal);
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    if (req.get('host') !== new URL(config.origin).host || (req.get('origin') && req.get('origin') !== config.origin)
      || (req.get('sec-fetch-site') && !['same-origin','none'].includes(req.get('sec-fetch-site')!))) { res.status(403).json({ error: 'ORIGIN_DENIED' }); return; }
    if (!active()) { res.status(503).json({ error: 'RADAR_STOPPED' }); return; }
    if (inFlight >= 8) { res.status(503).json({ error: 'RADAR_BUSY' }); return; }
    inFlight++; let done = false;
    const timer = setTimeout(() => res.destroy(), 45000);
    const finish = () => { if (!done) { done = true; inFlight--; clearTimeout(timer); } };
    res.once('finish', finish); res.once('close', finish); next();
  });
  app.get('/api/radar/runtime', (_req, res) => res.json({ version: 1, firebase: config.firebase }));
  app.get('/api/radar/health', (_req, res) => res.json({ status: 'ok', service: 'radar' }));
  app.get('/api/radar/ready', async (_req, res) => {
    try { await ports.ready(); res.status(active() ? 200 : 503).json({ ready: active(), providersVerified: false }); }
    catch { res.status(503).json({ ready: false }); }
  });
  app.get('/api/radar/session', async (req, res) => {
    try {
      if (Object.keys(req.query).length) { res.status(400).json({ error: 'INVALID_INPUT' }); return; }
      const context = await authenticateRequest(req, access);
      if (!res.destroyed && active()) res.json({ projectId: context.principal.projectId, uid: context.principal.uid, expiresAt: context.expiresAtMs });
    } catch (e) { if (!res.destroyed) sendAccessError(res, e); }
  });
  registerRadarRoutes(app, access, feed, runner, workspace);
  // Reject parser errors with a fixed response: never echo user input or a stack trace.
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (!res.destroyed) res.status((error as { type?: string })?.type === 'entity.too.large' ? 413 : 400).json({ error: 'INVALID_INPUT' });
  });
  return { app, stopAccepting: () => { accepting = false; }, inFlight: () => inFlight };
}
