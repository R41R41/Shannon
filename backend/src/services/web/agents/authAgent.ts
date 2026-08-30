import WebSocket from 'ws';
import { WebSocketServiceBase, type WebSocketServiceConfig } from '../../common/WebSocketService.js';
import type { AccessService } from '../../../modules/access/index.js';
import { handleAuthMessage } from './authProtocol.js';

export class AuthAgent extends WebSocketServiceBase {
  private static instance: AuthAgent;
  constructor(config: WebSocketServiceConfig, private readonly access: AccessService) {
    super({ ...config, maxPayload: 20 * 1024, singleConnection: false });
  }
  public static getInstance(config: WebSocketServiceConfig, access: AccessService): AuthAgent {
    if (!AuthAgent.instance) AuthAgent.instance = new AuthAgent(config, access);
    return AuthAgent.instance;
  }
  protected override initialize() {
    this.wss.on('connection', (ws) => {
      this.handleNewConnection(ws);
      let busy = false;
      ws.on('message', async (message) => {
        if (busy) { ws.close(1008, 'Authentication request already in progress'); return; }
        busy = true;
        try {
          const response = await handleAuthMessage(message.toString(), this.access);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
        } finally { busy = false; }
      });
      ws.on('error', () => { /* socket failure; never log auth payload */ });
    });
  }
}
