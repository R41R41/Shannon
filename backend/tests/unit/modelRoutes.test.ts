import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { AccessError, AccessService } from '../../src/modules/access/index.js';
import { ModelSettingsService } from '../../src/modules/modelSettings/index.js';
import { registerModelRoutes } from '../../src/routes/modelRoutes.js';

let server: Server; let base: string;
const repository = { snapshot: vi.fn(() => ({ current: { chat: 'old' }, overrides: {} })), set: vi.fn(), reset: vi.fn() };
beforeEach(async () => {
  vi.clearAllMocks();
  const access = new AccessService({ verify: async token => {
    if (token === 'revoked') throw new AccessError('UNAUTHENTICATED');
    if (token === 'offline') throw new AccessError('AUTH_UNAVAILABLE');
    return { uid: token, projectId: 'test', email: 'signed@example.test', emailVerified: true, expiresAtMs: Date.now() + 60000 };
  } }, { findByIdentity: async (projectId, uid) => ({ uid, projectId, name: 'Test', email: 'signed@example.test', isAuthorized: true, isAdmin: uid === 'admin' }) }, () => 'test-request');
  const app = express(); app.use(express.json()); registerModelRoutes(app, access, new ModelSettingsService(repository));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

describe('authenticated model HTTP routes', () => {
  it.each([['GET', '/api/models'], ['PUT', '/api/models/chat'], ['POST', '/api/models/reset']])('rejects missing credentials for %s %s before any operation', async (method, path) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'PUT' ? { body: JSON.stringify({ model: 'new', isAdmin: true }) } : {}) });
    expect(res.status).toBe(401); expect(res.headers.get('cache-control')).toBe('no-store');
    expect(repository.set).not.toHaveBeenCalled(); expect(repository.reset).not.toHaveBeenCalled(); expect(repository.snapshot).not.toHaveBeenCalled();
  });
  it.each([['user', 403], ['revoked', 401], ['offline', 503]])('rejects %s credentials with %s', async (token, status) => {
    const res = await fetch(base + '/api/models/chat', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'new' }) });
    expect(res.status).toBe(status); expect(repository.set).not.toHaveBeenCalled();
  });
  it('allows the reviewed admin path, and returns successful writes only after the use case executes', async () => {
    const headers = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
    expect((await fetch(base + '/api/models', { headers })).status).toBe(200);
    const change = await fetch(base + '/api/models/chat', { method: 'PUT', headers, body: JSON.stringify({ model: 'new' }) });
    expect(await change.json()).toEqual({ ok: true, key: 'chat', model: 'new' }); expect(repository.set).toHaveBeenCalledWith('chat', 'new');
    expect((await fetch(base + '/api/models/reset', { method: 'POST', headers })).status).toBe(200); expect(repository.reset).toHaveBeenCalledOnce();
  });
  it('rejects unknown keys rather than mutating model configuration', async () => {
    const res = await fetch(base + '/api/models/constructor', { method: 'PUT', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'new' }) });
    expect(res.status).toBe(400); expect(repository.set).not.toHaveBeenCalled();
  });
});
