import { TaskTreeState } from '@shannon/common';
import {
  WebSocketServiceBase,
  WebSocketServiceConfig,
} from '../../common/WebSocketService.js';
import { EventBus } from '../../eventBus/eventBus.js';
import { getEventBus } from '../../eventBus/index.js';
import { logger } from '../../../utils/logger.js';

export class PlanningAgent extends WebSocketServiceBase {
  private static instance: PlanningAgent;
  private eventBus: EventBus;
  private messageSubscription: (() => void) | null = null;

  private constructor(config: WebSocketServiceConfig) {
    super(config);
    this.eventBus = getEventBus();

    this.messageSubscription = this.eventBus.subscribe(
      'web:planning',
      (event) => {
        const data = event.data as TaskTreeState;
        this.broadcast({
          type: 'web:planning',
          data: data,
        });
      }
    );
  }

  public static getInstance(config: WebSocketServiceConfig): PlanningAgent {
    if (!PlanningAgent.instance) {
      PlanningAgent.instance = new PlanningAgent(config);
    }
    return PlanningAgent.instance;
  }

  protected override initialize() {
    this.wss.on('connection', async (ws) => {
      logger.debug('Planning client connected');

      this.handleNewConnection(ws);

      ws.on('close', () => {
        logger.debug('Planning client disconnected');
      });

      ws.on('message', async (message) => {
        const data = JSON.parse(message.toString());

        if (data.type === 'ping') {
          this.broadcast({ type: 'pong' });
          return;
        }
      });

      ws.on('close', () => {
        logger.debug('Planning Client disconnected');
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
      });
    });

    logger.debug('PlanningAgent subscribe');
  }

  public start() {
    super.start();
  }

  public disconnect() {
    if (this.messageSubscription) {
      this.messageSubscription();
      this.messageSubscription = null;
    }
  }
}
