import { ServiceStatus } from "@common/types/common";
import { StatusAgentOutput } from "@common/types/web";
import { WebSocketClientBase } from "../common/WebSocketClient";
import { URLS } from "../config/ports";

type StatusCallback = (status: ServiceStatus) => void;

export class StatusAgent extends WebSocketClientBase {
  private static instance: StatusAgent;

  public static getInstance() {
    if (!StatusAgent.instance) {
      StatusAgent.instance = new StatusAgent(URLS.WEBSOCKET.STATUS);
    }
    return StatusAgent.instance;
  }

  protected handleMessage(message: string) {
    const data = JSON.parse(message) as StatusAgentOutput;
    if (!data || data.type === "pong") return;

    if (data.data) {
      this.emit(`service:${data.service}`, data.data);
    }
  }

  public onServiceStatus(service: string, callback: StatusCallback): () => void {
    return this.on(`service:${service}`, callback);
  }

  public async getStatusService(service: string) {
    this.send(
      JSON.stringify({
        type: `service:command`,
        command: "status",
        service,
      })
    );
  }

  public async startService(
    service: string,
    options?: { serverName?: string }
  ) {
    this.send(
      JSON.stringify({
        type: `service:command`,
        command: "start",
        service,
        ...options,
      })
    );
  }

  public async stopService(service: string) {
    this.send(
      JSON.stringify({
        type: `service:command`,
        command: "stop",
        service,
      })
    );
  }
}
