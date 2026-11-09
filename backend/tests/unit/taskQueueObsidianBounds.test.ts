import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommonFcaControlLoop, type CommonFcaActuator } from '../../src/services/minebot/integration/commonFca/controlLoop.js';
import type { MinecraftControlCommand as Command, MinecraftControlReceipt as Receipt } from '../../src/services/minebot/integration/commonFca/minecraftControlContract.js';

// Reconstructed transport fixture, not Minecraft success evidence. q110/q111 item ids,
// ordering, madeIn and 220000ms/200s are the a2 2026-11-05 envelope scalars.
// The actuator is deferred: its only physical stand-in is the signal it was given.
const NOW = Date.parse('2026-11-05T09:04:00.860Z');
const context = { scopeKey: 'owner', taskId: '8f383f48-8d03-4d35-8ac5-529c3678d711', taskRevision: 1,
  bodyId: 'minecraft:home', sessionId: '2ef8f34e-4034-46b2-9ae2-3273514010a3', generation: 1,
  goal: 'defeat the Ender Dragon', completionCondition: 'native kill', life: 1, headBoot: 'hb-9c92a381-066' };
const connectionId = '74bd0cae-e7e0-44f7-9d3a-b545a5e8c7a2';
const lease = { id: 'lease-a2', generation: 1, holder: context.taskId };
const madeIn = { life: 1, dim: 'overworld' as const, dimSince: '2026-11-05T08:38:35.349Z', bodyBoot: 'bb-1f2b118a', connectionId,
  headBoot: context.headBoot, obsSeq: 22959 };
const obsidian = (seconds = 200): Record<string, unknown> => ({ do: 'obsidian', at: [
  { x: 201, y: -57, z: 171 }, { x: 202, y: -57, z: 172 }, { x: 201, y: -57, z: 172 }], count: 6, seconds });
const item = (id: string, maxMs: number, hands: Record<string, unknown>[], fields: Partial<Command> = {}): Command => ({
  schemaVersion: 1, id, serverId: 'home', connectionId, kind: 'skill', context, lease, skill: 'act',
  deadlineAt: '2026-11-05T09:08:05.325Z', arguments: { hands },
  queue: { item: 'q111', after: null, node: 'p7', maxMs, startBy: '2026-11-05T09:04:30.324Z',
    queue: `${context.taskId}:${context.headBoot}:${context.sessionId}`, madeIn }, ...fields });
const previous = (): Command => item('prior-q110', 19_465, [{ do: 'dig', at: [{ x: 202, y: -58, z: 170 }] }], {
  queue: { ...item('shape', 1000, []).queue!, item: 'q110', after: null, maxMs: 19_465,
    startBy: '2026-11-05T09:04:06.801Z', madeIn: { ...madeIn, obsSeq: 22826 } },
});
const next = (): Command => item('next-q111', 220_000, [obsidian()], {
  queue: { ...item('shape', 220_000, []).queue!, after: 'q110' },
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const loops: CommonFcaControlLoop[] = [];
afterEach(async () => { await Promise.all(loops.splice(0).map(loop => loop.stop())); });

function fixture() {
  const requests: Array<{ receipts: Receipt[] }> = [], responses: unknown[] = [], started: string[] = [], queued: string[] = [];
  const running = new Map<string, { signal: AbortSignal; finish(fields?: Partial<Receipt>): void }>();
  let sequence = 0;
  const actuator: CommonFcaActuator = {
    skills: [{ name: 'act', description: '', inputSchema: {}, readOnly: false, maxDurationMs: 320_000 }],
    observe: () => ({ schemaVersion: 1, bodyId: context.bodyId, sequence: ++sequence,
      stateAt: new Date(NOW).toISOString(), receivedAt: new Date(NOW).toISOString(), state: {}, facts: {}, connected: true }),
    candidates: () => [], release: vi.fn(async () => true),
    execute: vi.fn(async (command, signal) => {
      started.push(command.id);
      return new Promise<Receipt>(resolve => {
        const finish = (fields: Partial<Receipt> = {}) => resolve({ id: command.id, connectionId,
          outcome: signal.aborted ? 'cancelled' : 'completed', inputsReleased: true, observedAt: new Date(NOW).toISOString(),
          unit: { goal: signal.aborted ? 'failed' : 'done', end: signal.aborted ? 'cut' : 'finished', released: true }, ...fields });
        running.set(command.id, { signal, finish });
        signal.addEventListener('abort', () => finish(), { once: true });
      });
    }),
  };
  const loop = new CommonFcaControlLoop({ baseUrl: 'http://127.0.0.1:1', token: 'fake-not-used', serverId: 'home', connectionId,
    now: () => NOW, actuator, observer: { commandQueued: command => { queued.push(command.id); } },
    fetcher: vi.fn(async (_, init) => {
      requests.push(JSON.parse(init!.body as string) as { receipts: Receipt[] });
      return new Response(JSON.stringify({ schemaVersion: 1, mode: 'common-fca', commands: [], cancel: [], acknowledged: [], ...responses.shift() as object }));
    }) });
  loops.push(loop);
  const deliver = async (...commands: Command[]) => { responses.push({ commands }); await loop.poll(); await tick(); };
  const receipts = async () => { await deliver(); return requests.at(-1)!.receipts; };
  return { loop, actuator, running, started, queued, deliver, receipts };
}

describe('obsidian queue time uses the existing public exception, without extending other hands', () => {
  it('accepts the actual 220000ms q111 behind running q110, preserves q110 and starts q111 only after its reliable end', async () => {
    const f = fixture(), a = previous(), b = next();
    await f.deliver(a);
    const signal = f.running.get(a.id)!.signal;
    await f.deliver(b);
    expect(f.queued).toEqual([b.id]);
    expect(f.started).toEqual([a.id]);
    expect(await f.receipts()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: b.id })]));
    expect(signal.aborted).toBe(false);
    expect(f.actuator.release).not.toHaveBeenCalled();
    f.running.get(a.id)!.finish(); await tick();
    expect(f.started).toEqual([a.id, b.id]);
    expect(f.running.get(b.id)!.signal.aborted).toBe(false);
    f.running.get(b.id)!.finish(); await tick();
    expect(await f.receipts()).toEqual(expect.arrayContaining([expect.objectContaining({ id: b.id, outcome: 'completed',
      inputsReleased: true, unit: expect.objectContaining({ goal: 'done', end: 'finished' }) })]));
  });

  it('keeps an actually invalid long item unsent; a later explicit cleanup still cuts its running owner (the unknown path is not weakened)', async () => {
    const f = fixture(), a = previous(), invalid = next();
    invalid.queue!.maxMs = 220_001;
    await f.deliver(a); await f.deliver(invalid);
    expect(await f.receipts()).toEqual(expect.arrayContaining([expect.objectContaining({ id: invalid.id, outcome: 'failed',
      inputsReleased: false, result: 'BODY_COMMAND_REFUSED', unit: { goal: 'not_started', end: 'not_run', released: false } })]));
    expect(f.started).toEqual([a.id]);
    expect(f.running.get(a.id)!.signal.aborted).toBe(false);
    const cleanup: Command = { ...a, id: 'explicit-cleanup', kind: 'stop', queue: undefined };
    await f.deliver(cleanup);
    expect(f.running.get(a.id)!.signal.reason).toBe('owner_release');
    expect(f.actuator.release).toHaveBeenCalledTimes(1);
    expect(await f.receipts()).toEqual(expect.arrayContaining([expect.objectContaining({ id: a.id, outcome: 'cancelled' })]));
  });

  it.each([
    ['ordinary at 180s', 180_000, [{ do: 'wait', seconds: 1 }], true],
    ['ordinary beyond 180s', 180_001, [{ do: 'wait', seconds: 1 }], false],
    ['max obsidian', 320_000, [obsidian(300)], true],
    ['beyond max obsidian', 320_001, [obsidian(300)], false],
    ['fractional seconds, integer wire below its bound', 220_000, [obsidian(200.0005)], true],
    ['integer wire above fractional bound', 220_001, [obsidian(200.0005)], false],
    ['fractional wire is still refused', 220_000.5, [obsidian(200.0005)], false],
    ['lower requested bound remains unchanged', 1000, [obsidian(300)], true],
    ['default seconds do not grant a long window', 180_001, [{ ...obsidian(), seconds: undefined }], false],
    ['seconds above the public maximum', 320_000, [obsidian(301)], false],
    ['missing source cells', 220_000, [{ ...obsidian(), at: [] }], false],
    ['too many source cells', 220_000, [{ ...obsidian(), at: Array.from({ length: 25 }, () => ({ x: 0, y: 0, z: 0 })) }], false],
    ['unknown position field', 220_000, [{ ...obsidian(), at: [{ x: 0, y: 0, z: 0, unknown: 1 }] }], false],
    ['invalid count', 220_000, [{ ...obsidian(), count: 0 }], false],
    ['invalid per-hand field', 220_000, [{ ...obsidian(), target: 'zombie' }], false],
    ['invalid placement budget', 220_000, [{ ...obsidian(), maxPlace: 101 }], false],
    ['invalid placement names', 220_000, [{ ...obsidian(), canPlace: [] }], false],
    ['too many dig names', 220_000, [{ ...obsidian(), canDig: Array.from({ length: 13 }, () => 'stone') }], false],
  ] as const)('%s', async (_, maxMs, hands, accepted) => {
    const f = fixture(), command = item('boundary', maxMs, hands as unknown as Record<string, unknown>[]);
    await f.deliver(command);
    expect(f.started).toEqual(accepted ? [command.id] : []);
    if (accepted) {
      expect(vi.mocked(f.actuator.execute).mock.calls[0]![0].queue!.maxMs).toBe(maxMs);
      f.running.get(command.id)!.finish(); await tick();
    } else expect(await f.receipts()).toEqual(expect.arrayContaining([expect.objectContaining({ id: command.id,
      result: 'BODY_COMMAND_REFUSED', inputsReleased: true, unit: { goal: 'not_started', end: 'not_run', released: true } })]));
  });

  it('does not sum obsidian hands or multiply repeat to grant more time', async () => {
    const f = fixture(), command = item('repeated', 240_000, [obsidian(200), obsidian(200)]);
    command.arguments = { ...command.arguments as object, repeat: 8 };
    await f.deliver(command);
    expect(f.started).toEqual([]);
    expect(await f.receipts()).toEqual(expect.arrayContaining([expect.objectContaining({ id: command.id, result: 'BODY_COMMAND_REFUSED' })]));
  });

  it('still holds on an unknown execution and does not automatically retry or start its queued successor', async () => {
    const f = fixture(), a = previous(), b = next();
    await f.deliver(a); await f.deliver(b);
    f.running.get(a.id)!.finish({ outcome: 'unknown', inputsReleased: false, unit: { goal: 'unknown', end: 'unknown', released: false } });
    await tick(); await f.deliver();
    expect(f.started).toEqual([a.id]);
    expect(f.loop.leaseHeld).toBe(true);
    expect(await f.receipts()).toEqual(expect.arrayContaining([expect.objectContaining({ id: a.id, outcome: 'unknown', inputsReleased: false })]));
    expect(f.actuator.execute).toHaveBeenCalledTimes(1);
  });
});
