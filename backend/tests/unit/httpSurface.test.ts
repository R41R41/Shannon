import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { AccessService } from '../../src/modules/access/index.js';
import { protectHttpSurface, requireMachineToken } from '../../src/routes/httpSurface.js';
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); }))); });
const access = new AccessService({ verify: async uid => ({ projectId: 'test', uid, email: 'x@example.test', emailVerified: true, expiresAtMs: Date.now() + 60000 }) },
  { findByIdentity: async (projectId, uid) => ({ projectId, uid, email: '', name: 'X', isAuthorized: true, isAdmin: uid === 'admin' }) }, () => 'server-request');
async function start(machine = false) {
  const app = express(); app.use(machine ? requireMachineToken(() => 'x'.repeat(32)) : protectHttpSurface(access));
  app.use((req, res) => res.json({ reached: true, requestId: res.locals.requestContext?.requestId }));
  const s = app.listen(0, '127.0.0.1'); servers.push(s); await once(s, 'listening');
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}
describe('HTTP surface perimeter', () => {
  it.each(['/api/tokens/today','/api/twitter/schedule','/api/minebot/knowledge/stats','/api/test/scheduled-post','/api/models','/API/TOKENS/today/','/api/new-future-route'])('requires verified admin for %s', async path => {
    const url = await start(); expect((await fetch(url+path)).status).toBe(401);
    expect((await fetch(url+path,{headers:{Authorization:'Bearer user'}})).status).toBe(403);
    const ok = await fetch(url+path,{headers:{Authorization:'Bearer admin'}}); expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({requestId:'server-request'}); expect(ok.headers.get('cache-control')).toBe('no-store');
  });
  it.each(['/api/public/chat','/api/public/chat/verify-admin','/api/public/chat/status','/API/PUBLIC/CHAT/'])('does not reopen unsafe public graph with legacy adminToken or Firebase admin: %s', async path => {
    const url = await start(); const res = await fetch(url+path,{method:'POST',headers:{Authorization:'Bearer admin','Content-Type':'application/json'},body:'{"adminToken":"legacy"}'});
    expect(res.status).toBe(503); expect(await res.json()).toEqual({error:'PUBLIC_CHAT_UNAVAILABLE'});
  });
  it('exempts only exact liveness/readiness and independently authenticated webhook routes', async () => {
    const url = await start(); for(const path of ['/api/health','/api/ready','/api/webhook/twitter']) expect((await fetch(url+path)).status).toBe(200);
    expect((await fetch(url+'/api/webhook/twitter/anything')).status).toBe(401);
    expect((await fetch(url+'/api/health',{method:'POST'})).status).toBe(401);
  });
  it.each(['/api/radar/sources','/api/identity/status'])('allows profile:read for authorized non-admin on %s', async path => {
    const url = await start();
    expect((await fetch(url+path)).status).toBe(401);
    const user = await fetch(url+path,{headers:{Authorization:'Bearer user'}});
    expect(user.status).toBe(200);
    expect(await user.json()).toMatchObject({requestId:'server-request'});
    expect((await fetch(url+path,{headers:{Authorization:'Bearer admin'}})).status).toBe(200);
  });
  it('machine endpoint needs a separate long token and rejects browser Origin', async () => {
    const url=await start(true); expect((await fetch(url+'/throw_item')).status).toBe(401);
    expect((await fetch(url+'/throw_item',{headers:{Authorization:'Bearer admin'}})).status).toBe(401);
    const headers={Authorization:`Bearer ${'x'.repeat(32)}`}; expect((await fetch(url+'/throw_item',{headers})).status).toBe(200);
    expect((await fetch(url+'/throw_item',{headers:{...headers,Origin:'https://attacker.test'}})).status).toBe(401);
  });
});

import {registerHealthRoutes} from '../../src/routes/healthRoutes.js';
it('distinguishes liveness from readiness and fails closed on a readiness check error',async()=>{
 const app=express();let ready=false;registerHealthRoutes(app,()=>ready);const s=app.listen(0,'127.0.0.1');servers.push(s);await once(s,'listening');const url=`http://127.0.0.1:${(s.address() as {port:number}).port}`;
 expect((await fetch(url+'/api/health')).status).toBe(200);expect((await fetch(url+'/api/ready')).status).toBe(503);ready=true;expect((await fetch(url+'/api/ready')).status).toBe(200);
});
