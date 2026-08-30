import {
  WebSocketServiceBase,
  WebSocketServiceConfig,
} from '../../common/WebSocketService.js';
import { requestSkillList } from '../../runtime/skillListRegistry.js';
import { logger } from '../../../utils/logger.js';
import { getWebNotificationHub } from '../webNotificationHub.js';

export class SkillAgent extends WebSocketServiceBase {
  private static instance: SkillAgent;
  private hubUnsubscribe: (() => void) | null = null;

  private constructor(config: WebSocketServiceConfig) {
    super(config);

    this.hubUnsubscribe = getWebNotificationHub().onSkill((data) => {
      this.broadcast({
        type: 'web:skill',
        data,
      });
    });
  }

  public disconnect() {
    this.hubUnsubscribe?.();
    this.hubUnsubscribe = null;
  }

  public static getInstance(config: WebSocketServiceConfig): SkillAgent {
    if (!SkillAgent.instance) {
      SkillAgent.instance = new SkillAgent(config);
    }
    return SkillAgent.instance;
  }
  protected override initialize() {
    this.onAuthenticatedConnection(async (ws) => {
      logger.debug('Skill client connected');

      this.handleNewConnection(ws);

      ws.on('close', () => {
        logger.debug('Skill client disconnected');
      });

      this.onMessage(ws, async (message) => {
        const data = JSON.parse(message.toString());

        if (data.type === 'ping') {
          this.broadcast({ type: 'pong' });
          return;
        }

        if (data.type === 'get_skills') {
          requestSkillList();
        }
      });

      ws.on('close', () => {
        logger.debug('Skill Client disconnected');
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
      });
    });

    logger.debug('SkillAgent subscribe');
  }

  public start() {
    super.start();
  }
}
