import { describe, expect, it } from 'vitest';
import { CompanionBodyClient, type CompanionRequest } from '../../src/services/minebot/integration/CompanionBodyClient.js';
import { CompanionRequestLoop, type CompanionRequestTasks, type RequestTaskState } from '../../src/services/minebot/integration/CompanionRequestLoop.js';

const token = 'x'.repeat(43);
const ID = '7d0c1c5e-3b0a-4a51-9c58-2f6a8f0f3b11';
const OTHER = '9a1b2c3d-4e5f-4a51-9c58-2f6a8f0f3b11';
const request = (id = ID, goal = 'オークの原木を16個集める'): CompanionRequest =>
  ({ id, goal, surface: 'text', createdAt: '2026-10-05T12:00:00.000Z', leaseExpiresAt: '2026-10-05T12:01:30.000Z' });

describe('CompanionBodyClient requests (phase 4)', () => {
  it('claims with what it holds, and reads only a well-formed request and cancel ids', async () => {
    const sent: any[] = [];
    const fetcher = (async (url: string, init: any) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ request: { ...request(), extra: 'x' }, cancel: [OTHER, 'not-an-id'] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new CompanionBodyClient({ baseUrl: 'http://127.0.0.1:4329', token, serverId: 'lab-0i4Tdi', fetcher });
    const answer = await client.claim([OTHER], 25);
    expect(sent[0]).toEqual({ url: 'http://127.0.0.1:4329/v1/body/minecraft/claim', body: { scopeKey: 'owner', waitSeconds: 25, holding: [OTHER] } });
    expect(answer).toEqual({ request: request(), cancel: [OTHER] });
  });

  it('reports progress with a short plain step, and a result with closed fields only', async () => {
    const sent: any[] = [];
    const fetcher = (async (url: string, init: any) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(url.endsWith('/progress') ? { id: ID, state: 'running', cancel: true } : { id: ID, state: 'done', recorded: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new CompanionBodyClient({ baseUrl: 'http://127.0.0.1:4329', token, serverId: 'lab-0i4Tdi', fetcher });
    expect(await client.progress(ID, 'started', 'collect-block\n'.repeat(20))).toEqual({ state: 'running', cancel: true });
    expect(sent[0].url).toBe(`http://127.0.0.1:4329/v1/body/minecraft/requests/${ID}/progress`);
    expect(sent[0].body.step.length).toBeLessThanOrEqual(80);
    expect(sent[0].body.step).not.toContain('\n');
    expect(await client.report(ID, 'done', { code: 'error', gained: [{ item: 'oak_log', count: 16 }, { item: 'Bad Item', count: 1 }] })).toEqual({ state: 'done', recorded: true });
    expect(sent[1].body).toEqual({ scopeKey: 'owner', outcome: 'done', gained: [{ item: 'oak_log', count: 16 }] });
  });

  it('a companion that cannot be reached answers null (try again); a refusal answers a final state', async () => {
    const down = new CompanionBodyClient({ baseUrl: 'http://127.0.0.1:4329', token, serverId: 'lab-0i4Tdi',
      fetcher: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
    expect(await down.claim([])).toBeNull();
    expect(await down.report(ID, 'done')).toBeNull();
    const gone = new CompanionBodyClient({ baseUrl: 'http://127.0.0.1:4329', token, serverId: 'lab-0i4Tdi',
      fetcher: (async () => new Response('{"error":"MINECRAFT_REQUEST_NOT_FOUND"}', { status: 404 })) as unknown as typeof fetch });
    expect(await gone.report(ID, 'failed', { code: 'gave_up' })).toEqual({ state: 'unknown', recorded: false });
  });
});

/** A companion and a task runtime in memory. */
function world() {
  const claims: Array<{ request: CompanionRequest | null; cancel: string[] }> = [];
  const calls: any[] = [];
  let reportFails = 0;
  const client = {
    async claim(holding: readonly string[]) { calls.push({ kind: 'claim', holding: [...holding] }); return claims.shift() ?? { request: null, cancel: [] }; },
    async progress(id: string, phase: string, step?: string) { calls.push({ kind: 'progress', id, phase, ...(step ? { step } : {}) }); return { state: 'running', cancel: false }; },
    async report(id: string, outcome: string, detail: any) {
      calls.push({ kind: 'report', id, outcome, ...detail });
      if (reportFails > 0) { reportFails -= 1; return null; }
      return { state: outcome === 'done' ? 'done' : 'failed', recorded: true };
    },
  };
  const states = new Map<string, { state: RequestTaskState; code?: any }>();
  const inventory: Record<string, number> = { oak_log: 2, dirt: 5 };
  const started: CompanionRequest[] = [];
  const stopped: string[] = [];
  let refuse: any = null;
  const tasks: CompanionRequestTasks = {
    start(item) {
      if (refuse) return { refused: refuse };
      started.push(item);
      const taskId = `task-${started.length}`;
      states.set(taskId, { state: 'waiting' });
      return { taskId };
    },
    status: taskId => states.get(taskId) ?? { state: 'gone' },
    stop: taskId => { stopped.push(taskId); states.set(taskId, { state: 'gone' }); },
    step: () => 'collect-block',
    inventory: () => ({ ...inventory }),
  };
  const loop = new CompanionRequestLoop(client, tasks, { stepEveryMs: 0 });
  return { loop, claims, calls, states, inventory, started, stopped, setRefuse: (code: any) => { refuse = code; }, failReports: (count: number) => { reportFails = count; } };
}

describe('CompanionRequestLoop', () => {
  it('turns a claimed request into a task, reports accepted → started → done with the items gained, and holds it meanwhile', async () => {
    const { loop, claims, calls, states, inventory, started } = world();
    claims.push({ request: request(), cancel: [] });
    await loop.claimOnce();
    expect(started.map(item => item.goal)).toEqual(['オークの原木を16個集める']);
    expect(loop.isRequestTask('task-1')).toBe(true);
    expect(calls.at(-1)).toEqual({ kind: 'progress', id: ID, phase: 'accepted' });
    // The next claim names it as held, and nothing new is taken.
    await loop.claimOnce();
    expect(calls.at(-1)).toEqual({ kind: 'claim', holding: [ID] });
    states.set('task-1', { state: 'running' });
    await loop.tick();
    expect(calls.at(-1)).toEqual({ kind: 'progress', id: ID, phase: 'started', step: 'collect-block' });
    inventory.oak_log = 18;
    states.set('task-1', { state: 'done' });
    await loop.tick();
    expect(calls.at(-1)).toEqual({ kind: 'report', id: ID, outcome: 'done', gained: [{ item: 'oak_log', count: 16 }] });
    expect(loop.isRequestTask('task-1')).toBe(false);
    await loop.claimOnce();
    expect(calls.at(-1)).toEqual({ kind: 'claim', holding: [] });
    expect(loop.taken).toEqual([{ id: ID, surface: 'text', taskId: 'task-1', outcome: 'done' }]);
  });

  it('reports a failed task with its reason, and one the runtime lost as unknown', async () => {
    const { loop, claims, calls, states } = world();
    claims.push({ request: request(), cancel: [] });
    await loop.claimOnce();
    states.set('task-1', { state: 'failed', code: 'died' });
    await loop.tick();
    expect(calls.at(-1)).toMatchObject({ kind: 'report', id: ID, outcome: 'failed', code: 'died' });
    claims.push({ request: request(OTHER, 'パンを3個作る'), cancel: [] });
    await loop.claimOnce();
    states.delete('task-2');
    await loop.tick();
    expect(calls.at(-1)).toMatchObject({ kind: 'report', id: OTHER, outcome: 'failed', code: 'unknown' });
  });

  it('stops the task when the companion cancels it, and reports the stop', async () => {
    const { loop, claims, calls, stopped } = world();
    claims.push({ request: request(), cancel: [] });
    await loop.claimOnce();
    claims.push({ request: null, cancel: [ID] });
    await loop.claimOnce();
    expect(stopped).toEqual(['task-1']);
    await loop.tick();
    expect(calls.at(-1)).toMatchObject({ kind: 'report', id: ID, outcome: 'stopped', code: 'cancelled' });
  });

  it('a request the runtime refuses fails at once; a report that does not arrive is tried again', async () => {
    const { loop, claims, calls, setRefuse, failReports } = world();
    setRefuse('queue_full');
    failReports(1);
    claims.push({ request: request(), cancel: [] });
    await loop.claimOnce();
    expect(calls.filter(call => call.kind === 'report')).toHaveLength(1);
    await loop.claimOnce();
    // Still held until the companion took the report.
    expect(calls.filter(call => call.kind === 'claim').at(-1)).toEqual({ kind: 'claim', holding: [ID] });
    await loop.tick();
    expect(calls.filter(call => call.kind === 'report')).toHaveLength(2);
    expect(calls.at(-1)).toMatchObject({ outcome: 'failed', code: 'queue_full' });
  });

  it('at the end of the run reports what is still open as run_over and stops its task', async () => {
    const { loop, claims, calls, stopped } = world();
    claims.push({ request: request(), cancel: [] });
    await loop.claimOnce();
    await loop.stop('run_over');
    expect(stopped).toEqual(['task-1']);
    expect(calls.at(-1)).toMatchObject({ kind: 'report', id: ID, outcome: 'failed', code: 'run_over' });
  });
});
