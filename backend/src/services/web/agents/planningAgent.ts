import { TaskTreeState } from '@shannon/common';
import {
  WebSocketServiceBase,
  WebSocketServiceConfig,
} from '../../common/WebSocketService.js';
import { logger } from '../../../utils/logger.js';
import { getWebNotificationHub } from '../webNotificationHub.js';

export class PlanningAgent extends WebSocketServiceBase {
  private static instance: PlanningAgent;
  private unsubscribePlanning: (() => void) | null = null;

  private constructor(config: WebSocketServiceConfig) {
    super(config);
    this.unsubscribePlanning = getWebNotificationHub().onPlanning((data) => {
      if (data.sessionId) return;
      this.broadcast({ type: 'web:planning', data: data as TaskTreeState });
    });
  }

  public static getInstance(config: WebSocketServiceConfig): PlanningAgent {
    if (!PlanningAgent.instance) {
      PlanningAgent.instance = new PlanningAgent(config);
    }
    return PlanningAgent.instance;
  }

  protected override initialize() {
    this.onAuthenticatedConnection(async (ws) => {
      logger.debug('Planning client connected');
      this.handleNewConnection(ws);
      ws.on('close', () => { logger.debug('Planning client disconnected'); });
      this.onMessage(ws, async (message) => {
        const data = JSON.parse(message.toString());
        if (data.type === 'ping') this.broadcast({ type: 'pong' });
      });
    });
  }

  public disconnect() {
    this.unsubscribePlanning?.();
    this.unsubscribePlanning = null;
  }
}
