import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import AutoSwim from '../../src/services/minebot/constantSkills/autoSwim.js';
import { executeAction, hasActiveSafetyLease, withActionSignal } from '../../src/services/minebot/execution/ActionExecution.js';
import { actionDelay } from '../../src/services/minebot/execution/observedWait.js';
import { MinebotTaskRuntime } from '../../src/services/minebot/runtime/MinebotTaskRuntime.js';
import { ConstantSkill } from '../../src/services/minebot/types/skills.js';

function fixture(): any {
  const controls = new Map<string, boolean>();
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 0), isInWater: true },
    game: { dimension: 'overworld' }, health: 20, food: 20, oxygenLevel: 7,
    inventory: { items: () => [] }, registry: { blocksByName: {} }, findBlocks: () => [],
    executingSkill: false, interruptExecution: false,
    constantSkills: { getSkill: () => undefined, getSkills: () => [] },
    clearControlStates: vi.fn(() => controls.clear()),
    setControlState: vi.fn((name: string, value: boolean) => controls.set(name, value)),
    getControlState: (name: string) => controls.get(name) ?? false,
    lookAt: vi.fn(async () => {}),
    pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
    minebotControlState: 'idle', suppressMinebotGameChat: false,
  });
  return bot;
}

function envelope(): any {
  return { channel: 'minecraft', requestId: 'main-request', sourceUserId: 'minebot-system',
    conversationId: 'minecraft:unbound', threadId: 'minecraft:unbound', tags: ['minecraft'],
    text: 'エンドラを倒す', minecraft: { dimension: 'overworld', inventory: [] }, metadata: {} };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('emergency task cancellation preserves an independent critical motor lease', () => {
  it('aborts the main task without erasing a running survival action, then releases it after recovery', async () => {
    vi.useFakeTimers();
    const bot = fixture();
    const runtime: any = new MinebotTaskRuntime(bot);
    runtime.setExecutor(async (_envelope: any, _messages: any, options: any) => {
      await new Promise(resolve => options.abortSignal.addEventListener('abort', resolve, { once: true }));
      return { taskTree: { goal: 'エンドラを倒す', status: 'in_progress' } };
    });
    const main = runtime.invoke({ taskId: 'main', envelope: envelope(), userMessage: 'エンドラを倒す' });
    const swim = new AutoSwim(bot).run();
    await vi.advanceTimersByTimeAsync(1);
    expect(hasActiveSafetyLease(bot)).toBe(true);
    expect(bot.getControlState('jump')).toBe(true);

    const preemption = runtime.interruptForEmergency('窒息');
    await vi.advanceTimersByTimeAsync(100);
    await preemption;
    await main;
    expect(runtime.isInEmergencyMode()).toBe(true);
    expect(bot.clearControlStates).not.toHaveBeenCalled();
    expect(bot.interruptExecution).toBe(false);
    expect(bot.getControlState('jump')).toBe(true);
    expect(hasActiveSafetyLease(bot)).toBe(true);

    bot.oxygenLevel = 20;
    bot.entity.isInWater = false;
    await vi.advanceTimersByTimeAsync(101);
    await swim;
    expect(bot.getControlState('jump')).toBe(false);
    expect(hasActiveSafetyLease(bot)).toBe(false);
  });

  it('lets the old physical action quiesce before swim starts and cannot clear its controls afterward', async () => {
    vi.useFakeTimers();
    const bot = fixture();
    const runtime: any = new MinebotTaskRuntime(bot);
    runtime.setExecutor(async (_envelope: any, _messages: any, options: any) => {
      await withActionSignal(bot, options.abortSignal, () => executeAction(bot, 'move-to', 1000,
        async () => { await actionDelay(bot, 500); return { success: true, result: 'arrived' }; }));
      await new Promise(resolve => options.abortSignal.addEventListener('abort', resolve, { once: true }));
      return { taskTree: { goal: 'エンドラを倒す', status: 'in_progress' } };
    });
    const main = runtime.invoke({ taskId: 'main', envelope: envelope(), userMessage: 'エンドラを倒す' });
    await vi.advanceTimersByTimeAsync(1);

    const swim = new AutoSwim(bot).run();
    await vi.advanceTimersByTimeAsync(10);
    expect(hasActiveSafetyLease(bot)).toBe(true);
    expect(bot.getControlState('jump')).toBe(true);
    // The cancelled old action may clear controls before swim takes the lease;
    // it must never do so after swim begins controlling the motor.
    bot.clearControlStates.mockClear();
    const preemption = runtime.interruptForEmergency('窒息');
    await vi.advanceTimersByTimeAsync(100);
    await preemption;
    await main;
    expect(bot.clearControlStates).not.toHaveBeenCalled();
    expect(bot.getControlState('jump')).toBe(true);

    bot.oxygenLevel = 20;
    bot.entity.isInWater = false;
    await vi.advanceTimersByTimeAsync(101);
    await swim;
  });

  it('critical low-air swim preempts an active follower rather than delegating without a safety proof', async () => {
    vi.useFakeTimers();
    const bot = fixture();
    bot.constantSkills.getSkill = (name: string) => name === 'auto-follow'
      ? { status: true, isLocked: true } : undefined;
    const swim = new AutoSwim(bot).run();
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.getControlState('jump')).toBe(true);
    expect(hasActiveSafetyLease(bot)).toBe(true);

    bot.oxygenLevel = 20;
    bot.entity.isInWater = false;
    await vi.advanceTimersByTimeAsync(101);
    await swim;
    expect(bot.getControlState('jump')).toBe(false);
  });

  it('tags any critical preempting constant and retains explicit force-stop semantics', async () => {
    vi.useFakeTimers();
    const bot = fixture();
    class OtherSurvivalAction extends ConstantSkill {
      constructor(host: any) {
        super(host); this.skillName = 'other-survival-action'; this.isCritical = true;
        this.containMovement = true;
      }
      protected shouldPreempt(): boolean { return true; }
      async runImpl(): Promise<void> { await actionDelay(this.bot, 200); }
    }
    const action = new OtherSurvivalAction(bot).run();
    await vi.advanceTimersByTimeAsync(1);
    expect(hasActiveSafetyLease(bot)).toBe(true);

    new MinebotTaskRuntime(bot).forceStop();
    expect(bot.clearControlStates).toHaveBeenCalledOnce();
    expect(bot.interruptExecution).toBe(true);
    await vi.advanceTimersByTimeAsync(201);
    await action;
    expect(hasActiveSafetyLease(bot)).toBe(false);
  });
});

describe('a reflex takes the body only from what ranks below it', () => {
  class Reflex extends ConstantSkill {
    ran = false;
    constructor(host: any, critical: boolean) {
      super(host); this.skillName = critical ? 'critical-reflex' : 'hunger-reflex'; this.isCritical = critical;
    }
    protected shouldPreempt(): boolean { return true; }
    async runImpl(): Promise<void> { this.ran = true; await actionDelay(this.bot, 50); }
  }
  const fight = (bot: any, priority?: number) => executeAction(bot, 'attack-nearest', 5000,
    async () => { await actionDelay(bot, 1000); return { success: true, result: 'defeated' }; }, { priority, waitForQuiescence: true });

  it('does not cancel an escape or counterattack, and runs once the body is free', async () => {
    vi.useFakeTimers();
    const bot = fixture();
    const counterattack = fight(bot, 200);
    await vi.advanceTimersByTimeAsync(1);
    const eat = new Reflex(bot, false);
    await eat.run();
    expect(eat.ran).toBe(false);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await counterattack).toMatchObject({ success: true, result: 'defeated' });
    const later = eat.run();
    await vi.advanceTimersByTimeAsync(60);
    await later;
    expect(eat.ran).toBe(true);
  });

  it('still takes the body from an ordinary task action', async () => {
    vi.useFakeTimers();
    const bot = fixture();
    const task = fight(bot);
    await vi.advanceTimersByTimeAsync(1);
    const eat = new Reflex(bot, false);
    const eating = eat.run();
    await vi.advanceTimersByTimeAsync(200);
    await eating;
    expect(eat.ran).toBe(true);
    expect(await task).toMatchObject({ success: false, failureType: 'interrupted' });
  });

  it('lets a critical survival reflex take the body even from an escape', async () => {
    vi.useFakeTimers();
    const bot = fixture();
    const escape = fight(bot, 200);
    await vi.advanceTimersByTimeAsync(1);
    const surface = new Reflex(bot, true);
    const surfacing = surface.run();
    await vi.advanceTimersByTimeAsync(200);
    await surfacing;
    expect(surface.ran).toBe(true);
    expect(await escape).toMatchObject({ success: false, failureType: 'interrupted' });
  });
});

describe('a cancelled action cannot keep the body for ever (paid run L29: every action after it timed out on the lock)', () => {
  it('reclaims the lease when the cancelled work never settles, and lets the next action run', async () => {
    vi.useFakeTimers();
    const bot = fixture();
    const cancelTask = vi.fn();
    bot.collectBlock = { cancelTask };
    const controller = new AbortController();
    const stuck = withActionSignal(bot, controller.signal, () => executeAction(bot, 'auto-pick-up-item', 60_000,
      () => new Promise(() => { /* a plugin call that never returns */ }), { legacyExecutingSkill: false }));
    await vi.advanceTimersByTimeAsync(10);
    controller.abort('interrupted');
    expect(await stuck).toMatchObject({ success: false, failureType: 'interrupted' });
    expect(cancelTask).toHaveBeenCalledTimes(1);
    let ran = false;
    const next = executeAction(bot, 'move-to', 5000, async () => { ran = true; return { success: true, result: 'moved' }; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ran).toBe(false); // still fenced: the lease is kept while the old action may yet settle
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await next).toMatchObject({ success: true, result: 'moved' });
    expect(cancelTask).toHaveBeenCalledTimes(2); // told to stop again when reclaimed
  });

  it('releases once only when the cancelled work settles late on its own', async () => {
    vi.useFakeTimers();
    const bot = fixture();
    const controller = new AbortController();
    let finish = () => {};
    const slow = withActionSignal(bot, controller.signal, () => executeAction(bot, 'dig-block-at', 60_000,
      () => new Promise(resolve => { finish = () => resolve({ success: true, result: 'dug' }); })));
    await vi.advanceTimersByTimeAsync(10);
    controller.abort('interrupted');
    await slow;
    const order: string[] = [];
    const a = executeAction(bot, 'move-to', 5000, async () => { order.push('a'); await actionDelay(bot, 100); return { success: true, result: 'a' }; });
    const b = executeAction(bot, 'move-to', 5000, async () => { order.push('b'); return { success: true, result: 'b' }; });
    await vi.advanceTimersByTimeAsync(3_000);
    finish(); // settles before the bound: the ordinary release
    await vi.advanceTimersByTimeAsync(20_000);
    await a; await b;
    expect(order).toEqual(['a', 'b']); // one at a time: the late settle did not release a second lease
  });
});
