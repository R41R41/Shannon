import { ILog, MemoryZone, WebMonitoringOutput } from '@shannon/common';
import type { WebSocket } from 'ws';
import Log from '../../../models/Log.js';
import {
  WebSocketServiceBase,
  WebSocketServiceConfig,
} from '../../common/WebSocketService.js';
import { logger } from '../../../utils/logger.js';
import { getWebNotificationHub } from '../webNotificationHub.js';
import { shouldDeliverWebLog, webLogHistoryFilter } from '../webNotificationBridge.js';

interface SearchQuery {
  startDate?: string;
  endDate?: string;
  memoryZone?: MemoryZone;
  content?: string;
  sessionId?: string;
}

export class MonitoringAgent extends WebSocketServiceBase {
  private static instance: MonitoringAgent;
  private unsubscribeLog: (() => void) | null = null;

  private constructor(config: WebSocketServiceConfig) {
    super(config);
    this.unsubscribeLog = getWebNotificationHub().onLog((entry) => {
      this.broadcastWebLog(entry, { type: 'web:log', data: entry } as WebMonitoringOutput);
    });
  }

  public static getInstance(config: WebSocketServiceConfig): MonitoringAgent {
    if (!MonitoringAgent.instance) {
      MonitoringAgent.instance = new MonitoringAgent(config);
    }
    return MonitoringAgent.instance;
  }

  protected override initialize() {
    this.onAuthenticatedConnection(async (ws) => {
      logger.debug('Monitoring client connected');
      this.handleNewConnection(ws);
      ws.on('close', () => { logger.debug('Monitoring client disconnected'); });

      this.onMessage(ws, async (message) => {
        const data = JSON.parse(message.toString());
        if (data.type === 'ping') {
          this.broadcast({ type: 'pong' } as WebMonitoringOutput);
          return;
        }
        if (data.type === 'web:bind-session' && typeof data.sessionId === 'string') {
          this.bindWebSession(ws, data.sessionId);
          await this.sendSessionHistory(ws, data.sessionId);
          return;
        }
        if (data.type === 'search') {
          const query = data.query as SearchQuery;
          const searchResults = await this.searchLogs(query, this.getWebSessionId(ws));
          this.sendTo(ws, { type: 'web:searchResults', data: searchResults as ILog[] } as WebMonitoringOutput);
        }
      });
    });
  }

  protected broadcastWebLog(entry: ILog, message: unknown): void {
    for (const ws of this.activeConnections) {
      if (shouldDeliverWebLog(entry, this.getWebSessionId(ws))) this.sendTo(ws, message);
    }
  }

  private async sendSessionHistory(ws: WebSocket, sessionId: string): Promise<void> {
    const logs = await Log.find(webLogHistoryFilter(sessionId)).sort({ timestamp: -1 }).limit(200);
    const sortedLogs = logs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    for (const log of sortedLogs) {
      if (shouldDeliverWebLog(log, sessionId)) {
        this.sendTo(ws, { type: 'web:log', data: log } as WebMonitoringOutput);
      }
    }
  }

  private async searchLogs(query: SearchQuery, connectionSessionId?: string) {
    const filter: Record<string, unknown> = {};
    if (query.startDate && query.endDate) {
      filter.timestamp = { $gte: new Date(query.startDate), $lte: new Date(query.endDate) };
    }
    if (query.memoryZone) filter.memoryZone = query.memoryZone;
    if (query.content) filter.content = { $regex: query.content, $options: 'i' };
    if (connectionSessionId) Object.assign(filter, webLogHistoryFilter(connectionSessionId));
    return await Log.find(filter).sort({ timestamp: -1 }).limit(200).lean();
  }

  public disconnect() {
    this.unsubscribeLog?.();
    this.unsubscribeLog = null;
  }
}
