import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import WebSocket from 'ws';
vi.mock('../../src/utils/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
import { WebSocketServiceBase } from '../../src/services/common/WebSocketService.js';
import { AccessService } from '../../src/modules/access/index.js';
import { getWebNotificationHub, clearWebNotificationHub } from '../../src/services/web/webNotificationHub.js';

class RoutingAgent extends WebSocketServiceBase {
  private hubUnsub: (() => void) | null = null;
  constructor(access: AccessService) {
    super({ port: 0, host: '127.0.0.1', serviceName: 'routing-agent', access, allowedOrigins: ['https://console.example.test'] });
  }
  get server() { return this.wss; }
  protected initialize() {
    this.hubUnsub = getWebNotificationHub().onPlanning(data => {
      this.broadcastWebPayload(data, { type: 'web:planning', data });
    });
    this.onAuthenticatedConnection(ws => {
      this.handleNewConnection(ws);
      this.onMessage(ws, raw => {
        const data = JSON.parse(raw.toString());
        if (data.type === 'web:bind-session') {
          this.bindWebSession(ws, data.sessionId);
          this.sendTo(ws, { type: 'web:session-bound', sessionId: data.sessionId });
        }
      });
    });
  }
  disconnect() { this.hubUnsub?.(); this.hubUnsub = null; }
}

const cleanup: WebSocketServiceBase[] = [];
afterEach(async () => {
  for (const service of cleanup.splice(0)) {
    (service as RoutingAgent).disconnect?.();
    clearWebNotificationHub();
    await service.stop();
  }
});

async function listen(service: RoutingAgent) {
  service.start();
  if (!service.server.address()) await once(service.server, 'listening');
  return `ws://127.0.0.1:${(service.server.address() as { port: number }).port}`;
}

async function authConnect(url: string, token: string) {
  const ws = new WebSocket(url, { headers: { origin: 'https://console.example.test' } });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'auth:check', idToken: token }));
  await once(ws, 'message');
  return ws;
}

async function bindSession(ws: WebSocket, sessionId: string) {
  ws.send(JSON.stringify({ type: 'web:bind-session', sessionId }));
  const bound = once(ws, 'message');
  const payload = JSON.parse(String((await bound)[0]));
  expect(payload.type).toBe('web:session-bound');
  expect(payload.sessionId).toBe(sessionId);
}

describe('Web notification session routing', () => {
  it('delivers scoped planning updates only to the bound session', async () => {
    const access = new AccessService(
      { verify: async token => ({ uid: token, projectId: 'test', email: `${token}@example.test`, emailVerified: true, expiresAtMs: Date.now() + 60000 }) },
      { findByIdentity: async (projectId, uid) => ({ uid, projectId, name: uid, email: '', isAuthorized: true, isAdmin: true }) },
      () => 'request',
    );
    const service = new RoutingAgent(access);
    cleanup.push(service);
    const url = await listen(service);
    const a = await authConnect(url, 'alice');
    const b = await authConnect(url, 'bob');
    await bindSession(a, 'session-a');
    await bindSession(b, 'session-b');
    const planningA = once(a, 'message');
    const planningB = once(b, 'message');
    getWebNotificationHub().emitPlanning({ sessionId: 'session-a', goal: 'scoped', status: 'in_progress', strategy: '', hierarchicalSubTasks: [], currentSubTaskId: null, subTasks: null });
    expect(JSON.parse(String((await planningA)[0])).data.goal).toBe('scoped');
    await expect(Promise.race([planningB, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 300))])).rejects.toThrow('timeout');
  });

  it('drops unscoped planning updates instead of broadcasting them', async () => {
    const access = new AccessService(
      { verify: async token => ({ uid: token, projectId: 'test', email: `${token}@example.test`, emailVerified: true, expiresAtMs: Date.now() + 60000 }) },
      { findByIdentity: async (projectId, uid) => ({ uid, projectId, name: uid, email: '', isAuthorized: true, isAdmin: true }) },
      () => 'request',
    );
    const service = new RoutingAgent(access);
    cleanup.push(service);
    const url = await listen(service);
    const a = await authConnect(url, 'alice');
    const b = await authConnect(url, 'bob');
    const first = once(a, 'message');
    const second = once(b, 'message');
    getWebNotificationHub().emitPlanning({ goal: 'legacy', status: 'in_progress', strategy: '', hierarchicalSubTasks: [], currentSubTaskId: null, subTasks: null });
    await expect(Promise.race([first, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 300))])).rejects.toThrow('timeout');
    await expect(Promise.race([second, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 300))])).rejects.toThrow('timeout');
  });
});
