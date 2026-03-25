import { EmotionType } from '@shannon/common';
import {
  WebSocketServiceBase,
  WebSocketServiceConfig,
} from '../../common/WebSocketService.js';
import { EventBus } from '../../eventBus/eventBus.js';
import { getEventBus } from '../../eventBus/index.js';
import { logger } from '../../../utils/logger.js';

export class EmotionAgent extends WebSocketServiceBase {
  private static instance: EmotionAgent;
  private eventBus: EventBus;
  private messageSubscription: (() => void) | null = null;

  private constructor(config: WebSocketServiceConfig) {
    super(config);
    this.eventBus = getEventBus();

    this.messageSubscription = this.eventBus.subscribe(
      'web:emotion',
      (event) => {
        const data = event.data as EmotionType;
        this.broadcast({
          type: 'web:emotion',
          data: data,
        });
      }
    );
  }

  public static getInstance(config: WebSocketServiceConfig): EmotionAgent {
    if (!EmotionAgent.instance) {
      EmotionAgent.instance = new EmotionAgent(config);
    }
    return EmotionAgent.instance;
  }

  protected override initialize() {
    this.wss.on('connection', async (ws) => {
      logger.debug('Emotion client connected');

      this.handleNewConnection(ws);

      ws.on('close', () => {
        logger.debug('Emotion client disconnected');
      });

      ws.on('message', async (message) => {
        const data = JSON.parse(message.toString());

        if (data.type === 'ping') {
          this.broadcast({ type: 'pong' });
          return;
        }
      });

      ws.on('close', () => {
        logger.debug('Emotion Client disconnected');
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
      });
    });

    logger.debug('EmotionAgent subscribe');
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
