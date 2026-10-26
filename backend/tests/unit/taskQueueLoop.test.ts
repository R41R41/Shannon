import { describe, expect, it, vi } from 'vitest';
import { CommonFcaControlLoop, type CommonFcaActuator, type CommonFcaObserver } from '../../src/services/minebot/integration/commonFca/controlLoop.js';
import type { MinecraftControlCommand, MinecraftControlReceipt } from '../../src/services/minebot/integration/commonFca/minecraftControlContract.js';

// The task queue in the control loop (`tq/contract.md` section 3): the owner's items run one after another with up to two waiting, a
// good end starts the next at once, any other end drops what waits, and an item's limit counts from its start.
const NOW = Date.parse('2026-10-26T10:00:00Z');
const context = { scopeKey: 'owner', taskId: 'task1', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 'session1', generation: 1, goal: 'test', completionCondition: 'done' };
const lease = { id: 'lease1', generation: 1, holder: 'task1' };
const SKILLS = [{ name: 'act', description: '', inputSchema: {}, readOnly: false, maxDurationMs: 180_000 },
  { name: 'probe', description: '', inputSchema: {}, readOnly: true, maxDurationMs: 15_000 }];
/** A queue item: `act` with the envelope; the deadline is as far as the head sets it. */
const item = (id: string, name: string, after: string | null, queue: Record<string, unknown> = {}, fields: Record<string, unknown> = {}): MinecraftControlCommand => ({
  schemaVersion: 1, id, serverId: 'home', connectionId: 'connection1', kind: 'skill', context, lease, deadlineAt: new Date(NOW + 120_000).toISOString(),
  skill: 'act', arguments: { hands: [{ do: 'wait', seconds: 1 }] },
  queue: { item: name, after, node: 'p7', maxMs: 60_000, startBy: new Date(NOW + 300_000).toISOString(), ...queue }, ...fields } as MinecraftControlCommand);
const receipt = (c: MinecraftControlCommand, fields: Partial<MinecraftControlReceipt> = {}): MinecraftControlReceipt => ({ id: c.id, connectionId: c.connectionId,
  outcome: 'completed', inputsReleased: true, observedAt: new Date(NOW).toISOString(), ...fields });
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function fixture(options: { check?: CommonFcaActuator['check']; observer?: CommonFcaObserver } = {}) {
  const requests: any[] = [], responses: any[] = [];
  const running = new Map<string, { command: MinecraftControlCommand; signal: AbortSignal; finish(fields?: Partial<MinecraftControlReceipt>): void }>();
  const started: Array<{ id: string; at: number }> = [];
  let sequence = 0, clock = NOW;
  const actuator: CommonFcaActuator = {
    skills: SKILLS, observe: () => ({ schemaVersion: 1, bodyId: 'minecraft:home', sequence: ++sequence, stateAt: new Date(NOW).toISOString(), receivedAt: new Date(NOW).toISOString(),
      state: {}, facts: {}, connected: true }),
    candidates: () => [], release: vi.fn(async () => true),
    execute: vi.fn(async (command, signal) => {
      started.push({ id: command.id, at: performance.now() });
      return new Promise<MinecraftControlReceipt>(resolve => {
        const finish = (fields: Partial<MinecraftControlReceipt> = {}) => resolve(receipt(command, { outcome: signal.aborted ? 'cancelled' : 'completed', ...fields }));
        running.set(command.id, { command, signal, finish });
        signal.addEventListener('abort', () => finish(), { once: true });
      });
    }),
    progress: () => ({ hand: 2, of: 3, iteration: 1, repeat: 1 }),
    ...(options.check ? { check: options.check } : {}),
  };
  const loop = new CommonFcaControlLoop({ baseUrl: 'http://127.0.0.1:3000', token: 'fake', serverId: 'home', connectionId: 'connection1', now: () => clock, actuator,
    ...(options.observer ? { observer: options.observer } : {}),
    fetcher: vi.fn(async (_, init) => {
      requests.push(JSON.parse(init!.body as string));
      const response = responses.shift(); if (response instanceof Error) throw response;
      return new Response(JSON.stringify({ schemaVersion: 1, mode: 'common-fca', commands: [], cancel: [], acknowledged: [], ...response }));
    }) });
  const deliver = async (...commands: MinecraftControlCommand[]) => { responses.push({ commands }); await loop.poll(); await tick(); };
  /** A poll, then the receipts it carried (the last request). */
  const receipts = async () => { responses.push({}); await loop.poll(); return Object.fromEntries((requests.at(-1).receipts as MinecraftControlReceipt[]).map(r => [r.id, r])); };
  return { loop, actuator, requests, responses, running, started, deliver, receipts, advance: (ms: number) => { clock += ms; } };
}

describe('the queue: who may wait and in what order', () => {
  it('runs one item and keeps two waiting; the poll names the waiting ones and how far the running one is; a fourth is refused as full', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    await f.deliver(item('c', 'q3', 'q2'));
    expect(f.started.map(entry => entry.id)).toEqual(['a']);
    await f.loop.poll();
    expect(f.requests.at(-1)).toMatchObject({ activeOperationIds: ['a'], queuedOperationIds: ['b', 'c'], queue: { id: 'a', hand: 2, of: 3, iteration: 1, repeat: 1 } });
    await f.deliver(item('d', 'q4', 'q3'));
    expect((await f.receipts()).d).toMatchObject({ outcome: 'failed', inputsReleased: true, failureType: 'queue_full' });
    expect(f.started).toHaveLength(1);
    await f.loop.stop();
  });

  it('refuses an item whose after is not the last of the queue, and one with no after while the queue is busy; the queue stays as it was', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q9'));
    await f.deliver(item('c', 'q3', null));
    const out = await f.receipts();
    expect(out.b).toMatchObject({ outcome: 'failed', inputsReleased: true, failureType: 'queue_after_gone' });
    expect(out.c).toMatchObject({ outcome: 'failed', inputsReleased: true, failureType: 'queue_busy' });
    await f.loop.poll();
    expect(f.requests.at(-1).queuedOperationIds).toEqual([]);
    await f.deliver(item('d', 'q4', 'q1'));
    await f.loop.poll();
    expect(f.requests.at(-1).queuedOperationIds).toEqual(['d']);
    await f.loop.stop();
  });

  it('an idle body starts an item after one that ended well, and refuses one that follows a stopped or unknown item', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    f.running.get('a')!.finish(); await tick();
    await f.deliver(item('b', 'q2', 'q1'));
    expect(f.started.map(entry => entry.id)).toEqual(['a', 'b']);
    f.running.get('b')!.finish({ outcome: 'failed', failureType: 'out_of_reach' }); await tick();
    await f.deliver(item('c', 'q3', 'q2'));
    await f.deliver(item('d', 'q4', 'q77'));
    const out = await f.receipts();
    expect(out.c).toMatchObject({ failureType: 'queue_after_gone', inputsReleased: true });
    expect(out.d).toMatchObject({ failureType: 'queue_after_gone', inputsReleased: true });
    expect(f.started).toHaveLength(2);
    await f.loop.stop();
  });

  it('another owner\'s command is refused while the queue is busy, with the receipt of any refusal for an owner (not released); a command without an envelope too', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('other', 'q1', null, {}, { lease: { id: 'lease2', generation: 1, holder: 'task2' }, context: { ...context, taskId: 'task2' } }));
    await f.deliver({ ...item('plain', 'q9', null), queue: undefined } as MinecraftControlCommand);
    const out = await f.receipts();
    expect(out.other).toMatchObject({ outcome: 'failed', result: 'BODY_COMMAND_REFUSED', inputsReleased: false });
    expect(out.plain).toMatchObject({ outcome: 'failed', result: 'BODY_COMMAND_REFUSED', inputsReleased: false });
    expect(f.started).toHaveLength(1);
    await f.loop.stop();
  });

  it('an envelope that is not a well formed act item is refused as a shape (nothing ran)', async () => {
    const f = fixture();
    await f.deliver(item('x', 'qx', null, { maxMs: 5 }));
    await f.deliver(item('y', 'q1', null, { pre: [[{ k: 'bogus' }]] }));
    await f.deliver(item('z', 'q2', null, {}, { skill: 'probe' }));
    const out = await f.receipts();
    for (const id of ['x', 'y', 'z']) expect(out[id]).toMatchObject({ outcome: 'failed', result: 'BODY_COMMAND_REFUSED', inputsReleased: true });
    expect(f.started).toHaveLength(0);
    await f.loop.stop();
  });

  it('a read-only command of the owner runs beside the running item; the item\'s owner is given back when nothing runs or waits', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver({ ...item('p', 'q1', null), skill: 'probe', queue: undefined } as MinecraftControlCommand);
    expect(f.started.map(entry => entry.id)).toEqual(['a', 'p']);
    f.running.get('p')!.finish(); f.running.get('a')!.finish(); await tick(10);
    const other = { ...item('o', 'q1', null), lease: { id: 'lease2', generation: 1, holder: 'task2' }, context: { ...context, taskId: 'task2' } } as MinecraftControlCommand;
    await f.deliver(other);
    expect(f.started.map(entry => entry.id)).toEqual(['a', 'p', 'o']);
    await f.loop.stop();
  });

  it('ignores a command id it has seen', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('a', 'q1', null));
    expect(f.started).toHaveLength(1);
    await f.loop.stop();
  });
});

describe('the queue: what an end does', () => {
  it('starts the next item at once when one ends well: no poll between them (well under 50 ms)', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    const before = f.requests.length;
    const endedAt = performance.now();
    f.running.get('a')!.finish();
    await tick(2);
    expect(f.requests.length).toBe(before);
    const second = f.started.find(entry => entry.id === 'b')!;
    expect(second.at - endedAt).toBeLessThan(50);
    await f.loop.stop();
  });

  it('a failure drops every item that waits, each with a receipt that says no hand moved and which item stopped', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    await f.deliver(item('c', 'q3', 'q2'));
    f.running.get('a')!.finish({ outcome: 'failed', failureType: 'out_of_reach' }); await tick(2);
    const out = await f.receipts();
    for (const id of ['b', 'c']) {
      expect(out[id]).toMatchObject({ outcome: 'cancelled', inputsReleased: true, failureType: 'queue_dropped' });
      expect(out[id]!.result).toBe('捨てた: 前の項目 q1 が止まった（out_of_reach）。手は動いていない');
    }
    expect(f.started.map(entry => entry.id)).toEqual(['a']);
    await f.loop.stop();
  });

  it('a cancelled item (the head\'s cancel of the running one) drops the rest, and a dropped item\'s id is not usable as an `after` afterwards', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    f.responses.push({ cancel: ['a'] }); await f.loop.poll(); await tick(2);
    const out = await f.receipts();
    expect(out.a).toMatchObject({ outcome: 'cancelled' });
    expect(out.b).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped', result: '捨てた: 前の項目 q1 が止まった（cancelled）。手は動いていない' });
    await f.deliver(item('c', 'q3', 'q2'));
    expect((await f.receipts()).c).toMatchObject({ failureType: 'queue_after_gone' });
    await f.loop.stop();
  });

  it('a cancel of a waiting item removes it and the ones behind it; the running item goes on', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    await f.deliver(item('c', 'q3', 'q2'));
    f.responses.push({ cancel: ['b'] }); await f.loop.poll();
    const out = await f.receipts();
    expect(out.b).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped', result: '捨てた: 取り消された。手は動いていない', inputsReleased: true });
    expect(out.c).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped' });
    expect(f.running.get('a')!.signal.aborted).toBe(false);
    await f.loop.poll();
    expect(f.requests.at(-1)).toMatchObject({ activeOperationIds: ['a'], queuedOperationIds: [] });
    await f.loop.stop();
  });

  it('a stop command aborts the running item and drops what waits', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    await f.deliver({ ...item('s', 'q0', null), kind: 'stop', skill: undefined, queue: undefined, arguments: undefined,
      stop: { context, requestId: 'stop-1', reason: 'handoff' } } as unknown as MinecraftControlCommand);
    await tick(5);
    const out = await f.receipts();
    expect(out.a).toMatchObject({ outcome: 'cancelled' });
    expect(out.b).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped', inputsReleased: true });
    expect(f.started.map(entry => entry.id)).toEqual(['a']);
    await f.loop.stop();
  });

  it('the operator\'s stop (abortActive) and a lost API both stop the running item and drop what waits', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    expect(f.loop.abortActive()).toBe(1);
    await tick(2);
    const out = await f.receipts();
    expect(out.b).toMatchObject({ failureType: 'queue_dropped', result: '捨てた: 操作者が止めた。手は動いていない' });
    const g = fixture();
    await g.deliver(item('a', 'q1', null));
    await g.deliver(item('b', 'q2', 'q1'));
    g.advance(16_000);
    g.responses.push(new Error('network')); await expect(g.loop.poll()).rejects.toThrow();
    await tick(2);
    expect(g.running.get('a')!.signal.aborted).toBe(true);
    g.responses.push({}); await g.loop.poll();
    expect(g.requests.at(-1).receipts.find((r: any) => r.id === 'b')).toMatchObject({ failureType: 'queue_dropped', result: '捨てた: API と話せなくなった。手は動いていない' });
    await f.loop.stop(); await g.loop.stop();
  });

  it('an unknown end holds the body: what waits is dropped and says so with its inputs not released', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    f.running.get('a')!.finish({ outcome: 'unknown', inputsReleased: false }); await tick(2);
    const out = await f.receipts();
    expect(out.b).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped', inputsReleased: false });
    await f.loop.stop();
  });
});

describe('the queue: the start of an item', () => {
  it('an item whose start-by time passed when its turn came is not started, and what waits is dropped', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1', { startBy: new Date(NOW + 1000).toISOString() }));
    await f.deliver(item('c', 'q3', 'q2'));
    f.advance(2000);
    f.running.get('a')!.finish(); await tick(2);
    const out = await f.receipts();
    expect(out.b).toMatchObject({ outcome: 'cancelled', failureType: 'queue_expired', inputsReleased: true });
    expect(out.c).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped' });
    expect(f.started.map(entry => entry.id)).toEqual(['a']);
    await f.loop.stop();
  });

  it('a waiting item past its start-by time is dropped at the next poll, with the ones behind it, without waiting for the item ahead to end', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1', { startBy: new Date(NOW + 1000).toISOString() }));
    await f.deliver(item('c', 'q3', 'q2'));
    f.advance(2000);
    const out = await f.receipts();
    expect(out.b).toMatchObject({ outcome: 'cancelled', failureType: 'queue_expired', inputsReleased: true });
    expect(out.c).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped' });
    expect(f.running.get('a')!.signal.aborted).toBe(false);
    await f.loop.stop();
  });

  it('a pre that does not hold is checked right before the item starts: it is not started, says what is lacking, and what waits is dropped', async () => {
    const check = vi.fn(() => ({ ok: false, words: 'raw_iron 1/3' }));
    const f = fixture({ check });
    const pre = [[{ k: 'have', item: 'raw_iron', n: 3 }]];
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1', { pre }));
    await f.deliver(item('c', 'q3', 'q2'));
    expect(check).not.toHaveBeenCalled();
    f.running.get('a')!.finish(); await tick(2);
    expect(check).toHaveBeenCalledWith(pre);
    const out = await f.receipts();
    expect(out.b).toMatchObject({ outcome: 'failed', failureType: 'precondition', inputsReleased: true, result: '前提を満たさず始めなかった: raw_iron 1/3（手は動かしていない）' });
    expect(out.c).toMatchObject({ failureType: 'queue_dropped' });
    expect(f.started.map(entry => entry.id)).toEqual(['a']);
    // An item that starts at once is checked at once; one whose pre holds starts.
    const g = fixture({ check: () => ({ ok: true, words: '' }) });
    await g.deliver(item('a', 'q1', null, { pre }));
    expect(g.started.map(entry => entry.id)).toEqual(['a']);
    const h = fixture({ check });
    await h.deliver(item('a', 'q1', null, { pre }));
    expect((await h.receipts()).a).toMatchObject({ failureType: 'precondition', inputsReleased: true });
    // No way to check: a pre is not taken for met.
    const i = fixture();
    await i.deliver(item('a', 'q1', null, { pre }));
    expect((await i.receipts()).a).toMatchObject({ failureType: 'precondition' });
    await f.loop.stop(); await g.loop.stop(); await h.loop.stop(); await i.loop.stop();
  });

  it('the clock of an item starts when it starts: one that waited longer than its limit is not cut, and is cut after its limit from its start', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null, { maxMs: 60_000 }));
    await f.deliver(item('b', 'q2', 'q1', { maxMs: 1000 }));
    await tick(1200);
    f.running.get('a')!.finish(); await tick(5);
    const b = f.running.get('b')!;
    expect(b.signal.aborted).toBe(false);
    await tick(400);
    expect(b.signal.aborted).toBe(false);
    await tick(800);
    expect(b.signal.aborted).toBe(true);
    expect(b.signal.reason).toBe('deadline');
    await f.loop.stop();
  }, 10_000);

  it('tells the watcher: queued, started, ended (also for an item that never started)', async () => {
    const seen: string[] = [];
    const f = fixture({ observer: { commandQueued: c => seen.push(`queued ${c.id}`), commandStarted: c => seen.push(`started ${c.id}`),
      commandEnded: (c, r) => seen.push(`ended ${c.id} ${r.outcome}`) } });
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    f.running.get('a')!.finish({ outcome: 'failed' }); await tick(2);
    expect(seen).toEqual(['started a', 'queued b', 'ended a failed', 'ended b cancelled']);
    await f.loop.stop();
  });
});
