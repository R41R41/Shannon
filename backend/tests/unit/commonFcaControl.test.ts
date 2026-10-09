import { describe, expect, it, vi } from 'vitest';
import { CommonFcaControlLoop, type CommonFcaActuator } from '../../src/services/minebot/integration/commonFca/controlLoop.js';
import type { MinecraftControlCommand } from '../../src/services/minebot/integration/commonFca/minecraftControlContract.js';
const NOW = Date.parse('2026-10-09T10:00:00Z');
const context = { scopeKey: 'owner', taskId: 'task1', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 'session1', generation: 1, goal: 'test', completionCondition: 'done' };
const command = (id: string, fields = {}): MinecraftControlCommand => ({ schemaVersion: 1, id, serverId: 'home', connectionId: 'connection1',
  kind: 'skill', context, lease: { id: 'lease1', generation: 1, holder: 'task1' }, deadlineAt: new Date(NOW + 1000).toISOString(), skill: 'get-health', arguments: {}, ...fields });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture() {
  const requests: any[] = [], responses: any[] = [];
  let sequence = 0;
  const actuator: CommonFcaActuator = { skills: [], observe: () => ({ schemaVersion: 1, bodyId: 'minecraft:home', sequence: ++sequence,
    stateAt: new Date(NOW).toISOString(), receivedAt: new Date(NOW).toISOString(), state: {}, facts: {}, connected: true }),
    candidates: () => [], execute: vi.fn(async c => ({ id: c.id, connectionId: c.connectionId, outcome: 'completed', inputsReleased: true, observedAt: new Date(NOW).toISOString() })),
    release: vi.fn(async () => true) };
  const loop = new CommonFcaControlLoop({ baseUrl: 'http://127.0.0.1:3000', token: 'fake-device-token', serverId: 'home', connectionId: 'connection1',
    now: () => NOW, actuator, fetcher: vi.fn(async (_, init) => { requests.push(JSON.parse(init!.body as string));
      const response = responses.shift(); if (response instanceof Error) throw response;
      return new Response(JSON.stringify({ schemaVersion: 1, mode: 'common-fca', commands: [], cancel: [], acknowledged: [], ...response })); }) });
  return { loop, requests, responses, actuator };
}
describe('common FCA body transport', () => {
  it('executes a command once and keeps delivery until exact receipt acknowledgement', async () => {
    const f = fixture(); f.responses.push({ commands: [command('one')] }); await f.loop.poll(); await tick();
    f.responses.push({ commands: [command('one')] }); await f.loop.poll();
    expect(f.actuator.execute).toHaveBeenCalledTimes(1); expect(f.requests[1].receipts[0].id).toBe('one');
    f.responses.push(new Error('lost ack')); await expect(f.loop.poll()).rejects.toThrow();
    f.responses.push({ acknowledged: ['one'] }); await f.loop.poll(); await f.loop.poll();
    expect(f.requests[4].receipts).toEqual([]); expect(f.actuator.execute).toHaveBeenCalledTimes(1);
    expect(f.requests[0].skills).toEqual([]); expect(f.requests[1].skills).toBeUndefined(); await f.loop.stop();
  });
  it('rejects wrong connection, expired actions, concurrent dispatch and other owners', async () => {
    const f = fixture(); let done!: () => void;
    f.actuator.execute = vi.fn(async (c, signal) => { await new Promise<void>(r => { done = r; }); return { id: c.id, connectionId: c.connectionId,
      outcome: signal.aborted ? 'cancelled' : 'completed', inputsReleased: true, observedAt: new Date(NOW).toISOString() }; });
    f.responses.push({ commands: [command('bad', { connectionId: 'old' }), command('expired', { deadlineAt: new Date(NOW - 1).toISOString() }), command('one'), command('two')] });
    await f.loop.poll(); await tick(); expect(f.actuator.execute).toHaveBeenCalledTimes(1);
    f.responses.push({ cancel: ['one'] }); await f.loop.poll(); done(); await tick(); await f.loop.poll();
    expect(f.requests.at(-1).receipts.find((r: any) => r.id === 'one').outcome).toBe('cancelled');
    expect(f.requests.at(-1).receipts.filter((r: any) => r.outcome === 'failed')).toHaveLength(3);
    await f.loop.stop();
  });
  it('accepts expired cleanup only for its known lease; stop keeps ownership and release fences old commands', async () => {
    const f = fixture(); f.responses.push({ commands: [command('one')] }); await f.loop.poll(); await tick();
    const stop = { context, requestId: 'stop-1', reason: 'handoff' as const };
    f.responses.push({ commands: [command('stop', { kind: 'stop', stop, deadlineAt: new Date(NOW - 1).toISOString() })] });
    await f.loop.poll(); await tick(); await f.loop.poll();
    expect(f.requests.at(-1).receipts.find((r: any) => r.id === 'stop').stop).toMatchObject({ requestId: 'stop-1', state: 'stopped', inputsReleased: true });
    f.responses.push({ commands: [command('two')] }); await f.loop.poll(); await tick(); expect(f.actuator.execute).toHaveBeenCalledTimes(2);
    f.responses.push({ commands: [command('release', { kind: 'release' })] }); await f.loop.poll(); await tick();
    f.responses.push({ commands: [command('old')] }); await f.loop.poll(); await tick(); expect(f.actuator.execute).toHaveBeenCalledTimes(2);
    await f.loop.stop();
  });
  it('never fabricates stopped acknowledgement when the actuator has not released', async () => {
    const f = fixture(); f.responses.push({ commands: [command('one')] }); await f.loop.poll(); await tick();
    f.actuator.release = vi.fn(async () => false);
    f.responses.push({ commands: [command('stop', { kind: 'stop', stop: { context, requestId: 'stop-1', reason: 'handoff' } })] });
    await f.loop.poll(); await tick(); await f.loop.poll();
    expect(f.requests.at(-1).receipts.find((r: any) => r.id === 'stop')).toMatchObject({ outcome: 'unknown', inputsReleased: false, stop: { state: 'unknown' } });
    await f.loop.stop();
  });
  it('a first stop safely acknowledges idle input release and a later session can reuse the enclosing lease', async () => {
    const f = fixture(); const stop = { context, requestId: 'initial', reason: 'handoff' };
    f.responses.push({ commands: [command('initial', { kind: 'stop', stop })] }); await f.loop.poll(); await tick();
    f.responses.push({ commands: [command('one')] }); await f.loop.poll(); await tick();
    f.responses.push({ commands: [command('release', { kind: 'release' })] }); await f.loop.poll(); await tick();
    f.responses.push({ commands: [command('next', { context: { ...context, sessionId: 'normal-step' } })] });
    await f.loop.poll(); await tick(); expect(f.actuator.execute).toHaveBeenCalledTimes(2); await f.loop.stop();
  });
  it('holds unknown execution until a confirmed cleanup, without retrying a new command ID', async () => {
    const f = fixture(); f.actuator.execute = vi.fn(async c => ({ id: c.id, connectionId: c.connectionId,
      outcome: 'unknown', inputsReleased: false, observedAt: new Date(NOW).toISOString() }));
    f.responses.push({ commands: [command('one')] }); await f.loop.poll(); await tick();
    f.responses.push({ commands: [command('two')] }); await f.loop.poll(); await tick();
    expect(f.actuator.execute).toHaveBeenCalledTimes(1);
    f.responses.push({ commands: [command('stop', { kind: 'stop' })] }); await f.loop.poll(); await tick();
    f.responses.push({ commands: [command('three')] }); await f.loop.poll(); await tick();
    expect(f.actuator.execute).toHaveBeenCalledTimes(2); await f.loop.stop();
  });
  it('an acknowledged old release never clears another session unknown fence', async () => {
    const f = fixture();
    f.responses.push({ commands: [command('a')] }); await f.loop.poll(); await tick();
    f.responses.push({ commands: [command('release-a', { kind: 'release' })] }); await f.loop.poll(); await tick();
    const other = { ...context, sessionId: 'session-b', taskId: 'task-b' }, lease = { id: 'lease-b', generation: 1, holder: 'task-b' };
    f.actuator.execute = vi.fn(async c => ({ id: c.id, connectionId: c.connectionId, outcome: 'unknown', inputsReleased: false, observedAt: new Date(NOW).toISOString() }));
    f.responses.push({ commands: [command('b', { context: other, lease })] }); await f.loop.poll(); await tick();
    f.responses.push({ commands: [command('late-release-a', { kind: 'release' })] }); await f.loop.poll(); await tick();
    f.responses.push({ commands: [command('b-again', { context: other, lease })] }); await f.loop.poll(); await tick();
    expect(f.actuator.execute).toHaveBeenCalledTimes(1); await f.loop.stop();
  });
  it('observes while skill execution is pending, aborts on disconnect, and rejects late transport adoption', async () => {
    const f = fixture(); let done!: () => void; let signal!: AbortSignal;
    f.actuator.execute = vi.fn(async (c, s) => { signal = s; await new Promise<void>(r => { done = r; }); return { id: c.id, connectionId: c.connectionId, outcome: 'unknown', inputsReleased: false, observedAt: new Date(NOW).toISOString() }; });
    f.responses.push({ commands: [command('one')] }); await f.loop.poll(); await tick();
    await f.loop.poll(); expect(f.requests[1].observation.sequence).toBeGreaterThan(f.requests[0].observation.sequence);
    expect(f.requests[1].activeOperationIds).toEqual(['one']);
    f.responses.push(new Error('disconnect')); await expect(f.loop.poll()).rejects.toThrow(); expect(signal.aborted).toBe(true);
    done(); await tick(); await f.loop.stop();
  });
});
