import { validAcquisitionPolicy, type AcquisitionPolicy } from '../../modules/radar/acquisition.js';
import { publicFeedUrl } from './safeFeedHttp.js';

export interface RadarRuntimeConfig {
  version: 1;
  environment: 'dev';
  origin: string;
  port: 15030;
  permitUntil: number;
  firebase: { projectId: string; apiKey: string; appId: string };
  allowedUids: string[];
  acquisition: AcquisitionPolicy;
  feedUrls: string[];
  weather: boolean;
}
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
export function radarRuntimeConfig(value: unknown, now = Date.now()): RadarRuntimeConfig {
  const fail = (): never => { throw new Error('RADAR_RUNTIME_CONFIG'); };
  if (!exact(value, ['version','environment','origin','port','permitUntil','firebase','allowedUids','acquisition','feedUrls','weather'])) return fail();
  if (value.version !== 1 || value.environment !== 'dev' || value.port !== 15030
    || !Number.isSafeInteger(value.permitUntil) || Number(value.permitUntil) <= now || Number(value.permitUntil) > now + 86400000
    || typeof value.weather !== 'boolean' || typeof value.origin !== 'string') return fail();
  let origin: URL;
  try { origin = new URL(value.origin); } catch { return fail(); }
  if (origin.origin !== value.origin || origin.username || origin.password
    || !(origin.protocol === 'https:' || value.origin === 'http://127.0.0.1:15030')) return fail();
  const f = value.firebase;
  if (!exact(f, ['projectId','apiKey','appId']) || typeof f.projectId !== 'string'
    || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(f.projectId) || f.projectId === 'shannonui'
    || typeof f.apiKey !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(f.apiKey)
    || typeof f.appId !== 'string' || !/^1:\d+:web:[a-f0-9]+$/.test(f.appId)) return fail();
  if (!Array.isArray(value.allowedUids) || !value.allowedUids.length || value.allowedUids.length > 8
    || value.allowedUids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
    || new Set(value.allowedUids).size !== value.allowedUids.length) return fail();
  if (!validAcquisitionPolicy(value.acquisition) || value.acquisition.maxPer24Hours > 24 || value.acquisition.leaseMs !== 30000) return fail();
  if (!Array.isArray(value.feedUrls) || value.feedUrls.length > 32 || value.feedUrls.some(url => {
    try { return publicFeedUrl(url).href !== url; } catch { return true; }
  }) || new Set(value.feedUrls).size !== value.feedUrls.length) return fail();
  return structuredClone(value) as unknown as RadarRuntimeConfig;
}
