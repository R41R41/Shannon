import type http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { logger } from '../../utils/logger.js';

export interface WebSocketServiceConfig {
  port?: number;
  host?: string;
  server?: http.Server;
  serviceName: string;
  maxPayload?: number;
  /** Legacy services remain single-client until request-scoped routing is implemented. */
  singleConnection?: boolean;
}
export abstract class WebSocketServiceBase {
  protected wss!: WebSocketServer;
  protected serviceName: string;
  private isInitialized = false;
  protected activeConnections = new Set<WebSocket>();
  private readonly alive = new WeakSet<WebSocket>();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private stopping: Promise<void> | null = null;

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
    this.wss = new WebSocketServer({ ...options, ...(this.config.maxPayload === undefined ? {} : { maxPayload: this.config.maxPayload }) });
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
    if (this.config.singleConnection !== false) {
      for (const previous of this.activeConnections) previous.close();
      this.activeConnections.clear();
    }
    this.alive.add(ws);
    ws.on('pong', () => { this.alive.add(ws); });
    this.activeConnections.add(ws);
    ws.on('close', () => { this.activeConnections.delete(ws); });
  }
  public broadcast(data: unknown): void {
    for (const ws of this.activeConnections) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    }
  }
  protected abstract initialize(): void;
}
