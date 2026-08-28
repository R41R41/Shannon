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
