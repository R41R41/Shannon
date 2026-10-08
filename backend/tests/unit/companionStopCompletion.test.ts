import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanionRequestLoop, type CompanionRequestTasks } from '../../src/services/minebot/integration/CompanionRequestLoop.js';
import { CompanionRuntimeTasks } from '../../src/services/minebot/integration/CompanionRuntimeTasks.js';
import { MinebotTaskRuntime } from '../../src/services/minebot/runtime/MinebotTaskRuntime.js';
import { CONFIG } from '../../src/services/minebot/config/MinebotConfig.js';

const A = '7d0c1c5e-3b0a-4a51-9c58-2f6a8f0f3b11', B = '9a1b2c3d-4e5f-4a51-9c58-2f6a8f0f3b11';
const request = (id = A) => ({ id, goal: id === A ? 'original request' : 'next request', surface: 'text' as const,
  createdAt: '2026-10-05T12:00:00Z', leaseExpiresAt: '2026-10-05T12:01:30Z' });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const botFixture = (): any => Object.assign(new EventEmitter(), {
  entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' },
  health: 20, food: 20, inventory: { items: () => [] }, registry: { blocksByName: {} }, findBlocks: () => [],
  clearControlStates: vi.fn(), pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
  minebotControlState: 'idle', suppressMinebotGameChat: false,
});
const envelope = (text: string): any => ({ channel: 'minecraft', requestId: 'offline-request', sourceUserId: 'minebot-system',
  conversationId: 'minecraft:unbound', threadId: 'minecraft:unbound', tags: ['minecraft'], text,
  minecraft: { dimension: 'overworld', inventory: [] }, metadata: { memoryDisabled: true } });
const until = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
};
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function world(stopWaitMs = 20) {
  const runtime = new MinebotTaskRuntime(botFixture());
  const finish = deferred<void>(); const claims: any[] = [];
  const calls: any[] = []; const executions: string[] = [];
  let originalFinished = false;
  const tasks = new CompanionRuntimeTasks(runtime, { envelope: req => ({ tags: ['companion_task'],
    metadata: { memoryDisabled: true, companionTask: { requestId: req.id } } }), waiting: () => 0,
    deaths: () => 0, inventory: () => ({ oak_log: originalFinished ? 4 : 0 }) });
  runtime.setExecutor(async (input: any, _messages, options) => {
    const id = input.metadata.companionTask.requestId; executions.push(id);
    if (id === A) { await finish.promise; originalFinished = true; } // deliberately ignores abort
    tasks.noteRun(id, !options?.abortSignal?.aborted);
    return { taskTree: { goal: input.text, status: options?.abortSignal?.aborted ? 'in_progress' : 'completed' } };
  });
  const client = {
    async claim(holding: readonly string[]) { calls.push({ kind: 'claim', holding: [...holding] }); return claims.shift() ?? { request: null, cancel: [] }; },
    async progress(id: string, phase: string) { calls.push({ kind: 'progress', id, phase }); return { state: 'running', cancel: false }; },
    async report(id: string, outcome: string, detail: any): Promise<{ state: string; recorded: boolean } | null> {
      calls.push({ kind: 'report', id, outcome, detail, originalFinished,
        originalExecuting: runtime.isTaskExecuting(loop.taken.find(taken => taken.id === A)?.taskId ?? '') });
      return { state: 'done', recorded: true };
    },
  };
  const loop = new CompanionRequestLoop(client, tasks, { stopWaitMs });
  return { runtime, tasks, loop, client, claims, calls, executions, finish };
}

describe('companion ACK requires the original executor to end', () => {
  it('keeps holding and queue/heartbeat processing while a cancelled non-cooperative tool winds down', async () => {
    const w = world(); w.claims.push({ request: request(), cancel: [] }); await w.loop.claimOnce();
    const taskA = w.loop.taken[0].taskId!;
    w.claims.push({ request: request(B), cancel: [A] }); await w.loop.claimOnce();
    await Promise.resolve();
    expect(w.runtime.isTaskExecuting(taskA)).toBe(true);
    expect(w.tasks.status(taskA).state).toBe('running');
    await w.loop.tick();
    await w.loop.claimOnce();
    expect(w.calls.at(-1)).toEqual({ kind: 'claim', holding: [A, B] });
    expect(w.executions).toEqual([A]);
    expect(w.calls.filter(call => call.kind === 'report')).toEqual([]);
    w.finish.resolve(); await until(() => w.executions.length === 2);
    await w.loop.tick();
    const stopped = w.calls.filter(call => call.kind === 'report' && call.id === A);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ outcome: 'stopped', detail: { code: 'cancelled' }, originalFinished: true, originalExecuting: false });
    expect(w.executions).toEqual([A, B]); await w.loop.stop();
  });

  it('bounds shutdown without fabricating run_over completion and delivers only the late original ACK', async () => {
    const w = world(10); w.claims.push({ request: request(), cancel: [] }); await w.loop.claimOnce();
    await w.loop.stop('run_over');
    expect(w.calls.filter(call => call.kind === 'report')).toEqual([]);
    expect(w.loop.isRequestTask(w.loop.taken[0].taskId!)).toBe(true);
    await w.loop.claimOnce(); expect(w.calls.at(-1).holding).toEqual([A]);
    w.finish.resolve(); await until(() => w.calls.some(call => call.kind === 'report'));
    expect(w.calls.filter(call => call.kind === 'report')).toEqual([expect.objectContaining({ id: A, outcome: 'failed',
      detail: { code: 'run_over', gained: [{ item: 'oak_log', count: 4 }] }, originalFinished: true, originalExecuting: false })]);
    expect(w.loop.isRequestTask(w.loop.taken[0].taskId!)).toBe(false);
  });

  it.each([true, false])('rescans a late original ACK while another final report is pending (other ACK: %s)', async acknowledged => {
    const w = world(0);
    const originalStart = w.tasks.start.bind(w.tasks);
    vi.spyOn(w.tasks, 'start').mockImplementation(req => req.id === B ? { refused: 'error' } : originalStart(req));
    const firstReport = deferred<null>(), secondReport = deferred<{ state: string; recorded: boolean } | null>();
    const firstReporting = deferred<void>(), secondReporting = deferred<void>();
    const stopping = deferred<void>(), originalStop = w.tasks.stop.bind(w.tasks);
    vi.spyOn(w.tasks, 'stop').mockImplementation(id => { stopping.resolve(); return originalStop(id); });
    const originalReport = w.client.report.bind(w.client);
    let otherAttempts = 0;
    vi.spyOn(w.client, 'report').mockImplementation(async (id, outcome, detail) => {
      const receipt = await originalReport(id, outcome, detail);
      if (id !== B) return receipt;
      if (++otherAttempts === 1) { firstReporting.resolve(); return firstReport.promise; }
      secondReporting.resolve(); return secondReport.promise;
    });
    w.claims.push({ request: request(), cancel: [] }); await w.loop.claimOnce();
    const taskA = w.loop.taken[0].taskId!;
    w.claims.push({ request: request(B), cancel: [] });
    const takingOther = w.loop.claimOnce();
    await firstReporting.promise; // B's known refusal is delivering before shutdown.
    const shutdown = w.loop.stop('run_over');
    await stopping.promise;
    await new Promise(resolve => setTimeout(resolve, 0)); // bounded stop has joined the first delivery.
    firstReport.resolve(null);
    await secondReporting.promise; // the second/final shutdown pass is now awaiting B.
    await takingOther;
    expect(w.executions).toEqual([A]);
    expect(w.runtime.isTaskExecuting(taskA)).toBe(true);
    expect(w.calls.filter(call => call.kind === 'report' && call.id === A)).toEqual([]);
    w.finish.resolve();
    await until(() => !w.runtime.isTaskExecuting(taskA));
    // The original completion chain runs while B's second report is still blocked.
    await new Promise<void>(resolve => setImmediate(resolve));
    secondReport.resolve(acknowledged ? { state: 'failed', recorded: true } : null);
    await shutdown;
    expect(w.calls.filter(call => call.kind === 'report' && call.id === A)).toEqual([
      expect.objectContaining({ outcome: 'failed', detail: { code: 'run_over', gained: [{ item: 'oak_log', count: 4 }] }, originalFinished: true, originalExecuting: false }),
    ]);
    expect(otherAttempts).toBe(2);
    expect(w.loop.isRequestTask(taskA)).toBe(false);
    await w.loop.claimOnce();
    expect(w.calls.at(-1)).toEqual({ kind: 'claim', holding: acknowledged ? [] : [B] });
    expect(w.executions).toEqual([A]);
  });

  it.each(['false', 'throw'])('retains an uncertain %s stop despite logical task disappearance', async failure => {
    const calls: any[] = []; let claim = 0;
    const tasks: CompanionRequestTasks = { start: () => ({ taskId: 'original' }), status: () => ({ state: 'gone' }),
      stop: async () => { if (failure === 'throw') throw new Error('offline-uncertain'); return false; } };
    const loop = new CompanionRequestLoop({
      claim: async (holding: readonly string[]) => { calls.push({ holding: [...holding] }); return claim++ === 0
        ? { request: request(), cancel: [] } : { request: null, cancel: [A] }; },
      progress: async () => ({ state: 'running', cancel: false }),
      report: async () => { calls.push('unexpected ACK'); return { state: 'done', recorded: true }; },
    }, tasks, { stopWaitMs: 1 });
    await loop.claimOnce(); await loop.claimOnce(); await loop.tick(); await loop.stop(); await loop.claimOnce();
    expect(loop.isRequestTask('original')).toBe(true); expect(calls).not.toContain('unexpected ACK');
    expect(calls.at(-1)).toEqual({ holding: [A] });
  });

  it('does not treat a legacy synchronous control-only runtime as confirmed completion', async () => {
    const removeTask = vi.fn(() => ({ success: true }));
    const tasks = new CompanionRuntimeTasks({ removeTask, putTaskFirst: () => ({ success: true, taskId: 'original' }),
      getTaskListState: () => ({ tasks: [] }) }, { envelope: () => ({ tags: [], metadata: {} }),
      waiting: () => 0, deaths: () => 0, inventory: () => ({}) });
    expect(await tasks.stop('original')).toBe(false); expect(removeTask).toHaveBeenCalledWith('original');
  });
});

describe('original-generation stop admission', () => {
  it('fences new physical execution after an emergency timeout clears the old logical owner', async () => {
    vi.useFakeTimers(); const runtime = new MinebotTaskRuntime(botFixture());
    const old = deferred<any>(); const calls: string[] = []; let originalSignal: AbortSignal | undefined;
    runtime.setExecutor(async (input: any, _messages, options) => {
      calls.push(input.text); if (input.text === 'original') { originalSignal = options?.abortSignal; return old.promise; }
      return { taskTree: { goal: input.text, status: 'completed' } };
    });
    const original = runtime.invoke({ taskId: 'original-task', userMessage: 'original', envelope: envelope('original') });
    const stopping = runtime.stopTaskAndWait('original-task'); let acknowledged = false; void stopping.then(() => { acknowledged = true; });
    const preemption = runtime.interruptForEmergency('offline safety event');
    await vi.advanceTimersByTimeAsync(CONFIG.EMERGENCY_INTERRUPT_WAIT_MS + 100); await preemption;
    expect(runtime.isRunning()).toBe(false); expect(runtime.isTaskExecuting('original-task')).toBe(true);
    expect(originalSignal?.aborted).toBe(true); expect(acknowledged).toBe(false);
    const originalSnapshot = runtime.getOriginalExecutionSnapshot();
    expect(originalSnapshot).toEqual([expect.objectContaining({ taskId: 'original-task', aborted: true, stopRequested: true })]);
    expect(Object.isFrozen(originalSnapshot)).toBe(true); expect(Object.isFrozen(originalSnapshot[0])).toBe(true);
    expect(await runtime.invoke({ taskId: 'new-task', isEmergency: true, userMessage: 'new task', envelope: envelope('new task') })).toBeNull();
    const queued = runtime.putTaskFirst({ userMessage: 'queued next task', envelope: envelope('queued next task') });
    expect(queued.success).toBe(true);
    const resuming = runtime.resumePreviousTask(); await vi.advanceTimersByTimeAsync(500); await resuming;
    expect(calls).toEqual(['original']); expect(acknowledged).toBe(false);
    old.resolve({ taskTree: { goal: 'original', status: 'in_progress' } }); await original;
    expect(await stopping).toBe(true); await Promise.resolve();
    expect(calls).toEqual(['original', 'queued next task']);
    expect(runtime.isTaskExecuting('original-task')).toBe(false);
    expect(runtime.getOriginalExecutionSnapshot()).toEqual([]);
    expect(originalSnapshot).toHaveLength(1); vi.clearAllTimers();
  });

  it('can remove a never-dispatched queued task without cancelling an unrelated original executor', async () => {
    const runtime = new MinebotTaskRuntime(botFixture()); const original = deferred<any>(); let signal: AbortSignal | undefined;
    runtime.setExecutor(async (_input, _messages, options) => { signal = options?.abortSignal; return original.promise; });
    const run = runtime.invoke({ taskId: 'active', userMessage: 'active', envelope: envelope('active') });
    const queued = runtime.putTaskFirst({ userMessage: 'queued', envelope: envelope('queued') });
    expect(await runtime.stopTaskAndWait(queued.taskId!)).toBe(true);
    expect(signal?.aborted).toBe(false); expect(runtime.isTaskExecuting('active')).toBe(true);
    expect(await runtime.stopTaskAndWait('missing')).toBe(false);
    original.resolve({ taskTree: { goal: 'active', status: 'completed' } }); await run;
  });
});
