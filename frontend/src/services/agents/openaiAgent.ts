import { OpenAIMessageOutput } from "@common/types/web";
import { WebSocketClientBase } from "../common/WebSocketClient";
import { URLS } from "../config/ports";
import { BaseMessage } from "@langchain/core/messages";

export class OpenAIAgent extends WebSocketClientBase {
  private static instance: OpenAIAgent;

  public static getInstance() {
    if (!OpenAIAgent.instance) {
      OpenAIAgent.instance = new OpenAIAgent(URLS.WEBSOCKET.OPENAI);
    }
    return OpenAIAgent.instance;
  }

  private constructor(url: string) {
    super(url);
  }

  protected handleMessage(message: string) {
    const data = JSON.parse(message) as OpenAIMessageOutput;
    if (data.type === "pong") {
      return;
    }
    if (data.type === "command" && data.command === "text_done") {
      this.emit("textDone");
    } else if (data.type === "command" && data.command === "audio_done") {
      this.emit("audioDone");
    } else if (data.type === "text" && data.text) {
      this.emit("text", data.text);
      this.emit("textDone");
    } else if (data.type === "realtime_text" && data.realtime_text) {
      this.emit("text", data.realtime_text);
    } else if (data.type === "realtime_audio" && data.realtime_audio) {
      console.log(`Received audio data: ${data.realtime_audio.length} bytes`);
      this.emit("audio", data.realtime_audio);
    } else if (data.type === "user_transcript" && data.realtime_text) {
      this.emit("userTranscript", data.realtime_text);
    }
  }

  public onText(callback: (text: string) => void): () => void {
    return this.on("text", callback);
  }

  public onTextDone(callback: () => void): () => void {
    return this.on("textDone", callback);
  }

  public onAudio(callback: (data: string) => void): () => void {
    return this.on("audio", callback);
  }

  public onAudioDone(callback: () => void): () => void {
    return this.on("audioDone", callback);
  }

  public onUserTranscript(callback: (text: string) => void): () => void {
    return this.on("userTranscript", callback);
  }

  async sendMessage(
    name: string,
    message: string,
    isRealTimeChat: boolean,
    recentChatLog?: BaseMessage[]
  ) {
    try {
      let messageData: string;
      if (isRealTimeChat) {
        messageData = JSON.stringify({
          type: "realtime_text",
          realtime_text: message,
        });
      } else {
        messageData = JSON.stringify({
          type: "text",
          text: message,
          senderName: name,
          recentChatLog: recentChatLog,
        });
      }
      this.send(messageData);
    } catch (error) {
      console.error("Error sending message:", error);
      throw error;
    }
  }

  async sendVoiceData(data: Blob) {
    try {
      const arrayBuffer = await data.arrayBuffer();
      const base64String = btoa(
        String.fromCharCode(...new Uint8Array(arrayBuffer))
      );
      const messageData = JSON.stringify({
        type: "realtime_audio",
        realtime_audio: base64String,
      });
      console.log("\x1b[32msendVoiceData\x1b[0m", base64String.length);
      this.send(messageData);
    } catch (error) {
      console.error("Error sending voice data:", error);
      throw error;
    }
  }

  async commitAudioBuffer() {
    try {
      const messageData = JSON.stringify({
        type: "realtime_audio",
        command: "realtime_audio_commit",
      });
      console.log("\x1b[32mcommitAudioBuffer\x1b[0m");
      this.send(messageData);
    } catch (error) {
      console.error("Error committing audio buffer:", error);
      throw error;
    }
  }

  async vadModeChange(data: boolean) {
    try {
      const messageData = JSON.stringify({
        type: "command",
        command: data ? "realtime_vad_on" : "realtime_vad_off",
      });
      console.log("\x1b[32mvadModeChange\x1b[0m", messageData);
      this.send(messageData);
    } catch (error) {
      console.error("Error changing VAD mode:", error);
      throw error;
    }
  }
}
