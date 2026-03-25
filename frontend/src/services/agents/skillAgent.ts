import { WebSocketClientBase } from "../common/WebSocketClient";
import { parseMessage } from "../common/messageSchema";
import { URLS } from "../config/ports";
import { SkillInfo } from "@common/types/llm";

type UpdateSkillsCallback = (skills: SkillInfo[]) => void;

export class SkillAgent extends WebSocketClientBase {
  private static instance: SkillAgent;

  public static getInstance() {
    if (!SkillAgent.instance) {
      SkillAgent.instance = new SkillAgent(URLS.WEBSOCKET.SKILL);
    }
    return SkillAgent.instance;
  }

  private constructor(url: string) {
    super(url);
  }

  protected handleMessage(message: string) {
    const data = parseMessage(message);
    if (!data || data.type === "pong") return;
    if (data.type === "web:skill") {
      this.emit("skills", data.data as SkillInfo[]);
    }
  }

  public async getSkills(): Promise<void> {
    this.send(JSON.stringify({ type: "get_skills" }));
  }

  public onUpdateSkills(callback: UpdateSkillsCallback): () => void {
    return this.on("skills", callback);
  }
}
