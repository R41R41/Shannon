import type http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { logger } from '../../utils/logger.js';
import { requireCapability, type AccessService, type RequestContext } from '../../modules/access/index.js';
import { shouldDeliverWebNotification } from '../web/webNotificationBridge.js';

export interface WebSocketServiceConfig {
  port?: number;
  host?: string;
  server?: http.Server;
  serviceName: string;
  maxPayload?: number;
  /** Legacy services remain single-client until request-scoped routing is implemented. */
  singleConnection?: boolean;
  access?: AccessService;
  allowedOrigins?: readonly string[];
  /** Short authorization lease bounds revocation latency; clients reconnect with a fresh token. */
  authorizationLeaseMs?: number;
}
export abstract class WebSocketServiceBase {
  protected wss!: WebSocketServer;
  protected serviceName: string;
  private isInitialized = false;
  protected activeConnections = new Set<WebSocket>();
  private readonly alive = new WeakSet<WebSocket>();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private stopping: Promise<void> | null = null;
  private readonly contexts = new WeakMap<WebSocket, RequestContext>();
  private readonly pendingOutput = new WeakMap<WebSocket, unknown[]>();
  private readonly webSessions = new WeakMap<WebSocket, string>();

  constructor(private readonly config: WebSocketServiceConfig) {
    this.serviceName = config.serviceName;
    if (!config.server && (config.port === undefined || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535)) {
      throw new Error('Invalid WebSocket configuration');
    }
  }
  /** Constructing a service does not open a port or start a timer. */
  public start(): void {
    if (this.stopping) throw new Error('WebSocket service is stopping');
    if (this.isInitialized) return;
    const options = this.config.server ? { server: this.config.server } : { port: this.config.port!, host: this.config.host };
    this.wss = new WebSocketServer({ ...options, maxPayload: this.config.maxPayload ?? 1024 * 1024,
      ...(this.config.allowedOrigins === undefined ? {} : {
        verifyClient: ({ origin, req }: { origin: string; req: http.IncomingMessage }) =>
          this.config.allowedOrigins!.includes(origin) && !req.url?.includes('?'),
      }),
    });
    this.wss.on('error', () => { logger.error(`WebSocket service error: ${this.serviceName}`); });
    this.isInitialized = true;
    try {
      this.initialize();
      this.pingInterval = setInterval(() => {
        for (const ws of this.activeConnections) {
          if (!this.alive.has(ws)) { ws.terminate(); this.activeConnections.delete(ws); continue; }
          this.alive.delete(ws);
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        }
      }, 30_000);
      this.pingInterval.unref();
    } catch (error) {
      void this.stop();
      throw error;
    }
  }
  public stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.isInitialized) return Promise.resolve();
    this.isInitialized = false;
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = null;
    for (const ws of this.wss.clients) ws.terminate();
    this.activeConnections.clear();
    const server = this.wss;
    this.stopping = new Promise<void>(resolve => { server.close(() => resolve()); })
      .finally(() => { this.stopping = null; });
    return this.stopping;
  }
  protected handleNewConnection(ws: WebSocket): void {
    if (this.config.singleConnection !== false && !this.config.access) {
      for (const previous of this.activeConnections) previous.close();
      this.activeConnections.clear();
    }
    this.alive.add(ws);
    ws.on('pong', () => { this.alive.add(ws); });
    this.activeConnections.add(ws);
    ws.on('close', () => { this.activeConnections.delete(ws); });
  }
  /** No handler, initial DB read, broadcast subscription or operation runs before server-side authentication. */
  protected onAuthenticatedConnection(handler: (ws: WebSocket, context: RequestContext) => void | Promise<void>): void {
    this.wss.on('connection', ws => {
      if (!this.config.access) { ws.close(1008, 'Authentication unavailable'); return; }
      let busy = false;
      let lease: ReturnType<typeof setTimeout> | undefined;
      const deadline = setTimeout(() => ws.close(1008, 'Authentication required'), 10_000);
      deadline.unref();
      ws.on('error', () => {}); // Never log input or credentials.
      ws.on('close', () => { clearTimeout(deadline); clearTimeout(lease); this.contexts.delete(ws); this.webSessions.delete(ws); });
      const handshake = async (raw: WebSocket.RawData) => {
        if (busy) { ws.close(1008, 'Authentication pending'); return; }
        busy = true;
        try {
          if (raw.toString().length > 20 * 1024) throw new Error('Invalid authentication');
          const data = JSON.parse(raw.toString());
          if (data?.type !== 'auth:check') throw new Error('Authentication required');
          const verified = await this.config.access!.authenticate(data.idToken);
          requireCapability(verified, 'console:access');
          if (ws.readyState !== WebSocket.OPEN) return;
          const context = Object.freeze({ ...verified, expiresAtMs: Math.min(verified.expiresAtMs,
            Date.now() + Math.min(this.config.authorizationLeaseMs ?? 60_000, 60_000)) });
          this.contexts.set(ws, context);
          this.pendingOutput.set(ws, []);
          clearTimeout(deadline);
          lease = setTimeout(() => ws.close(1008, 'Authorization lease expired'), Math.max(0, context.expiresAtMs - Date.now()));
          lease.unref();
          await handler(ws, context);
          requireCapability(context, 'console:access');
          ws.off('message', handshake);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'auth:ready', requestId: context.requestId }));
          const buffered = this.pendingOutput.get(ws) ?? [];
          this.pendingOutput.delete(ws);
          for (const item of buffered) this.sendTo(ws, item);
        } catch {
          this.contexts.delete(ws);
          this.activeConnections.delete(ws);
          ws.close(1008, 'Access denied');
        }
      };
      ws.on('message', handshake);
    });
  }
  protected onMessage(ws: WebSocket, handler: (message: WebSocket.RawData) => void | Promise<void>): void {
    ws.on('message', raw => {
      void (async () => {
        requireCapability(this.contexts.get(ws), 'console:access');
        if (this.pendingOutput.has(ws)) throw new Error('Authentication pending');
        const data = JSON.parse(raw.toString());
        if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.type !== 'string') throw new Error('Invalid message');
        if (data.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
        if (data.type.startsWith('auth:')) throw new Error('Unexpected authentication');
        await handler(raw);
      })().catch(() => ws.close(1008, 'Invalid operation'));
    });
  }
  protected getContext(ws: WebSocket): RequestContext {
    const context = this.contexts.get(ws);
    requireCapability(context, 'console:access');
    return context;
  }
  protected sendTo(ws: WebSocket, data: unknown): void {
    if (this.config.access) {
      try { requireCapability(this.contexts.get(ws), 'console:access'); } catch { return; }
    }
    const pending = this.pendingOutput.get(ws);
    if (pending) { if (pending.length < 256) pending.push(data); return; }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }
  protected bindWebSession(ws: WebSocket, sessionId: string): void {
    const trimmed = sessionId.trim();
    if (!trimmed) throw new Error('Invalid web session');
    this.webSessions.set(ws, trimmed);
  }
  protected getWebSessionId(ws: WebSocket): string | undefined {
    return this.webSessions.get(ws);
  }
  protected broadcastWebPayload(payload: { sessionId?: string }, message: unknown): void {
    for (const ws of this.activeConnections) {
      if (shouldDeliverWebNotification(payload, this.getWebSessionId(ws))) this.sendTo(ws, message);
    }
  }
  public broadcast(data: unknown): void {
    for (const ws of this.activeConnections) {
      this.sendTo(ws, data);
    }
  }
  protected abstract initialize(): void;
}
