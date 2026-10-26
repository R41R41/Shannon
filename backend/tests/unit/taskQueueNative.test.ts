import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { CommonFcaControlLoop } from '../../src/services/minebot/integration/commonFca/controlLoop.js';
import { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
import type { MinecraftControlCommand } from '../../src/services/minebot/integration/commonFca/minecraftControlContract.js';

// The task queue with the real native body behind the loop: an item that starts while a reflex holds the body waits for it (the existing r10
// `afterReflex`), an item's limit counts from its start, the poll says how far the running act is, and a condition is checked on the bot.
const context = { scopeKey: 'owner', taskId: 'task1', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 'session1', generation: 1, goal: 'test', completionCondition: 'done' };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const item = (id: string, name: string, after: string | null, queue: Record<string, unknown> = {}, fields: Record<string, unknown> = {}): MinecraftControlCommand => ({
  schemaVersion: 1, id, serverId: 'home', connectionId: 'connection1', kind: 'skill', context, lease: { id: 'lease1', generation: 1, holder: 'task1' },
  deadlineAt: new Date(Date.now() + 600_000).toISOString(), skill: 'act', arguments: {},
  queue: { item: name, after, node: 'p7', maxMs: 60_000, startBy: new Date(Date.now() + 300_000).toISOString(), ...queue }, ...fields } as MinecraftControlCommand);

function fixture(runs: Array<(bot: any) => Promise<{ success: boolean; result: string; failureType?: string }>>) {
  let index = 0;
  const calls: Array<{ at: number }> = [];
  const act = { skillName: 'act', description: 'act', isToolForLLM: true, maxDurationMs: 180_000, params: [],
    run: vi.fn(async () => { calls.push({ at: performance.now() }); return runs[Math.min(index++, runs.length - 1)]!(bot); }) };
  const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, position: new Vec3(0, 65, 0), yaw: 0, pitch: 0, onGround: true },
    health: 20, food: 20, oxygenLevel: 20, game: { dimension: 'overworld' }, entities: {}, inventory: { items: () => [], slots: new Array(46).fill(null) }, controlState: {},
    instantSkills: { getSkills: () => [act] }, executingSkill: false, interruptExecution: false,
    clearControlStates: vi.fn(function(this: any) { this.controlState = {}; }), setControlState: vi.fn(), look: vi.fn(async () => {}), attack: vi.fn() });
  const body = new NativeCommonFcaBody(bot, { serverId: 'home', events: false, capture: async () => ({ dataUrl: 'data:image/jpeg;base64,YQ==', capturedAt: new Date().toISOString() }) });
  const requests: any[] = [], responses: any[] = [];
  const loop = new CommonFcaControlLoop({ baseUrl: 'http://127.0.0.1:3000', token: 'fake', serverId: 'home', connectionId: 'connection1', actuator: body,
    fetcher: vi.fn(async (_, init) => {
      requests.push(JSON.parse(init!.body as string));
      const response = responses.shift();
      return new Response(JSON.stringify({ schemaVersion: 1, mode: 'common-fca', commands: [], cancel: [], acknowledged: [], ...response }));
    }) });
  const deliver = async (...commands: MinecraftControlCommand[]) => { responses.push({ commands }); await loop.poll(); await wait(0); };
  const receipts = async () => { responses.push({}); await loop.poll(); return Object.fromEntries((requests.at(-1).receipts as any[]).map(r => [r.id, r])); };
  return { bot, body, loop, act, calls, requests, deliver, receipts };
}

describe('the queue on the native body', () => {
  it('an item that starts while a reflex holds the body waits for it and says so; the one after it runs normally', async () => {
    const f = fixture([() => wait(60).then(() => ({ success: true, result: 'a done' })), async () => ({ success: true, result: 'b done' })]);
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    expect(f.act.run).toHaveBeenCalledTimes(1);
    // A reflex takes the body while the first item runs, and holds it when the first ends.
    f.bot.floorReflexes = { retreat: { engaged: true, ticks: 0, cooldown: 0, engagements: 1 }, busy: null, retryAt: 0, engagements: { eat: 0, armor: 0 } };
    await wait(250);
    expect(f.act.run).toHaveBeenCalledTimes(1);
    const released = performance.now();
    f.bot.floorReflexes.retreat.engaged = false;
    await wait(400);
    expect(f.act.run).toHaveBeenCalledTimes(2);
    expect(f.calls[1]!.at - released).toBeLessThan(400);
    const out = await f.receipts();
    expect(out.a).toMatchObject({ outcome: 'completed', inputsReleased: true });
    expect(out.b).toMatchObject({ outcome: 'completed', inputsReleased: true });
    expect(out.b.result).toContain('放された後に始めた');
    await f.loop.stop(); await f.body.dispose();
  });

  it('an item whose command deadline is 600 s away is accepted (a plain act that far is refused)', async () => {
    const f = fixture([async () => ({ success: true, result: 'ok' })]);
    await f.deliver(item('a', 'q1', null, { maxMs: 1000 }));
    await wait(60);
    const out = await f.receipts();
    expect(out.a).toMatchObject({ outcome: 'completed' });
    await f.deliver({ ...item('plain', 'q9', null), queue: undefined } as unknown as MinecraftControlCommand);
    expect((await f.receipts()).plain).toMatchObject({ result: 'BODY_COMMAND_REFUSED', inputsReleased: true });
    await f.loop.stop(); await f.body.dispose();
  });

  it('a queued item is cut at its maxMs counted from its start, not from when it was handed over', async () => {
    const signals = new Map<string, AbortSignal>();
    const f = fixture([() => wait(600).then(() => ({ success: true, result: 'first' })),
      () => new Promise(resolve => signals.get('b')!.addEventListener('abort', () => resolve({ success: false, result: 'cut', failureType: 'timeout' })))]);
    const execute = f.body.execute.bind(f.body);
    f.body.execute = (command, signal) => { signals.set(command.id, signal); return execute(command, signal); };
    await f.deliver(item('a', 'q1', null, { maxMs: 5000 }));
    await f.deliver(item('b', 'q2', 'q1', { maxMs: 1000 }));
    await wait(900);
    // b was handed over 900 ms ago (its limit is 1000 ms) and started after a, 300 ms ago: it runs on.
    expect(f.act.run).toHaveBeenCalledTimes(2);
    expect(signals.get('b')!.aborted).toBe(false);
    await wait(900);
    expect(signals.get('b')!.aborted).toBe(true);
    expect(signals.get('b')!.reason).toBe('deadline');
    await f.loop.stop(); await f.body.dispose();
  }, 15_000);

  it('the poll says how far the running act is, from its step events, and nothing once it ended', async () => {
    const f = fixture([async (bot: any) => {
      bot.emit('minebotActStep', { startedAt: 1, index: 2, total: 5, label: 'dig', status: 'in_progress', detail: '', iteration: 3, repeat: 8 });
      await wait(120);
      return { success: true, result: 'ok' };
    }]);
    await f.deliver(item('a', 'q1', null));
    await wait(30);
    await f.loop.poll();
    expect(f.requests.at(-1)).toMatchObject({ activeOperationIds: ['a'], queue: { id: 'a', hand: 3, of: 5, iteration: 3, repeat: 8 } });
    await wait(200);
    await f.loop.poll();
    expect(f.requests.at(-1).queue).toBeUndefined();
    await f.loop.stop(); await f.body.dispose();
  });

  it('checks a condition on the bot: yes or no, and what is lacking', async () => {
    const f = fixture([async () => ({ success: true, result: 'ok' })]);
    f.bot.health = 12;
    expect(f.body.check([[{ k: 'hp', n: 10 }]])).toEqual({ ok: true, words: '' });
    expect(f.body.check([[{ k: 'hp', n: 15 }]])).toEqual({ ok: false, words: '体力 12/15' });
    await f.body.dispose();
  });

  it('a pre that does not hold is not run: the loop asks the native body, and the receipt says what is lacking', async () => {
    const f = fixture([async () => ({ success: true, result: 'ok' })]);
    await f.deliver(item('a', 'q1', null, { pre: [[{ k: 'hp', n: 15 }, { k: 'food', n: 99 }]] }));
    const out = await f.receipts();
    expect(out.a).toMatchObject({ outcome: 'failed', failureType: 'precondition', inputsReleased: true });
    expect(out.a.result).toBe('前提を満たさず始めなかった: 食料 0/99 点（手は動かしていない）');
    expect(f.act.run).not.toHaveBeenCalled();
    await f.loop.stop(); await f.body.dispose();
  });
});
