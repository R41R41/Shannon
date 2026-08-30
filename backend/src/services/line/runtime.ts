import mongoose, { type mongo } from 'mongoose';
import type { Socket } from 'node:net';
import { createLineApplication } from './application.js';
import { lineConfig } from './config.js';
import { MongoLineLedger } from './mongoLedger.js';
import { LineHttpTransport } from './transport.js';
import { createLineChatModel } from './chatModel.js';
import { lineChatTools } from './chatSkills.js';
import { customSearch } from '../search/customSearch.js';
import { YouTubeDataApiVideoSearch } from '../radar/youtubeSearch.js';
import { LineRadarWorker } from './radarWorker.js';
import { MongoPersonalCatalog } from '../radar/mongoPersonalCatalog.js';
import { radarDatabaseReady } from '../radar/runtimeAdapters.js';
import { PublicFeedConnector } from '../radar/feedConnector.js';
import { SafeFeedHttp, SafePublicJsonHttp } from '../radar/safeFeedHttp.js';
import { WeatherReadAdapter } from '../radar/weatherReadAdapter.js';
import { PersonalTemporalReaders } from '../radar/personalTemporalReaders.js';
import { CalendarReadAdapter } from '../radar/calendarReadAdapter.js';
import { GoogleRadarOAuthBroker } from '../radar/googleRadarOAuth.js';
import { RadarFca } from '../radar/radarFca.js';
import { createRadarFcaModel } from '../radar/radarFcaModel.js';
import { MongoRadarDeliveryReceipts } from '../radar/mongoRadarDeliveryReceipts.js';
import { YouTubeDataApiSubscriptionTransport, YouTubeDataApiUploadReader } from '../radar/youtubeDataApi.js';
import { YouTubeSubscriptionDiscovery } from '../radar/youtubeSubscriptionDiscovery.js';
import { YouTubeRecommendationDiscovery } from '../radar/youtubeRecommendationDiscovery.js';
import { YouTubeSubscriptionReader } from '../radar/youtubeSubscriptionInbox.js';
import { issueLineRadarContext, personalRadarOwner } from '../radar/radarAccess.js';
import { XPublicSearch } from '../radar/xPublicSearch.js';
import { WebSearchDiscovery } from '../radar/webSearchDiscovery.js';

import { authorizeLinePersonal, authorizeLineRadarPersonal, createMongoLineIdentityPort,
  type LineIdentityPort, type LineWebRadarSync } from './lineIdentityPort.js';
import { parseLineRadarPolicy, type LineRadarPolicy } from './radarPolicy.js';

export function lineRadarPolicyForIdentity(raw: unknown, sync: LineWebRadarSync, now = Date.now()): LineRadarPolicy {
  const policy = parseLineRadarPolicy(raw, now);
  if (sync.state === 'legacy') return policy;
  const expanded = {
    ...policy,
    topics: [...(policy.topics ?? [])],
    youtubeSubscriptions: policy.youtubeSubscriptions ?? null,
    calendar: policy.calendar ?? null,
  };
  if (sync.state === 'blocked') return parseLineRadarPolicy({ ...expanded, enabled: false, feeds: [], weather: null,
    topics: [], youtubeSubscriptions: null, calendar: null }, now);
  const topics = [...new Set([...(policy.topics ?? []), ...sync.topicIds])].slice(0, 20);
  const consentExpiresAt = Math.min(policy.consentExpiresAt, sync.validUntil);
  const sourceCount = sync.feeds.length + (policy.weather ? 1 : 0) + (policy.calendar ? 1 : 0) + (policy.youtubeSubscriptions ? 1 : 0);
  return parseLineRadarPolicy({ ...expanded, enabled: policy.enabled && consentExpiresAt > now && sourceCount > 0,
    consentExpiresAt, feeds: [...sync.feeds], topics }, now);
}

/** Independent composition root. Never imports the main server, Discord, shared env or global Mongo connection. */
export async function openLineRuntime(input: { env: Record<string,string>; db: mongo.Db; readPolicy(): Promise<unknown>;
  profile: string; port: number; permitUntil?: number; closeResources(): Promise<void>; identity?: LineIdentityPort; identityProjectId?: string }) {
  const config = lineConfig(input.env);
  if (!config.enabled || ![15040,15041].includes(input.port)) throw new Error('LINE_RUNTIME_INVALID');
  await radarDatabaseReady(input.db);
  const identityProjectId = input.identityProjectId ?? input.env.LINE_FIREBASE_PROJECT_ID;
  let identityDbClient: mongo.MongoClient | undefined;
  let identityPort = input.identity;
  if (!identityPort && identityProjectId && input.env.LINE_IDENTITY_MONGODB_URI) {
    identityDbClient = new mongoose.mongo.MongoClient(input.env.LINE_IDENTITY_MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    await identityDbClient.connect();
    identityPort = createMongoLineIdentityPort(identityDbClient.db());
  }
  const authorizePersonal = (lineUserId: string) => authorizeLinePersonal(identityPort, identityProjectId, lineUserId);
  const authorizeRadarPersonal = (lineUserId: string) => authorizeLineRadarPersonal(identityPort, identityProjectId, lineUserId);
  const readRadarPolicy = async () => {
    const raw = await input.readPolicy();
    if (!identityPort || !identityProjectId) return raw;
    const sync = await identityPort.readWebRadarSync(identityProjectId, config.personalUserId);
    return lineRadarPolicyForIdentity(raw, sync);
  };
  const owner = personalRadarOwner(issueLineRadarContext(config.botUserId, config.personalUserId, Date.now()+60000), Date.now());
  const google = new GoogleRadarOAuthBroker({ clientId: input.env.LINE_GOOGLE_CLIENT_ID ?? '', clientSecret: input.env.LINE_GOOGLE_CLIENT_SECRET ?? '',
    refreshToken: input.env.LINE_GOOGLE_REFRESH_TOKEN ?? '' }, owner);
  const youtubeSearch = new YouTubeDataApiVideoSearch(google);
  const xSearch = input.env.LINE_X_SEARCH_API_KEY ? new XPublicSearch(input.env.LINE_X_SEARCH_API_KEY) : undefined;
  const webKey = input.env.LINE_WEB_SEARCH_API_KEY ?? '', webEngine = input.env.LINE_WEB_SEARCH_ENGINE_ID ?? '';
  const webSearch = webKey && webEngine ? new WebSearchDiscovery({ apiKey: webKey, engineId: webEngine }) : undefined;
  let worker: LineRadarWorker;
  const runtime = createLineApplication(config, { state: new MongoLineLedger(input.db),
    chat: config.chatMaxPer24Hours > 0 ? createLineChatModel({ apiKey: input.env.LINE_LLM_API_KEY, model: input.env.LINE_LLM_MODEL, profile: input.profile,
      tools: lineChatTools({
        ...(webKey && webEngine ? { web: (query, limit, signal) => customSearch({ apiKey: webKey, engineId: webEngine }, query, limit, signal) } : {}),
        youtube: async (query, limit, signal) => youtubeSearch.list(await google.authorizeYouTube(signal), query, limit, signal),
      }) })
      : { reply: async () => { throw new Error('LINE_CHAT_DISABLED'); } },
    transport: new LineHttpTransport(config.channelAccessToken),
    authorizeRuntime: async () => { await readRadarPolicy(); },
    authorizePersonal,
    radar: { status: () => worker.status(), authorizeQuote: id => worker.authorizeQuote(id), conversationVersion: () => worker.conversationVersion() } });
  const receipts = new MongoRadarDeliveryReceipts(input.db);
  const subscriptions = new YouTubeSubscriptionReader(new YouTubeDataApiSubscriptionTransport(google));
  const uploads = new YouTubeDataApiUploadReader(google);
  worker = new LineRadarWorker(config, { ledger: runtime.ledger, catalog: new MongoPersonalCatalog(input.db),
    feed: new PublicFeedConnector(new SafeFeedHttp()), temporal: new PersonalTemporalReaders(new WeatherReadAdapter(new SafePublicJsonHttp()), new CalendarReadAdapter(google)),
    readPolicy: readRadarPolicy, deliver: runtime.deliver, authorizePersonal, authorizeRadarPersonal,
    radarFca: { fca: new RadarFca(createRadarFcaModel({ apiKey: input.env.LINE_LLM_API_KEY ?? '', model: input.env.LINE_LLM_MODEL ?? '' })), receipts,
      youtube: async (expectedOwner, setting, limit, signal) => {
        if (expectedOwner !== owner) throw new Error('LINE_RADAR_OWNER');
        return new YouTubeSubscriptionDiscovery(subscriptions, uploads, owner, () => google.authorizeYouTube(signal),
          setting.baselineAt, setting.maxSubscriptions).find(Math.min(limit, setting.maxCandidates), signal);
      },
      youtubeRecommendations: async (expectedOwner, query, limit, signal) => {
        if (expectedOwner !== owner) throw new Error('LINE_RADAR_OWNER');
        return new YouTubeRecommendationDiscovery(subscriptions, youtubeSearch, owner, () => google.authorizeYouTube(signal)).find(query, limit, signal);
      },
      ...(xSearch ? { twitter: async (expectedOwner:string, query:string, limit:number, signal:AbortSignal) => {
        if (expectedOwner !== owner) throw new Error('LINE_RADAR_OWNER');
        return xSearch.list(query, limit, signal);
      } } : {}),
      ...(webSearch ? { webSearch: async (expectedOwner:string, query:string, limit:number, signal:AbortSignal) => {
        if (expectedOwner !== owner) throw new Error('LINE_RADAR_OWNER');
        return webSearch.find(expectedOwner, query, limit, signal);
      } } : {}) } });
  // Validate all configuration and binding before opening a listener or running a scheduled tick.
  await worker.status(); await runtime.ledger.read();
  const sockets = new Set<Socket>();
  const server = await new Promise<ReturnType<typeof runtime.app.listen>>((resolve, reject) => {
    const s = runtime.app.listen(input.port, '127.0.0.1', () => resolve(s)); s.once('error', reject);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
  let closing: Promise<void> | undefined; let expiry: ReturnType<typeof setTimeout> | undefined;
  let lastPurge = 0;
  const tick = async () => {
    if (closing) return;
    try {
      if (Date.now() - lastPurge >= 3600000) { await runtime.ledger.purgeExpired(); lastPurge = Date.now(); }
      const result = await worker.tick();
      if (!['not-due','already-attempted','disabled','budget-wait'].includes(result))
        console.log(JSON.stringify({ service: 'line', event: 'radar_tick', result, aborted: false }));
    } catch { console.error('LINE_MAINTENANCE_UNAVAILABLE'); }
  };
  const interval = setInterval(() => { void tick(); }, 30000);
  const stop = () => closing ??= (async () => {
    clearInterval(interval); clearTimeout(expiry); runtime.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await worker.stop(); await runtime.drain(); await identityDbClient?.close(); await input.closeResources();
  })();
  if (input.permitUntil !== undefined) expiry = setTimeout(() => { void stop().catch(() => undefined); }, Math.max(0,input.permitUntil-Date.now()));
  server.on('error', () => { void stop().catch(() => undefined); });
  void tick();
  return { stop };
}
