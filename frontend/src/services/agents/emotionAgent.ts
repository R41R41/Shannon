import { EmotionType } from "@common/types/taskGraph";
import { WebSocketClientBase } from "../common/WebSocketClient";
import { parseMessage } from "../common/messageSchema";
import { URLS } from "../config/ports";

type UpdateEmotionCallback = (emotion: EmotionType) => void;

export class EmotionAgent extends WebSocketClientBase {
  private static instance: EmotionAgent;

  public static getInstance() {
    if (!EmotionAgent.instance) {
      EmotionAgent.instance = new EmotionAgent(URLS.WEBSOCKET.EMOTION);
    }
    return EmotionAgent.instance;
  }

  private constructor(url: string) {
    super(url);
  }

  protected handleMessage(message: string) {
    const data = parseMessage(message);
    if (!data || data.type === "pong") return;
    if (data.type === "web:emotion") {
      this.emit("emotion", data.data as EmotionType);
    }
  }

  public onUpdateEmotion(callback: UpdateEmotionCallback): () => void {
    return this.on("emotion", callback);
  }
}
