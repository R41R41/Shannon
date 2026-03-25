import { ILog } from "@common/types/common";
import { SearchQuery } from "@common/types/web";
import { WebSocketClientBase } from "../common/WebSocketClient";
import { parseMessage } from "../common/messageSchema";
import { URLS } from "../config/ports";

type LogCallback = (log: ILog) => void;
type SearchCallback = (results: ILog[]) => void;

export class MonitoringAgent extends WebSocketClientBase {
  private static instance: MonitoringAgent;

  public static getInstance() {
    if (!MonitoringAgent.instance) {
      MonitoringAgent.instance = new MonitoringAgent(URLS.WEBSOCKET.MONITORING);
    }
    return MonitoringAgent.instance;
  }

  private constructor(url: string) {
    super(url);
  }

  protected handleMessage(message: string) {
    const data = parseMessage(message);
    if (!data || data.type === "pong") return;
    if (data.type === "web:searchResults") {
      this.emit("searchResults", data.data as ILog[]);
    }
    if (data.type === "web:log") {
      this.emit("log", data.data as ILog);
    }
  }

  public onLog(callback: LogCallback): () => void {
    return this.on("log", callback);
  }

  public async searchLogs(query: SearchQuery) {
    this.send(
      JSON.stringify({
        type: "search",
        query,
      })
    );
  }

  public onSearchResults(callback: SearchCallback): () => void {
    return this.on("searchResults", callback);
  }

  public async getAllMemoryZoneLogs(): Promise<ILog[]> {
    return new Promise((resolve) => {
      const unsubscribe = this.on("searchResults", (logs: ILog[]) => {
        unsubscribe();
        resolve(logs);
      });

      this.send(
        JSON.stringify({
          type: "search",
          query: { memoryZone: "" },
        })
      );
    });
  }
}
