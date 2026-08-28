import { describe, expect, it, vi } from 'vitest';
import type { RequestEnvelope } from '@shannon/common';
vi.mock('../../src/utils/logger.js', () => ({ logger: { warn: vi.fn() } }));
import { RequestExecutionCoordinator } from '../../src/services/llm/graph/requestExecutionCoordinator.js';
import { ExecutionLanes, executionLaneKey } from '../../src/modules/execution/index.js';
import { runCoordinatedGraph } from '../../src/services/llm/graph/coordinatedGraphInvocation.js';
import { RunToolRegistry } from '../../src/modules/execution/runToolRegistry.js';

describe('run tool registry', () => {
  it('rejects context setters without a factory, without partially registering the batch', () => {
    const registry = new RunToolRegistry<any>([{ name: 'read' }]);
    expect(() => registry.add([{ name: 'new' }, { name: 'stateful', setContext() {} }])).toThrow('createForRun');
    expect(registry.names()).toEqual(['read']);
  });
  it.each(['alias', 'rename'])('rejects an invalid factory result (%s)', kind => {
    const tool: any = { name: 'stateful', createForRun: () => kind === 'alias' ? tool : { name: 'other' } };
    expect(() => new RunToolRegistry([tool]).createTools()).toThrow('Invalid run-scoped');
  });
  it('creates distinct stateful instances and reuses explicitly stateless services', () => {
    const shared = { name: 'read' };
    const registry = new RunToolRegistry<any>([shared, { name: 'write', createForRun: () => ({ name: 'write', value: [] }) }]);
    const first = registry.createTools(); const second = registry.createTools();
    first[1].value.push('private');
    expect(first[0]).toBe(shared); expect(second[0]).toBe(shared); expect(second[1].value).toEqual([]);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function request(tags: string[] = []): RequestEnvelope {
  return { requestId: 'request', channel: 'discord', sourceUserId: 'user',
    conversationId: 'conversation', threadId: 'thread-a', tags,
    timestampIso: '2026-08-28T00:00:00Z' };
}

describe('request execution ownership', () => {
  it('old completion cannot remove the emergency cancellation handle', async () => {
    const coordinator = new RequestExecutionCoordinator();
    const oldStarted = deferred(); const finishOld = deferred();
    const emergencyStarted = deferred(); const finishEmergency = deferred();
    const old = coordinator.run(request(), async () => {
      oldStarted.resolve(); await finishOld.promise;
    }).catch(() => undefined);
    await oldStarted.promise;
    const emergency = coordinator.run(request(['emergency']), async () => {
      emergencyStarted.resolve(); await finishEmergency.promise;
    });
    await emergencyStarted.promise;
    const key = executionLaneKey(request());
    const owner = coordinator.getAbortController(key);
    try {
      finishOld.resolve(); await old;
      expect(owner).toBeDefined();
      expect(coordinator.getAbortController(key)).toBe(owner);
    } finally { finishEmergency.resolve(); await emergency; }
  });

  it('queued normal work waits while an emergency is still running', async () => {
    const coordinator = new RequestExecutionCoordinator();
    const oldStarted = deferred(); const finishOld = deferred();
    const finishEmergency = deferred(); const emergencyStarted = deferred();
    const queued = vi.fn(async () => undefined);
    const old = coordinator.run(request(), async () => {
      oldStarted.resolve(); await finishOld.promise;
    }).catch(() => undefined);
    await oldStarted.promise;
    const normal = coordinator.run(request(), queued);
    const emergency = coordinator.run(request(['emergency']), async () => {
      emergencyStarted.resolve(); await finishEmergency.promise;
    });
    await emergencyStarted.promise;
    try {
      finishOld.resolve(); await old;
      await Promise.resolve(); await Promise.resolve();
      expect(queued).not.toHaveBeenCalled();
    } finally { finishEmergency.resolve(); await Promise.allSettled([normal, emergency]); }
  });
});

it('constructing the core does not allocate cancellation handles', () => {
  const create = vi.fn(() => ({ abort: vi.fn() }));
  const lanes = new ExecutionLanes(create);
  expect(create).not.toHaveBeenCalled();
  expect(lanes.getCurrentCancellation('unused')).toBeUndefined();
});

it('keeps normal requests FIFO, including requests submitted during an emergency', async () => {
  const coordinator = new RequestExecutionCoordinator(); const gate = deferred();
  const order: string[] = [];
  const first = coordinator.run(request(), async () => { order.push('first'); await gate.promise; }).catch(() => undefined);
  const second = coordinator.run(request(), async () => { order.push('second'); });
  const emergency = coordinator.run(request(['emergency']), async () => { order.push('emergency'); });
  const third = coordinator.run(request(), async () => { order.push('third'); });
  await emergency;
  expect(order).toEqual(['first', 'emergency']);
  gate.resolve(); await Promise.all([first, second, third]);
  expect(order).toEqual(['first', 'emergency', 'second', 'third']);
});

it.each(['thread', 'channel'])('allows unrelated %s lanes to proceed', async difference => {
  const coordinator = new RequestExecutionCoordinator(); const gate = deferred();
  const first = coordinator.run(request(), async () => { await gate.promise; });
  const other = { ...request(), ...(difference === 'thread' ? { threadId: 'thread-b' } : { channel: 'web' as const }) };
  try { await expect(coordinator.run(other, async () => 'independent')).resolves.toBe('independent'); }
  finally { gate.resolve(); await first; }
});

it('passes cancellation to the actual runner and rejects a stale successful result', async () => {
  const coordinator = new RequestExecutionCoordinator(); const gate = deferred();
  let received!: AbortSignal;
  const first = coordinator.run(request(), async signal => { received = signal; await gate.promise; return 'stale'; });
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  await coordinator.run(request(['emergency']), async () => 'replacement');
  expect(received.aborted).toBe(true);
  gate.resolve(); await rejected;
});

it('a second emergency owns cancellation even when both predecessors finish', async () => {
  const coordinator = new RequestExecutionCoordinator();
  const a = deferred(); const b = deferred(); const c = deferred();
  let signalA!: AbortSignal; let signalB!: AbortSignal;
  const first = coordinator.run(request(), async s => { signalA = s; await a.promise; }).catch(() => undefined);
  const second = coordinator.run(request(['emergency']), async s => { signalB = s; await b.promise; }).catch(() => undefined);
  const third = coordinator.run(request(['emergency']), async () => { await c.promise; });
  const key = executionLaneKey(request()); const owner = coordinator.getAbortController(key);
  try {
    a.resolve(); b.resolve(); await Promise.all([first, second]);
    expect(signalA.aborted && signalB.aborted).toBe(true);
    expect(coordinator.getAbortController(key)).toBe(owner);
    expect(owner?.signal.aborted).toBe(false);
  } finally { c.resolve(); await third; }
  expect(coordinator.getAbortController(key)).toBeUndefined();
});

it('does not start an emergency superseded synchronously by an abort listener', async () => {
  const coordinator = new RequestExecutionCoordinator(); const gate = deferred();
  const superseded = vi.fn(async () => undefined); const latest = vi.fn(async () => undefined);
  let newest!: Promise<void>;
  const first = coordinator.run(request(), async signal => {
    signal.addEventListener('abort', () => {
      newest = coordinator.run(request(['emergency']), latest);
    }, { once: true });
    await gate.promise;
  }).catch(() => undefined);
  const second = coordinator.run(request(['emergency']), superseded);
  await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  gate.resolve(); await Promise.all([first, newest]);
  expect(superseded).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledOnce();
});

it('keeps self modification serial across channels even with emergency tags', async () => {
  const coordinator = new RequestExecutionCoordinator(); const gate = deferred();
  let signal!: AbortSignal; const next = vi.fn(async () => undefined);
  const first = coordinator.run(request(['self_mod_apply']), async s => { signal = s; await gate.promise; });
  const second = coordinator.run({ ...request(['self_mod_apply', 'emergency']), channel: 'web' }, next);
  try { expect(next).not.toHaveBeenCalled(); expect(signal.aborted).toBe(false); }
  finally { gate.resolve(); await Promise.all([first, second]); }
});

it.each(['before-submit', 'while-queued'])('does not execute a request cancelled %s', async timing => {
  const coordinator = new RequestExecutionCoordinator(); const caller = new AbortController();
  const gate = deferred(); const run = vi.fn(async () => undefined);
  const first = coordinator.run(request(), async () => { await gate.promise; });
  if (timing === 'before-submit') caller.abort();
  const second = coordinator.run(request(), run, caller.signal);
  const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
  caller.abort(); gate.resolve(); await Promise.all([first, rejected]);
  expect(run).not.toHaveBeenCalled();
});

it('propagates caller cancellation to an active request', async () => {
  const coordinator = new RequestExecutionCoordinator(); const caller = new AbortController();
  const gate = deferred(); let signal!: AbortSignal;
  const run = coordinator.run(request(), async s => { signal = s; await gate.promise; }, caller.signal);
  const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' });
  caller.abort(); expect(signal.aborted).toBe(true); gate.resolve(); await rejected;
});

it.each(['sync', 'async'])('releases a failed %s runner without poisoning the queue', async mode => {
  const coordinator = new RequestExecutionCoordinator();
  const fail = mode === 'sync'
    ? () => { throw new Error('failure'); }
    : async () => { await Promise.resolve(); throw new Error('failure'); };
  const first = coordinator.run(request(), fail);
  const rejected = expect(first).rejects.toThrow('failure');
  const second = coordinator.run(request(), async () => 42);
  await rejected; await expect(second).resolves.toBe(42);
  expect(coordinator.getAbortController(executionLaneKey(request()))).toBeUndefined();
});

it('uses world identity to serialize different Minecraft threads', () => {
  const a = { ...request(), channel: 'minecraft' as const, minecraft: { worldId: 'world-a' } };
  expect(executionLaneKey(a)).toBe(executionLaneKey({ ...a, threadId: 'other-thread' }));
  expect(executionLaneKey(a)).not.toBe(executionLaneKey({ ...a, minecraft: { worldId: 'world-b' } }));
  expect(executionLaneKey({ ...a, minecraft: { worldId: '', serverId: 'server-a' } })).toBe('minecraft-world:server-a');
});

it('rejects missing identity instead of putting unrelated requests into a default lane', async () => {
  const coordinator = new RequestExecutionCoordinator(); const run = vi.fn(async () => undefined);
  await expect(coordinator.run({ ...request(), threadId: '' }, run)).rejects.toThrow('requires a channel');
  await expect(coordinator.run({ ...request(), channel: 'minecraft', threadId: '' }, run)).rejects.toThrow('requires a world');
  expect(run).not.toHaveBeenCalled();
});

it('includes both server and world in Minecraft lanes while serializing dimensions of one bot', () => {
  const a = { ...request(), channel: 'minecraft' as const, minecraft: { serverId: 'dev:a', worldId: 'generation', dimension: 'minecraft:overworld' } };
  expect(executionLaneKey(a)).not.toBe(executionLaneKey({ ...a, minecraft: { ...a.minecraft, serverId: 'dev:b' } }));
  expect(executionLaneKey(a)).not.toBe(executionLaneKey({ ...a, minecraft: { ...a.minecraft, worldId: 'generation-2' } }));
  expect(executionLaneKey(a)).toBe(executionLaneKey({ ...a, minecraft: { ...a.minecraft, dimension: 'minecraft:the_end' } }));
});

it('does not dispatch an obsolete graph result after preemption', async () => {
  const coordinator = new RequestExecutionCoordinator(); const gate = deferred();
  const dispatch = vi.fn(async (_value: string) => undefined);
  const old = runCoordinatedGraph(coordinator, request(), async () => {
    await gate.promise; return 'old-result';
  }, dispatch);
  const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
  await runCoordinatedGraph(coordinator, request(['emergency']), async () => 'current-result', dispatch);
  gate.resolve(); await rejected;
  expect(dispatch.mock.calls).toEqual([['current-result']]);
});

it('keeps dispatch in the normal lane and preserves the caller envelope', async () => {
  const coordinator = new RequestExecutionCoordinator(); const gate = deferred(); const sending = deferred();
  const envelope = request(); const original = structuredClone(envelope);
  const first = runCoordinatedGraph(coordinator, envelope, async () => 'result', async () => {
    sending.resolve(); await gate.promise;
  });
  await sending.promise;
  const next = vi.fn(async () => 'next'); const second = coordinator.run(envelope, next);
  try { expect(next).not.toHaveBeenCalled(); }
  finally { gate.resolve(); await Promise.all([first, second]); }
  expect(envelope).toEqual(original);
});
