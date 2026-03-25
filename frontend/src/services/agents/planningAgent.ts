import { TaskTreeState } from "@common/types/taskGraph";
import { WebSocketClientBase } from "../common/WebSocketClient";
import { parseMessage } from "../common/messageSchema";
import { URLS } from "../config/ports";

type UpdatePlanningCallback = (planning: TaskTreeState) => void;

export class PlanningAgent extends WebSocketClientBase {
  private static instance: PlanningAgent;

  public static getInstance() {
    if (!PlanningAgent.instance) {
      PlanningAgent.instance = new PlanningAgent(URLS.WEBSOCKET.PLANNING);
    }
    return PlanningAgent.instance;
  }

  private constructor(url: string) {
    super(url);
  }

  protected handleMessage(message: string) {
    const data = parseMessage(message);
    if (!data || data.type === "pong") return;
    if (data.type === "web:planning") {
      this.emit("planning", data.data as TaskTreeState);
    }
  }

  public onUpdatePlanning(callback: UpdatePlanningCallback): () => void {
    return this.on("planning", callback);
  }
}
