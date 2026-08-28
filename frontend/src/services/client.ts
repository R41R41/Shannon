import { auth } from '../firebase';
import { MonitoringAgent } from "./agents/monitoringAgent";
import { OpenAIAgent } from "./agents/openaiAgent";
import { SchedulerAgent } from "./agents/schedulerAgent";
import { StatusAgent } from "./agents/statusAgent";
import { PlanningAgent } from "./agents/planningAgent";
import { EmotionAgent } from "./agents/emotionAgent";
import { SkillAgent } from "./agents/skillAgent";

export class WebClient {
  private static instance: WebClient;
  private connected: boolean = false;
  public openaiService: OpenAIAgent;
  public monitoringService: MonitoringAgent;
  public schedulerService: SchedulerAgent;
  public statusService: StatusAgent;
  public planningService: PlanningAgent;
  public emotionService: EmotionAgent;
  public skillService: SkillAgent;

  public static getInstance() {
    if (!WebClient.instance) {
      WebClient.instance = new WebClient();
    }
    return WebClient.instance;
  }

  private constructor() {
    this.openaiService = OpenAIAgent.getInstance();
    this.monitoringService = MonitoringAgent.getInstance();
    this.schedulerService = SchedulerAgent.getInstance();
    this.statusService = StatusAgent.getInstance();
    this.planningService = PlanningAgent.getInstance();
    this.emotionService = EmotionAgent.getInstance();
    this.skillService = SkillAgent.getInstance();
    const getToken = async () => {
      const user = auth.currentUser;
      if (!user) throw new Error('Login required');
      const token = await user.getIdToken();
      if (auth.currentUser?.uid !== user.uid) throw new Error('Session changed');
      return token;
    };
    for (const service of [this.openaiService, this.monitoringService, this.schedulerService,
      this.statusService, this.planningService, this.emotionService, this.skillService]) service.setTokenProvider(getToken);

  }

  public isConnected(): boolean {
    return this.connected;
  }

  public start() {
    if (this.connected) return;

    this.disconnect();

    this.openaiService.connect();
    this.monitoringService.connect();
    this.schedulerService.connect();
    this.statusService.connect();
    this.planningService.connect();
    this.emotionService.connect();
    this.skillService.connect();

    this.connected = true;
  }

  public disconnect() {
    if (!this.connected) return;

    this.openaiService.disconnect();
    this.monitoringService.disconnect();
    this.schedulerService.disconnect();
    this.statusService.disconnect();
    this.planningService.disconnect();
    this.emotionService.disconnect();
    this.skillService.disconnect();

    this.connected = false;
  }
}
