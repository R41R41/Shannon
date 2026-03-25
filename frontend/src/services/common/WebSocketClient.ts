export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface ConnectionInfo {
  status: ConnectionStatus;
  reconnectAttempts: number;
  nextRetryMs: number | null;
}

export abstract class WebSocketClientBase {
  protected ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 20;
  private reconnectTimerId: number | null = null;
  private pingInterval: number | null = null;
  private lastPongReceived = 0;
  private pingTimeoutId: number | null = null;
  public status: ConnectionStatus = "disconnected";
  private statusListeners: Array<(status: ConnectionStatus) => void> = [];
  private isConnecting = false;

  /** EventEmitter-like listener store used by subclasses via on() / emit(). */
  protected listeners: Map<string, Set<Function>> = new Map();

  constructor(private url: string) {}

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  public on(event: string, callback: Function): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  /**
   * Emit an event to all registered listeners.
   */
  protected emit(event: string, ...args: any[]) {
    const set = this.listeners.get(event);
    if (set) {
      set.forEach((cb) => cb(...args));
    }
  }

  public connect() {
    if (this.isConnecting) return;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) return;
    this.isConnecting = true;

    try {
      this.ws = new WebSocket(this.url);
      this.setStatus("connecting");

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.isConnecting = false;
        this.setStatus("connected");
        this.startPing();
      };

      this.ws.onmessage = (event) => {
        this.receivePong(event.data);
        this.handleMessage(event.data);
      };

      this.ws.onclose = () => {
        this.isConnecting = false;
        this.setStatus("disconnected");
        this.reconnect();
      };

      this.ws.onerror = (error) => {
        console.error("WebSocket error:", error);
      };
    } catch (error) {
      this.isConnecting = false;
      console.error("Error creating WebSocket:", error);
    }
  }

  public send(data: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      console.warn("WebSocket is not connected. Current state:", this.status);
      if (this.status === "disconnected") {
        this.connect();
      }
    }
  }

  private startPing() {
    this.stopPing();
    this.pingInterval = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
        this.lastPongReceived = Date.now();
        this.pingTimeoutId = window.setTimeout(() => {
          if (Date.now() - this.lastPongReceived > 30000) {
            this.setStatus("disconnected");
            this.ws?.close();
          }
        }, 5000);
      }
    }, 30000);
  }

  private stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * 指数バックオフで再接続を試みる。
   * 1s → 2s → 4s → 8s → ... 最大 30s、最大 20 回まで。
   */
  private reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn(`[WS] Max reconnect attempts (${this.maxReconnectAttempts}) reached for ${this.url}`);
      this.setStatus("disconnected");
      return;
    }

    this.setStatus("connecting");
    this.reconnectAttempts++;
    const baseDelay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
    const jitter = Math.random() * 1000;
    const delay = baseDelay + jitter;

    this.reconnectTimerId = window.setTimeout(() => {
      this.reconnectTimerId = null;
      this.connect();
    }, delay);
  }

  public getConnectionInfo(): ConnectionInfo {
    return {
      status: this.status,
      reconnectAttempts: this.reconnectAttempts,
      nextRetryMs: this.reconnectTimerId !== null
        ? Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
        : null,
    };
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  private setStatus(status: ConnectionStatus) {
    if (this.status !== status) {
      this.status = status;
      this.statusListeners.forEach((listener) => listener(status));
    }
  }

  public addStatusListener(listener: (status: ConnectionStatus) => void) {
    this.statusListeners.push(listener);
  }

  public removeStatusListener(listener: (status: ConnectionStatus) => void) {
    this.statusListeners = this.statusListeners.filter((l) => l !== listener);
  }

  /**
   * サブクラスで実装: メッセージハンドラ。
   * JSON.parse は各サブクラスで行うが、parseMessage() ユーティリティの使用を推奨。
   */
  protected abstract handleMessage(data: string): void;

  protected receivePong(data: string) {
    const message = JSON.parse(data);
    if (message.type === "pong") {
      this.lastPongReceived = Date.now();
      this.setStatus("connected");
      if (this.pingTimeoutId) {
        clearTimeout(this.pingTimeoutId);
        this.pingTimeoutId = null;
      }
    }
  }

  public disconnect() {
    this.isConnecting = false;
    this.stopPing();
    if (this.reconnectTimerId !== null) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
