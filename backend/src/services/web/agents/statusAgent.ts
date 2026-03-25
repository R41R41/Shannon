import {
  EventType,
  ServiceCommand,
  ServiceInput,
  StatusAgentInput,
  StatusAgentOutput,
} from '@shannon/common';
import {
  WebSocketServiceBase,
  WebSocketServiceConfig,
} from '../../common/WebSocketService.js';
import { EventBus } from '../../eventBus/eventBus.js';
import { getEventBus } from '../../eventBus/index.js';
import { logger } from '../../../utils/logger.js';

export class StatusAgent extends WebSocketServiceBase {
  private static instance: StatusAgent;
  private eventBus: EventBus;
  private messageSubscription: (() => void) | null = null;

  private constructor(config: WebSocketServiceConfig) {
    super(config);
    this.eventBus = getEventBus();

    this.messageSubscription = this.eventBus.subscribe(
      'web:status',
      (event) => {
        const data = event.data as StatusAgentInput;
        this.broadcast({
          type: 'service:status',
          service: data.service,
          data: data.status,
        } as StatusAgentOutput);
      }
    );
  }

  public static getInstance(config: WebSocketServiceConfig): StatusAgent {
    if (!StatusAgent.instance) {
      StatusAgent.instance = new StatusAgent(config);
    }
    return StatusAgent.instance;
  }

  protected override initialize() {
    this.wss.on('connection', (ws) => {
      logger.debug('Status client connected');

      this.handleNewConnection(ws);

      ws.on('close', () => {
        logger.debug('Status client disconnected');
      });

      ws.on('message', async (message) => {
        const data = JSON.parse(message.toString());
        if (data.type === 'service:command') {
          const service = data.service;
          const command = data.command;
          if (data.service === 'minebot:bot') {
            const serverName = data.serverName ? data.serverName : null;
            this.eventBus.publish({
              type: `${service}:status` as EventType,
              memoryZone: 'web',
              data: {
                serviceCommand: command as ServiceCommand,
                serverName,
              } as ServiceInput,
            });
          } else {
            const serverName = data.service ? data.service : null;
            this.eventBus.publish({
              type: `${service}:status` as EventType,
              memoryZone: 'web',
              data: {
                serviceCommand: command as ServiceCommand,
                serverName,
              } as ServiceInput,
            });
          }
        }
      });
    });
  }

  public disconnect() {
    if (this.messageSubscription) {
      this.messageSubscription();
      this.messageSubscription = null;
    }
  }
}
