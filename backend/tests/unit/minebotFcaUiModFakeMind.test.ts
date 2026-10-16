import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { CommonFcaControlLoop, type CommonFcaActuator } from '../../src/services/minebot/integration/commonFca/controlLoop.js';
import { CommonFcaUiModBridge } from '../../src/services/minebot/integration/commonFca/uiModBridge.js';
// @ts-expect-error the lab script is plain JavaScript
import { createFakeMind } from '../../scripts/lab/fake-fca-mind.mjs';

const TOKEN = 'fake-mind-token-0123456789';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 3000) { const end = Date.now() + ms; while (!check() && Date.now() < end) await wait(10); return check(); }

/** A real HTTP stand-in for the mod's receiver, recording every push. */
async function fakeMod() {
  const posts: Array<{ route: string; body: any }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { try { posts.push({ route: req.url!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { /* ignore */ } res.end('{"success":true}'); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as any).port;
  return { posts, url: `http://127.0.0.1:${port}`, last: (route: string) => posts.filter(post => post.route === route).at(-1)?.body, close: () => { server.closeAllConnections(); server.close(); } };
}

describe('common FCA body + fake mind + fake mod receiver', () => {
  const cleanup: Array<() => void | Promise<unknown>> = [];
  afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

  async function run() {
    const mind = createFakeMind({ token: TOKEN, stepDelayMs: 0 });
    mind.server.listen(0, '127.0.0.1'); await once(mind.server, 'listening');
    cleanup.push(() => { mind.server.closeAllConnections(); mind.server.close(); });
    const mod = await fakeMod(); cleanup.push(mod.close);
    const mindUrl = `http://127.0.0.1:${(mind.server.address() as any).port}`;
    const executed: string[] = [];
    const now = () => new Date().toISOString();
    const actuator: CommonFcaActuator = {
      skills: [{ name: 'get-health', description: '', inputSchema: { type: 'object', properties: {}, additionalProperties: false, required: [] }, readOnly: true, maxDurationMs: 5000 }],
      observe: () => ({ schemaVersion: 1, bodyId: 'minecraft:home', sequence: 1, stateAt: now(), receivedAt: now(), state: {}, facts: {}, connected: true }),
      candidates: () => [], release: async () => true,
      execute: async (c, signal) => { executed.push(String(c.skill)); await wait(30);
        return { id: c.id, connectionId: c.connectionId, outcome: signal.aborted ? 'cancelled' : 'completed', inputsReleased: true, observedAt: now(), result: 'health 20' }; },
    };
    const bridge = new CommonFcaUiModBridge({ baseUrl: () => mod.url, timeoutMs: 1000 });
    const loop = new CommonFcaControlLoop({ baseUrl: mindUrl, token: TOKEN, serverId: 'home', actuator, observer: bridge, pollMilliseconds: 15 });
    cleanup.push(async () => { await loop.stop(); bridge.stop(); });
    bridge.start(); loop.start();
    return { mind, mod, bridge, loop, executed, mindUrl };
  }

  it('shows a whole task on the mod, from its first step to its release', async () => {
    const { mind, mod, bridge, executed } = await run();
    mind.startTask('木を見て回る（検証）', 3);
    expect(await until(() => mod.last('/task')?.status === 'completed')).toBe(true);
    expect(executed).toEqual(['get-health', 'get-health', 'get-health']);
    const tree = mod.last('/task');
    expect(tree).toMatchObject({ goal: '木を見て回る（検証）', status: 'completed' });
    expect(tree.hierarchicalSubTasks.map((step: any) => step.status)).toEqual(['completed', 'completed', 'completed']);
    expect(await until(() => mod.last('/task_list')?.currentTaskId === null)).toBe(true);
    expect(await until(() => (mod.posts.filter(post => post.route === '/task_logs').flatMap(post => post.body.logs).length) >= 6)).toBe(true);
    expect(bridge.currentTaskId()).toBeNull();
  });

  it('shows a task her mind stops as ended, and the body stands still', async () => {
    const { mind, mod } = await run();
    mind.startTask('長い作業（検証）', 30);
    expect(await until(() => mod.last('/task')?.status === 'in_progress')).toBe(true);
    mind.turn({ speaker: { name: 'Rai1241' }, message: '今の作業をやめて' });
    expect(await until(() => mod.last('/task')?.status === 'aborted')).toBe(true);
    expect(mod.last('/task_list')).toMatchObject({ currentTaskId: null });
  });
});
