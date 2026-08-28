import type { AccessService } from '../../modules/access/index.js';
import { PORTS } from '../../config/ports.js';
import { MonitoringAgent } from './agents/monitoringAgent.js';
import { OpenAIClientService } from './agents/openaiAgent.js';
import { ScheduleAgent } from './agents/scheduleAgent.js';
import { StatusAgent } from './agents/statusAgent.js';
import { PlanningAgent } from './agents/planningAgent.js';
import { EmotionAgent } from './agents/emotionAgent.js';
import { SkillAgent } from './agents/skillAgent.js';
import { AuthAgent } from './agents/authAgent.js';
export class WebClient {
  private static instance: WebClient;
  private openaiService: OpenAIClientService;
  private monitoringService: MonitoringAgent;
  private scheduleService: ScheduleAgent;
  private statusService: StatusAgent;
  private planningService: PlanningAgent;
  private emotionService: EmotionAgent;
  private skillService: SkillAgent;
  private authService: AuthAgent;

  constructor(isTest: boolean, access: AccessService) {
    this.openaiService = OpenAIClientService.getInstance({
      port: isTest
        ? Number(PORTS.WEBSOCKET.OPENAI) + 10000
        : Number(PORTS.WEBSOCKET.OPENAI),
      serviceName: 'openai',
    });

    this.monitoringService = MonitoringAgent.getInstance({
      port: isTest
        ? Number(PORTS.WEBSOCKET.MONITORING) + 10000
        : Number(PORTS.WEBSOCKET.MONITORING),
      serviceName: 'monitoring',
    });

    this.statusService = StatusAgent.getInstance({
      port: isTest
        ? Number(PORTS.WEBSOCKET.STATUS) + 10000
        : Number(PORTS.WEBSOCKET.STATUS),
      serviceName: 'status',
    });

    this.scheduleService = ScheduleAgent.getInstance({
      port: isTest
        ? Number(PORTS.WEBSOCKET.SCHEDULE) + 10000
        : Number(PORTS.WEBSOCKET.SCHEDULE),
      serviceName: 'schedule',
    });

    this.planningService = PlanningAgent.getInstance({
      port: isTest
        ? Number(PORTS.WEBSOCKET.PLANNING) + 10000
        : Number(PORTS.WEBSOCKET.PLANNING),
      serviceName: 'planning',
    });

    this.emotionService = EmotionAgent.getInstance({
      port: isTest
        ? Number(PORTS.WEBSOCKET.EMOTION) + 10000
        : Number(PORTS.WEBSOCKET.EMOTION),
      serviceName: 'emotion',
    });

    this.skillService = SkillAgent.getInstance({
      port: isTest
        ? Number(PORTS.WEBSOCKET.SKILL) + 10000
        : Number(PORTS.WEBSOCKET.SKILL),
      serviceName: 'skill',
    });

    this.authService = AuthAgent.getInstance({
      port: isTest
        ? Number(PORTS.WEBSOCKET.AUTH) + 10000
        : Number(PORTS.WEBSOCKET.AUTH),
      serviceName: 'auth',
    }, access);
  }

  public static getInstance(isTest: boolean, access: AccessService): WebClient {
    if (!WebClient.instance) {
      WebClient.instance = new WebClient(isTest, access);
    }
    return WebClient.instance;
  }

  public async stop(): Promise<void> {
    const services = [this.openaiService, this.monitoringService, this.statusService,
      this.scheduleService, this.planningService, this.emotionService, this.skillService];
    for (const service of services) service.disconnect();
    await Promise.all([...services, this.authService].map(service => service.stop()));
  }

  public start() {
    this.openaiService.start();
    this.monitoringService.start();
    this.statusService.start();
    this.scheduleService.start();
    this.planningService.start();
    this.emotionService.start();
    this.skillService.start();
    this.authService.start();
  }
}
