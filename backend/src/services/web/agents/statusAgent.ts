import {
  ServiceCommand,
  StatusAgentOutput,
} from '@shannon/common';
import {
  WebSocketServiceBase,
  WebSocketServiceConfig,
} from '../../common/WebSocketService.js';
import { dispatchServiceCommand } from '../../runtime/serviceCommandRegistry.js';
import { logger } from '../../../utils/logger.js';
import { getWebNotificationHub } from '../webNotificationHub.js';

export class StatusAgent extends WebSocketServiceBase {
  private static instance: StatusAgent;
  private hubUnsubscribe: (() => void) | null = null;

  private constructor(config: WebSocketServiceConfig) {
    super(config);

    this.hubUnsubscribe = getWebNotificationHub().onStatus((data) => {
      if (!('service' in data)) return;
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
          const command = data.command as ServiceCommand;
          if (data.service === 'minebot:bot') {
            const serverName = data.serverName ? data.serverName : null;
            await dispatchServiceCommand(service, command, serverName);
          } else {
            const serverName = data.service ? data.service : null;
            await dispatchServiceCommand(service, command, serverName);
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
