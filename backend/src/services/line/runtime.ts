import type { mongo } from 'mongoose';
import type { Socket } from 'node:net';
import { createLineApplication } from './application.js';
import { lineConfig } from './config.js';
import { MongoLineLedger } from './mongoLedger.js';
import { LineHttpTransport } from './transport.js';
import { createLineChatModel } from './chatModel.js';
import { LineRadarWorker } from './radarWorker.js';
import { MongoPersonalCatalog } from '../radar/mongoPersonalCatalog.js';
import { radarDatabaseReady } from '../radar/runtimeAdapters.js';
import { PublicFeedConnector } from '../radar/feedConnector.js';
import { SafeFeedHttp, SafePublicJsonHttp } from '../radar/safeFeedHttp.js';
import { WeatherReadAdapter } from '../radar/weatherReadAdapter.js';
import { PersonalTemporalReaders } from '../radar/personalTemporalReaders.js';

/** Independent composition root. Never imports the main server, Discord, shared env or global Mongo connection. */
export async function openLineRuntime(input: { env: Record<string,string>; db: mongo.Db; readPolicy(): Promise<unknown>;
  profile: string; port: number; permitUntil?: number; closeResources(): Promise<void> }) {
  const config = lineConfig(input.env);
  if (!config.enabled || ![15040,15041].includes(input.port)) throw new Error('LINE_RUNTIME_INVALID');
  await radarDatabaseReady(input.db);
  let worker: LineRadarWorker;
  const runtime = createLineApplication(config, { state: new MongoLineLedger(input.db),
    chat: config.chatMaxPer24Hours > 0 ? createLineChatModel({ apiKey: input.env.LINE_LLM_API_KEY, model: input.env.LINE_LLM_MODEL, profile: input.profile })
      : { reply: async () => { throw new Error('LINE_CHAT_DISABLED'); } },
    transport: new LineHttpTransport(config.channelAccessToken),
    authorizeRuntime: async () => { await input.readPolicy(); },
    radar: { status: () => worker.status(), authorizeQuote: id => worker.authorizeQuote(id), conversationVersion: () => worker.conversationVersion() } });
  worker = new LineRadarWorker(config, { ledger: runtime.ledger, catalog: new MongoPersonalCatalog(input.db),
    feed: new PublicFeedConnector(new SafeFeedHttp()), temporal: new PersonalTemporalReaders(new WeatherReadAdapter(new SafePublicJsonHttp())),
    readPolicy: input.readPolicy, deliver: runtime.deliver });
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
      if (!['not-due','already-attempted','disabled','budget-wait'].includes(result)) console.log(JSON.stringify({ service: 'line', event: 'radar_tick', result }));
    } catch { console.error('LINE_MAINTENANCE_UNAVAILABLE'); }
  };
  const interval = setInterval(() => { void tick(); }, 30000);
  const stop = () => closing ??= (async () => {
    clearInterval(interval); clearTimeout(expiry); runtime.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await worker.stop(); await runtime.drain(); await input.closeResources();
  })();
  if (input.permitUntil !== undefined) expiry = setTimeout(() => { void stop().catch(() => undefined); }, Math.max(0,input.permitUntil-Date.now()));
  server.on('error', () => { void stop().catch(() => undefined); });
  void tick();
  return { stop };
}
