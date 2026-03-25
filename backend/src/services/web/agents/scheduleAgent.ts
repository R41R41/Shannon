import {
  SchedulerInput,
  SchedulerOutput,
  WebScheduleOutput,
} from '@shannon/common';
import {
  WebSocketServiceBase,
  WebSocketServiceConfig,
} from '../../common/WebSocketService.js';
import { EventBus } from '../../eventBus/eventBus.js';
import { getEventBus } from '../../eventBus/index.js';
import { logger } from '../../../utils/logger.js';

export class ScheduleAgent extends WebSocketServiceBase {
  private static instance: ScheduleAgent;
  private eventBus: EventBus;
  private messageSubscription: (() => void) | null = null;

  private constructor(config: WebSocketServiceConfig) {
    super(config);
    this.eventBus = getEventBus();

    this.messageSubscription = this.eventBus.subscribe(
      'web:post_schedule',
      (event) => {
        const data = event.data as SchedulerOutput;
        if (data.type === 'post_schedule') {
          this.broadcast({
            type: 'post_schedule',
            data: data.data,
          } as WebScheduleOutput);
        }
      }
    );
  }

  public static getInstance(config: WebSocketServiceConfig): ScheduleAgent {
    if (!ScheduleAgent.instance) {
      ScheduleAgent.instance = new ScheduleAgent(config);
    }
    return ScheduleAgent.instance;
  }

  protected override initialize() {
    this.wss.on('connection', async (ws) => {
      logger.debug('Schedule client connected');

      this.handleNewConnection(ws);

      ws.on('close', () => {
        logger.debug('Schedule client disconnected');
      });

      ws.on('message', async (message) => {
        const data = JSON.parse(message.toString());

        if (data.type === 'ping') {
          this.broadcast({ type: 'pong' } as WebScheduleOutput);
          return;
        }
        logger.info(
          `valid web message received in schedule agent: ${JSON.stringify(
            data
          )}`,
          'blue',
        );
        if (data.type === 'get_schedule') {
          const name = data.name as string;
          this.eventBus.publish({
            type: 'scheduler:get_schedule',
            memoryZone: 'web',
            data: { type: 'get_schedule', name } as SchedulerInput,
          });
        }

        if (data.type === 'call_schedule') {
          logger.info(`calling schedule ${data.name}`);
          const name = data.name as string;
          this.eventBus.publish({
            type: 'scheduler:call_schedule',
            memoryZone: 'web',
            data: { type: 'call_schedule', name } as SchedulerInput,
          });
        }
      });

      ws.on('close', () => {
        logger.debug('Monitoring Client disconnected');
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
      });
    });
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
