import type { Express } from 'express';
import type { mongo } from 'mongoose';
import type { AccessService } from '../modules/access/index.js';
import type { AcquisitionPolicy } from '../modules/radar/acquisition.js';
import type { IdentityProfileRepository } from '../modules/identity/bindingWrite.js';
import { registerRadarRoutes } from '../routes/radarRoutes.js';
import { MongoPersonalCatalog } from '../services/radar/mongoPersonalCatalog.js';
import { PersonalRadarService } from '../services/radar/personalRadar.js';
import { PersonalTemporalRadar } from '../services/radar/personalTemporalRadar.js';
import { PersonalTemporalReaders } from '../services/radar/personalTemporalReaders.js';
import { PublicFeedConnector } from '../services/radar/feedConnector.js';
import { SafeFeedHttp } from '../services/radar/safeFeedHttp.js';
import { WeatherReadAdapter } from '../services/radar/weatherReadAdapter.js';
import { RadarWorkspace } from '../services/radar/radarWorkspace.js';
import { RadarSessionRunner } from '../services/radar/sessionRunner.js';

/** Explicit server-owned acquisition policy for main-server Radar routes. */
export const MAIN_RADAR_ACQUISITION: AcquisitionPolicy = Object.freeze({
  maxPer24Hours: 24,
  minimumIntervalMs: 60_000,
  leaseMs: 30_000,
});

export interface MainRadarDeps {
  access: AccessService;
  profiles: IdentityProfileRepository;
  db: mongo.Db;
  weatherEnabled?: boolean;
}

/** Register personal Radar HTTP on the main server. Uses shared AccessService and Mongo catalog. */
export function registerMainRadarRoutes(app: Express, deps: MainRadarDeps, now = Date.now): void {
  const catalog = new MongoPersonalCatalog(deps.db);
  const feedHttp = new SafeFeedHttp();
  const feed = new PersonalRadarService(catalog, now, MAIN_RADAR_ACQUISITION);
  const connector = new PublicFeedConnector(feedHttp, now);
  const weather = deps.weatherEnabled
    ? new WeatherReadAdapter({ get: (url, signal) => new SafeFeedHttp(undefined, undefined, 'json').get(url, signal) }, now)
    : undefined;
  const temporal = new PersonalTemporalRadar(catalog, new PersonalTemporalReaders(weather), now, MAIN_RADAR_ACQUISITION);
  const workspace = new RadarWorkspace(feed, temporal, { weatherAvailable: !!weather }, now);
  const runner = new RadarSessionRunner(deps.access, feed, connector, now, temporal);
  registerRadarRoutes(app, deps.access, feed, runner, workspace, deps.profiles);
}
