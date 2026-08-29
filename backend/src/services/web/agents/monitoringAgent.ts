import { ILog, MemoryZone, WebMonitoringOutput } from '@shannon/common';
import Log from '../../../models/Log.js';
import {
  WebSocketServiceBase,
  WebSocketServiceConfig,
} from '../../common/WebSocketService.js';
import { logger } from '../../../utils/logger.js';
import { getWebNotificationHub } from '../webNotificationHub.js';

interface SearchQuery {
  startDate?: string;
  endDate?: string;
  memoryZone?: MemoryZone;
  content?: string;
}

export class MonitoringAgent extends WebSocketServiceBase {
  private static instance: MonitoringAgent;
  private unsubscribeLog: (() => void) | null = null;

  private constructor(config: WebSocketServiceConfig) {
    super(config);
    this.unsubscribeLog = getWebNotificationHub().onLog((entry) => {
      this.broadcast({ type: 'web:log', data: entry } as WebMonitoringOutput);
    });
  }

  public static getInstance(config: WebSocketServiceConfig): MonitoringAgent {
    if (!MonitoringAgent.instance) {
      MonitoringAgent.instance = new MonitoringAgent(config);
    }
    return MonitoringAgent.instance;
  }

  protected override initialize() {
    this.onAuthenticatedConnection( async (ws) => {
      logger.debug('Monitoring client connected');
      this.handleNewConnection(ws);
      ws.on('close', () => { logger.debug('Monitoring client disconnected'); });

      const logs = await Log.find().sort({ timestamp: -1 }).limit(200);
      const sortedLogs = logs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      sortedLogs.forEach((log) => {
        this.sendTo(ws, { type: 'web:log', data: log } as WebMonitoringOutput);
      });

      this.onMessage(ws, async (message) => {
        const data = JSON.parse(message.toString());
        if (data.type === 'ping') {
          this.broadcast({ type: 'pong' } as WebMonitoringOutput);
          return;
        }
        if (data.type === 'search') {
          const query = data.query as SearchQuery;
          const searchResults = await this.searchLogs(query);
          this.sendTo(ws, { type: 'web:searchResults', data: searchResults as ILog[] } as WebMonitoringOutput);
        }
      });
    });
  }

  private async searchLogs(query: SearchQuery) {
    const filter: Record<string, unknown> = {};
    if (query.startDate && query.endDate) {
      filter.timestamp = { $gte: new Date(query.startDate), $lte: new Date(query.endDate) };
    }
    if (query.memoryZone) filter.memoryZone = query.memoryZone;
    if (query.content) filter.content = { $regex: query.content, $options: 'i' };
    return await Log.find(filter).sort({ timestamp: -1 }).limit(200).lean();
  }

  public disconnect() {
    this.unsubscribeLog?.();
    this.unsubscribeLog = null;
  }
}
