import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import WebSocket from 'ws';
vi.mock('../../src/utils/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
import { WebSocketServiceBase } from '../../src/services/common/WebSocketService.js';
import { AuthAgent } from '../../src/services/web/agents/authAgent.js';
import { AccessService } from '../../src/modules/access/index.js';

class TestService extends WebSocketServiceBase {
  initializations = 0;
  constructor() { super({ port: 0, host: '127.0.0.1', serviceName: 'test', singleConnection: false }); }
  protected initialize() { this.initializations++; this.wss.on('connection', ws => this.handleNewConnection(ws)); }
  get server() { return this.wss; }
}
const cleanup: WebSocketServiceBase[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(s => s.stop())); });
async function listen(service: TestService) {
  service.start(); if (!service.server.address()) await once(service.server, 'listening');
  return `ws://127.0.0.1:${(service.server.address() as { port: number }).port}`;
}
async function connect(url: string) { const ws = new WebSocket(url); await once(ws, 'open'); return ws; }

describe('WebSocket lifecycle', () => {
  it('construction is inert, start is idempotent, and stop releases the port and sockets', async () => {
    const service = new TestService(); cleanup.push(service);
    expect(service.server).toBeUndefined(); expect(service.initializations).toBe(0); await service.stop();
    const url = await listen(service); service.start(); expect(service.initializations).toBe(1);
    const client = await connect(url); const closed = once(client, 'close');
    await service.stop(); await closed;
    expect(service.server.address()).toBeNull();
    await listen(service); expect(service.initializations).toBe(2);
  });
  it('stop immediately after start does not leave a listener behind', async () => {
    const service = new TestService(); cleanup.push(service);
    service.start(); await service.stop();
    await new Promise(resolve => setImmediate(resolve));
    expect(service.server.address()).toBeNull();
  });
  it('independent connections remain open when multi-client mode is explicit', async () => {
    const service = new TestService(); cleanup.push(service); const url = await listen(service);
    const a = await connect(url); const b = await connect(url);
    const first = once(a, 'message'); const second = once(b, 'message');
    service.broadcast({ type: 'test' });
    expect(JSON.parse(String((await first)[0]))).toEqual({ type: 'test' });
    expect(JSON.parse(String((await second)[0]))).toEqual({ type: 'test' });
  });
  it('real auth transport replies only to its requester and cannot register an admin', async () => {
    const access = new AccessService({ verify: async token => ({ uid: token, projectId: 'test', email: `${token}@example.test`, emailVerified: true, expiresAtMs: Date.now() + 60000 }) },
      { findByIdentity: async (projectId, uid) => ({ uid, projectId, name: uid, email: '', isAuthorized: true, isAdmin: false }) }, () => 'request');
    class TestAuth extends AuthAgent { get server() { return this.wss; } }
    const service = new TestAuth({ serviceName: 'auth', port: 0, host: '127.0.0.1' }, access); cleanup.push(service);
    service.start(); await once(service.server, 'listening');
    const url = `ws://127.0.0.1:${(service.server.address() as { port: number }).port}`;
    const a = await connect(url); const b = await connect(url);
    const pa = once(a, 'message'); const pb = once(b, 'message');
    a.send(JSON.stringify({ type: 'auth:check', idToken: 'alice' })); b.send(JSON.stringify({ type: 'auth:check', idToken: 'bob' }));
    expect(JSON.parse(String((await pa)[0])).userData.email).toBe('alice@example.test');
    expect(JSON.parse(String((await pb)[0])).userData.email).toBe('bob@example.test');
    const init = once(a, 'message'); a.send(JSON.stringify({ type: 'auth:init', email: 'admin' }));
    expect(JSON.parse(String((await init)[0]))).toMatchObject({ success: false, error: 'REGISTRATION_DISABLED' });
  });
});

class GuardedService extends WebSocketServiceBase {
  initializedClients = 0;
  commands = 0;
  constructor(access: AccessService, authorizationLeaseMs = 60000) {
    super({ port: 0, host: '127.0.0.1', serviceName: 'guarded', access,
      allowedOrigins: ['https://console.example.test'], authorizationLeaseMs });
  }
  get server() { return this.wss; }
  protected initialize() {
    this.onAuthenticatedConnection(ws => {
      this.initializedClients++;
      this.handleNewConnection(ws);
      this.sendTo(ws, { type: 'initial-private-data' });
      this.onMessage(ws, () => { this.commands++; this.sendTo(ws, { type: 'result' }); });
    });
  }
}
const access = () => new AccessService({ verify: async token => {
  if (token === 'bad') throw new Error('offline');
  return { uid: token, projectId: 'test', email: `${token}@example.test`, emailVerified: true, expiresAtMs: Date.now() + 60000 };
}}, { findByIdentity: async (projectId, uid) => ({ projectId, uid, email: '', name: uid, isAuthorized: true, isAdmin: uid.startsWith('admin') }) }, () => 'server-request');
async function guarded(lease?: number) {
  const service = new GuardedService(access(), lease); cleanup.push(service); service.start();
  await once(service.server, 'listening');
  return { service, url: `ws://127.0.0.1:${(service.server.address() as { port: number }).port}` };
}
async function browserConnect(url: string) { const ws = new WebSocket(url, { origin: 'https://console.example.test' }); await once(ws, 'open'); return ws; }
async function authorize(ws: WebSocket, token = 'admin-a') { const ready = once(ws, 'message'); ws.send(JSON.stringify({ type: 'auth:check', idToken: token })); expect(JSON.parse(String((await ready)[0])).type).toBe('auth:ready'); }
describe('real operational WebSocket authorization', () => {
  it.each(['https://attacker.example.test', 'null', undefined])('rejects origin %s before accepting the transport', async origin => {
    const { service, url } = await guarded(); const ws = new WebSocket(url, { origin });
    const [response] = await once(ws, 'unexpected-response'); expect(response).toBeDefined(); ws.on('error', () => {}); ws.terminate();
    expect(service.initializedClients).toBe(0);
  });
  it.each(['user', 'bad'])('rejects unprivileged or unverified credentials before initial data reads: %s', async token => {
    const { service, url } = await guarded(); const ws = await browserConnect(url); const closed = once(ws, 'close');
    ws.send(JSON.stringify({ type: 'auth:check', idToken: token })); await closed;
    expect(service.initializedClients).toBe(0); expect(service.commands).toBe(0);
  });
  it('rejects unauthenticated commands and never broadcasts to pending clients', async () => {
    const { service, url } = await guarded(); const ws = await browserConnect(url); const seen: unknown[] = []; ws.on('message', x => seen.push(x));
    service.broadcast({ secret: true }); const closed = once(ws, 'close'); ws.send('{"type":"service:command"}'); await closed;
    expect(seen).toEqual([]); expect(service.commands).toBe(0);
  });
  it('authenticates before initial data, replies only to requester, and does not evict another administrator', async () => {
    const { service, url } = await guarded(); const a = await browserConnect(url); await authorize(a);
    const b = await browserConnect(url); await authorize(b, 'admin-b'); const aResults: unknown[] = []; a.on('message', x => aResults.push(x));
    const result = once(b, 'message'); b.send('{"type":"operate"}'); expect(JSON.parse(String((await result)[0]))).toEqual({ type: 'result' });
    expect(service.commands).toBe(1); expect(aResults).toEqual([]); expect(a.readyState).toBe(WebSocket.OPEN);
  });
  it('closes an expired authorization lease and suppresses further private output', async () => {
    const { service, url } = await guarded(40); const ws = await browserConnect(url); await authorize(ws);
    const closed = once(ws, 'close'); await closed; service.broadcast({ secret: 'after-expiry' }); expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
  it('closes invalid JSON without unhandled rejection or executing an operation', async () => {
    const { service, url } = await guarded(); const ws = await browserConnect(url); await authorize(ws);
    const closed = once(ws, 'close'); ws.send('invalid-json'); await closed; expect(service.commands).toBe(0);
  });
});
