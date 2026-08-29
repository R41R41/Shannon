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
import { getEventBus } from '../../eventBus/index.js';
import { logger } from '../../../utils/logger.js';
import { getWebNotificationHub } from '../webNotificationHub.js';

export class StatusAgent extends WebSocketServiceBase {
  private static instance: StatusAgent;
  private hubUnsubscribe: (() => void) | null = null;

  private constructor(config: WebSocketServiceConfig) {
    super(config);

    this.hubUnsubscribe = getWebNotificationHub().onStatus((data) => {
      this.broadcast({
        type: 'service:status',
        service: data.service,
        data: data.status,
      } as StatusAgentOutput);
    });
  }

  public static getInstance(config: WebSocketServiceConfig): StatusAgent {
    if (!StatusAgent.instance) {
      StatusAgent.instance = new StatusAgent(config);
    }
    return StatusAgent.instance;
  }

  protected override initialize() {
    const eventBus = getEventBus();
    this.onAuthenticatedConnection((ws) => {
      logger.debug('Status client connected');

      this.handleNewConnection(ws);

      ws.on('close', () => {
        logger.debug('Status client disconnected');
      });

      this.onMessage(ws, async (message) => {
        const data = JSON.parse(message.toString());
        if (data.type === 'service:command') {
          const service = data.service;
          const command = data.command;
          if (data.service === 'minebot:bot') {
            const serverName = data.serverName ? data.serverName : null;
            eventBus.publish({
              type: `${service}:status` as EventType,
              memoryZone: 'web',
              data: {
                serviceCommand: command as ServiceCommand,
                serverName,
              } as ServiceInput,
            });
          } else {
            const serverName = data.service ? data.service : null;
            eventBus.publish({
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
    this.hubUnsubscribe?.();
    this.hubUnsubscribe = null;
  }
}
