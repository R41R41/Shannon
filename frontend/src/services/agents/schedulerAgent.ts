import { WebSocketClientBase } from "../common/WebSocketClient";
import { parseMessage } from "../common/messageSchema";
import { Schedule } from "@common/types/scheduler";
import { WebScheduleInput } from "@common/types/web";
import { URLS } from "../config/ports";

type ScheduleCallback = (schedules: Schedule[]) => void;

export class SchedulerAgent extends WebSocketClientBase {
  private static instance: SchedulerAgent;

  public static getInstance() {
    if (!SchedulerAgent.instance) {
      SchedulerAgent.instance = new SchedulerAgent(URLS.WEBSOCKET.SCHEDULER);
    }
    return SchedulerAgent.instance;
  }

  private constructor(url: string) {
    super(url);
  }

  protected handleMessage(message: string) {
    const data = parseMessage(message);
    if (!data || data.type === "pong") return;
    if (data.type === "post_schedule") {
      this.emit("schedules", data.data as Schedule[]);
    }
  }

  public async getSchedules(): Promise<void> {
    this.send(JSON.stringify({ type: "get_schedule" }));
  }

  public async callSchedule(name: string): Promise<void> {
    this.send(
      JSON.stringify({ type: "call_schedule", name } as WebScheduleInput)
    );
  }

  public onSchedules(callback: ScheduleCallback): () => void {
    return this.on("schedules", callback);
  }

  public async getAllSchedules(): Promise<Schedule[]> {
    return new Promise((resolve) => {
      const unsubscribe = this.on("schedules", (schedules: Schedule[]) => {
        unsubscribe();
        resolve(schedules);
      });

      this.send(JSON.stringify({ type: "get_schedule" }));
    });
  }
}
