import { exec } from 'child_process';
import http from 'http';
import { promisify } from 'util';
import WebSocket, { WebSocketServer } from 'ws';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

export interface WebSocketServiceConfig {
  port?: number;
  server?: http.Server;
  serviceName: string;
}

export abstract class WebSocketServiceBase {
  protected wss!: WebSocketServer;
  protected serviceName: string;
  private isInitialized = false;
  protected activeConnections = new Set<WebSocket>();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private static PING_INTERVAL_MS = 30_000; // 30秒ごとにping

  constructor(config: WebSocketServiceConfig) {
    this.serviceName = config.serviceName;
    if (config.server) {
      this.wss = new WebSocketServer({ server: config.server });
      logger.info(`WebSocketServer created with existing server for service ${this.serviceName}`);
    } else if (config.port) {
      this.wss = new WebSocketServer({ port: config.port });
      logger.debug(`WebSocketServer created on port ${config.port} for service ${this.serviceName}`);
    } else {
      throw new Error('Invalid configuration');
    }

    this.wss.on('error', (error) => {
      logger.error(`WebSocket server error for ${this.serviceName}:`, error);
    });

    this.startPingLoop();
  }

  public start() {
    if (!this.isInitialized) {
      this.initialize();
      this.isInitialized = true;
    }
  }

  /** Type-safe accessor for the __isAlive flag on WebSocket instances */
  private getIsAlive(ws: WebSocket): boolean {
    return (ws as WebSocket & { __isAlive?: boolean }).__isAlive ?? false;
  }
  private setIsAlive(ws: WebSocket, value: boolean): void {
    (ws as WebSocket & { __isAlive?: boolean }).__isAlive = value;
  }

  private startPingLoop() {
    this.pingInterval = setInterval(() => {
      this.activeConnections.forEach((ws) => {
        if (this.getIsAlive(ws) === false) {
          ws.terminate();
          this.activeConnections.delete(ws);
          return;
        }
        this.setIsAlive(ws, false);
        ws.ping();
      });
    }, WebSocketServiceBase.PING_INTERVAL_MS);
  }

  protected handleNewConnection(ws: WebSocket) {
    this.activeConnections.forEach((connection) => {
      try {
        connection.close();
      } catch (error) {
        logger.error(`Error closing connection: ${error}`);
      }
    });
    this.activeConnections.clear();

    this.setIsAlive(ws, true);
    ws.on('pong', () => { this.setIsAlive(ws, true); });

    this.activeConnections.add(ws);

    ws.on('close', () => {
      this.activeConnections.delete(ws);
    });
  }

  public broadcast(data: unknown) {
    this.activeConnections.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  }

  protected abstract initialize(): void;
}
