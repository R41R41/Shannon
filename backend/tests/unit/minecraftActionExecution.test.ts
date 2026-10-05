import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { SkillExecutor } from '../../src/services/minebot/execution/SkillExecutor.js';
import { executeAction, actionSignal, bindActionCallback, cancelActiveActions, reportActionProgress, withActionSignal } from '../../src/services/minebot/execution/ActionExecution.js';
import { waitForObservation, actionDelay } from '../../src/services/minebot/execution/observedWait.js';
import { collectDrops, expectedBlockDrops, pickupGoal } from '../../src/services/minebot/execution/collectDrops.js';
import { backgroundJobs } from '../../src/services/minebot/execution/backgroundJobs.js';
import { ExecutionSupervisor } from '../../src/services/minebot/cognition/ExecutionSupervisor.js';
import { gotoSafe } from '../../src/services/minebot/utils/gotoSafe.js';
import { TaskWorkspace } from '../../src/services/minebot/cognition/TaskWorkspace.js';
import MineBlock from '../../src/services/minebot/instantSkills/mineBlock.js';
import PlaceBlockAt from '../../src/services/minebot/instantSkills/placeBlockAt.js';
import Withdraw from '../../src/services/minebot/instantSkills/withdrawFromFurnace.js';
import type { CriticAssessment } from '../../src/services/minebot/cognition/types.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const ok = { success: true, result: 'ok' };
const host = () => Object.assign(new EventEmitter(), {
  executingSkill: false, interruptExecution: false,
  clearControlStates: vi.fn(), stopDigging: vi.fn(), deactivateItem: vi.fn(),
  pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
});
const deferred = <T>() => { let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

describe('action ownership and observation', () => {
  it('reports a non-quiescent cancelled body without granting its physical lease to a successor', async () => {
    vi.useFakeTimers();
    try {
      const bot = host(); const finish = deferred<typeof ok>(); const progress: any[] = [];
      bot.on('minebotActionProgress', value => progress.push(value));
      const run = executeAction(bot, 'mine-block', 0, async () => finish.promise);
      await flush(); cancelActiveActions(bot); await run;
      let successor = false;
      const next = executeAction(bot, 'craft-one', 0, async () => { successor = true; return ok; });
      await vi.advanceTimersByTimeAsync(2001);
      expect(progress.some(p => p.evidence.containment === 'body_not_quiescent' && p.evidence.leaseRetained)).toBe(true);
      expect(successor).toBe(false);
      finish.resolve(ok); await flush(); expect((await next).success).toBe(true);
      expect(successor).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('binds native updates to the registering action and ignores updates after completion', async () => {
    const bot = host(); const protocol = new EventEmitter(); const finish = deferred<typeof ok>();
    let expectedSignal: AbortSignal | undefined; const signals: Array<AbortSignal | undefined> = [];
    const run = executeAction(bot, 'withdraw-from-furnace', 0, async () => {
      expectedSignal = actionSignal(bot);
      protocol.on('update', bindActionCallback(bot, (count: number) => {
        signals.push(actionSignal(bot));
        reportActionProgress(bot, 'wait_external', { outputCount: count }, true, 'waiting_external');
      }));
      return finish.promise;
    });
    await flush();
    // The TCP/protocol emitter, unlike action-created timers, has no action ALS.
    expect(actionSignal(bot)).toBeUndefined(); protocol.emit('update', 2);
    finish.resolve(ok); const result = await run;
    expect(signals).toEqual([expectedSignal]);
    expect(result.execution?.events).toContainEqual(expect.objectContaining({
      phase: 'wait_external', status: 'waiting_external', evidence: { outputCount: 2 },
    }));
    protocol.emit('update', 3); expect(signals).toHaveLength(1);
  });
  it('does not let a native callback publish progress after its action is cancelled', async () => {
    const bot = host(); const protocol = new EventEmitter(); const finish = deferred<typeof ok>();
    const callback = vi.fn();
    const run = executeAction(bot, 'withdraw-from-furnace', 0, async () => {
      protocol.on('update', bindActionCallback(bot, callback)); return finish.promise;
    });
    await flush(); cancelActiveActions(bot); await run;
    protocol.emit('update'); expect(callback).not.toHaveBeenCalled();
    finish.resolve(ok); await flush();
  });
  it('ignores a completed child callback even while its parent action continues', async () => {
    const bot = host(); const callback = vi.fn();
    expect((await executeAction(bot, 'mine-block', 0, async () => {
      let update!: () => void;
      await executeAction(bot, 'dig-block-at', 0, async () => {
        update = bindActionCallback(bot, callback); update(); return ok;
      });
      update(); expect(callback).toHaveBeenCalledTimes(1); return ok;
    })).success).toBe(true);
  });
  it('consumes a deferred pathfinder stop before allowing the next dig', async () => {
    vi.useFakeTimers();
    try {
      const bot: any = Object.assign(host(), { entity: { position: new Vec3(0, 100, 0) } });
      let deferredStop = false;
      bot.pathfinder.stop = () => { deferredStop = true; };
      bot.pathfinder.setGoal = (goal: unknown) => {
        bot.emit('goal_updated', goal); deferredStop = false;
      };
      bot.pathfinder.goto = () => new Promise<void>((_resolve, reject) => {
        bot.once('goal_updated', () => reject(new Error('Goal changed')));
      });
      const move = gotoSafe(bot, { constructor: { name: 'test-goal' } } as any,
        { timeoutMs: 20, tryRecover: false });
      await vi.advanceTimersByTimeAsync(20);
      expect(await move).toMatchObject({ success: false, error: 'timeout' });
      expect(deferredStop).toBe(false); expect(bot.listenerCount('goal_updated')).toBe(0);
      expect(await executeAction(bot, 'dig-block-at', 0, async () => {
        expect(deferredStop).toBe(false); return ok;
      })).toMatchObject({ success: true });
    } finally { vi.useRealTimers(); }
  });
  it.each(['isMining', 'isBuilding'] as const)('does not interrupt productive cave terrain work (%s)', async state => {
    vi.useFakeTimers();
    try {
      const bot: any = Object.assign(host(), { entity: { position: new Vec3(0, 53, 0) } });
      const destination = deferred<void>();
      bot.pathfinder.goto = () => destination.promise;
      bot.pathfinder.isMoving = () => true;
      bot.pathfinder.isMining = () => state === 'isMining';
      bot.pathfinder.isBuilding = () => state === 'isBuilding';
      const move = gotoSafe(bot, { constructor: { name: 'test-goal' } } as any,
        { timeoutMs: 8000, tryRecover: false });
      await vi.advanceTimersByTimeAsync(5000);
      expect(bot.pathfinder.stop).not.toHaveBeenCalled();
      destination.resolve();
      expect(await move).toMatchObject({ success: true });
    } finally { vi.useRealTimers(); }
  });
  it.each(['isMining', 'isBuilding'] as const)('calls terrain work that takes the body nowhere stuck, and says what it was doing (%s; paid runs L50 and L52 held one spot for a whole move)', async state => {
    vi.useFakeTimers();
    try {
      const bot: any = Object.assign(host(), { entity: { position: new Vec3(0, 53, 0) }, blockAt: () => null,
        targetDigBlock: state === 'isMining' ? { name: 'stone', position: new Vec3(1, 53, 0) } : null, digTime: () => 1150 });
      bot.pathfinder.goto = () => new Promise<void>(() => {});
      bot.pathfinder.isMoving = () => true;
      bot.pathfinder.isMining = () => state === 'isMining';
      bot.pathfinder.isBuilding = () => state === 'isBuilding';
      const move = gotoSafe(bot, { constructor: { name: 'test-goal' } } as any, { timeoutMs: 30_000, tryRecover: false });
      await vi.advanceTimersByTimeAsync(7500);
      expect(bot.pathfinder.stop).not.toHaveBeenCalled();           // within what two slow digs and a step can take
      await vi.advanceTimersByTimeAsync(1500);
      const result = await move;
      expect(result).toMatchObject({ success: false, error: 'stuck' });
      expect(result.activity).toContain(state === 'isMining' ? 'stone(1, 53, 0)を掘削中' : '足場ブロックの設置中');
      expect(result.activity).toContain('進まず');
    } finally { vi.useRealTimers(); }
  });
  it('gives a slow dig the time its tool needs, and keeps working while each block is followed by a step', async () => {
    vi.useFakeTimers();
    try {
      // Obsidian by diamond pickaxe: 9.4s a block.
      const bot: any = Object.assign(host(), { entity: { position: new Vec3(0, 53, 0) }, blockAt: () => null,
        targetDigBlock: { name: 'obsidian', position: new Vec3(1, 53, 0) }, digTime: () => 9400 });
      const destination = deferred<void>();
      bot.pathfinder.goto = () => destination.promise;
      bot.pathfinder.isMoving = () => true; bot.pathfinder.isMining = () => true; bot.pathfinder.isBuilding = () => false;
      const move = gotoSafe(bot, { constructor: { name: 'test-goal' } } as any, { timeoutMs: 120_000, tryRecover: false });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(bot.pathfinder.stop).not.toHaveBeenCalled();
      // Then a quick block on the same spot: the bound set by the slow one still stands.
      bot.digTime = () => 1150;
      await vi.advanceTimersByTimeAsync(5000);
      expect(bot.pathfinder.stop).not.toHaveBeenCalled();
      // A tunnel through stone: a block every 2.5s, a step after each.
      const tunnel = setInterval(() => { bot.entity.position.x += 1; }, 2500);
      await vi.advanceTimersByTimeAsync(30_000);
      clearInterval(tunnel);
      expect(bot.pathfinder.stop).not.toHaveBeenCalled();
      destination.resolve();
      expect(await move).toMatchObject({ success: true });
    } finally { vi.useRealTimers(); }
  });
  it('calls an executor that neither walks nor works stuck (the path library waited on a stale return position; paid run L51 was shot standing there)', async () => {
    vi.useFakeTimers();
    try {
      const bot: any = Object.assign(host(), { entity: { position: new Vec3(0, 93, 0) }, blockAt: () => null });
      bot.pathfinder.goto = () => new Promise<void>(() => {});
      bot.pathfinder.isMoving = () => false; bot.pathfinder.isMining = () => false; bot.pathfinder.isBuilding = () => false;
      const move = gotoSafe(bot, { constructor: { name: 'test-goal' } } as any, { timeoutMs: 30_000, tryRecover: false });
      await vi.advanceTimersByTimeAsync(7000);
      expect(bot.pathfinder.stop).not.toHaveBeenCalled();           // a path search may take this long
      await vi.advanceTimersByTimeAsync(2000);
      const result = await move;
      expect(result).toMatchObject({ success: false, error: 'stuck' });
      expect(result.activity).toContain('経路を探索中のまま');
    } finally { vi.useRealTimers(); }
  });
  it('reports what the executor was doing when a move runs out of time', async () => {
    vi.useFakeTimers();
    try {
      const bot: any = Object.assign(host(), { entity: { position: new Vec3(0, 53, 0) }, blockAt: () => null });
      bot.pathfinder.goto = () => new Promise<void>(() => {});
      bot.pathfinder.isMoving = () => false; bot.pathfinder.isMining = () => false; bot.pathfinder.isBuilding = () => false;
      const move = gotoSafe(bot, { constructor: { name: 'test-goal' } } as any, { timeoutMs: 3000, tryRecover: false });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await move).toMatchObject({ success: false, error: 'timeout', activity: '経路を探索中' });
    } finally { vi.useRealTimers(); }
  });
  it('still detects a genuinely idle pathfinder when no terrain work is active', async () => {
    vi.useFakeTimers();
    try {
      const bot: any = Object.assign(host(), { entity: { position: new Vec3(0, 53, 0) } });
      bot.pathfinder.goto = () => new Promise<void>(() => {});
      bot.pathfinder.isMoving = () => true;
      bot.pathfinder.isMining = () => false;
      bot.pathfinder.isBuilding = () => false;
      bot.blockAt = () => null;
      const move = gotoSafe(bot, { constructor: { name: 'test-goal' } } as any,
        { timeoutMs: 8000, tryRecover: false });
      await vi.advanceTimersByTimeAsync(1500);
      expect(await move).toMatchObject({ success: false, error: 'stuck' });
      expect(bot.pathfinder.stop).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('accepts slow but real vertical cave progress over a macro window', async () => {
    vi.useFakeTimers();
    try {
      const bot: any = Object.assign(host(), { entity: { position: new Vec3(0, 53, 0) } });
      const destination = deferred<void>();
      bot.pathfinder.goto = () => destination.promise;
      bot.pathfinder.isMoving = () => true;
      bot.pathfinder.isMining = () => false;
      bot.pathfinder.isBuilding = () => false;
      const move = gotoSafe(bot, { constructor: { name: 'test-goal' } } as any,
        { timeoutMs: 5000, tryRecover: false, stuckThreshold: 0.1 });
      const ascent = setInterval(() => { bot.entity.position.y += 0.2; }, 500);
      await vi.advanceTimersByTimeAsync(3100);
      clearInterval(ascent);
      expect(bot.pathfinder.stop).not.toHaveBeenCalled();
      destination.resolve();
      expect(await move).toMatchObject({ success: true });
    } finally { vi.useRealTimers(); }
  });
  it('grants exactly one conflicting queued lease at a time and releases idempotently', async () => {
    const engine = new SkillExecutor();
    const first = await engine.acquire('dig-block-at');
    const second = engine.acquire('mine-block');
    let thirdGranted = false;
    const third = engine.acquire('dig-block-at').then(release => { thirdGranted = true; return release; });
    first(); first();
    const releaseSecond = await second;
    await flush();
    expect(thirdGranted).toBe(false);
    expect(engine.getStatus()).toEqual({ activeLocks: ['mining'], waitQueue: 1 });
    releaseSecond();
    (await third)();
    expect(engine.getStatus()).toEqual({ activeLocks: [], waitQueue: 0 });
  });
  it('removes aborted and timed-out waiters instead of granting ghost leases', async () => {
    vi.useFakeTimers();
    try {
      const engine = new SkillExecutor();
      const release = await engine.acquire('mine-block');
      const signal = new AbortController();
      const aborted = engine.acquire('craft-one', signal.signal);
      const rejected = expect(aborted).rejects.toThrow('interrupted');
      signal.abort(); await rejected;
      const timed = engine.acquire('craft-one');
      const timeout = expect(timed).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(30_001); await timeout;
      expect(engine.getStatus().waitQueue).toBe(0); release();
      const next = await engine.acquire('craft-one'); next();
    } finally { vi.useRealTimers(); }
  });
  it('does not permit movement to steal an open-window or digging resource', async () => {
    const engine = new SkillExecutor();
    const release = await engine.acquire('craft-one');
    expect(engine.canExecute('move-to')).toBe(false);
    expect(engine.canExecute('check-container')).toBe(false);
    expect(engine.canExecute('check-furnace')).toBe(false);
    expect(engine.canExecute('get-background-jobs')).toBe(true);
    expect(engine.resourcesFor('mine-block')).toContain('hand');
    release();
  });
  it('shares immutable parent cancellation with nested skills without deadlocking', async () => {
    const bot = host(); let linkedSignal = false; let childSignal: AbortSignal | undefined;
    const run = executeAction(bot, 'mine-block', 1000, async () => {
      const parent = actionSignal(bot);
      return executeAction(bot, 'dig-block-at', 1000, async () => {
        childSignal = actionSignal(bot); linkedSignal = parent !== childSignal;
        await actionDelay(bot, 500); return ok;
      });
    });
    await flush(); cancelActiveActions(bot);
    expect(await run).toMatchObject({ success: false, failureType: 'interrupted' });
    await flush(); expect(linkedSignal).toBe(true); expect(childSignal?.aborted).toBe(true); expect(bot.executingSkill).toBe(false);
    expect(await executeAction(bot, 'dig-block-at', 1000, async () => ok)).toMatchObject({ success: true });
  });
  it('preserves a child deadline and lets the live parent recover after it settles', async () => {
    vi.useFakeTimers();
    try {
      const bot = host();
      const run = executeAction(bot, 'mine-block', 1000, async () => {
        const child = await executeAction(bot, 'move-to', 50, async () => { await actionDelay(bot, 200); return ok; });
        expect(child.failureType).toBe('timeout');
        expect(actionSignal(bot)?.aborted).toBe(false);
        return executeAction(bot, 'move-to', 100, async () => ok);
      });
      await vi.advanceTimersByTimeAsync(60);
      expect((await run).success).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('keeps the lease until a non-cooperative cancelled body actually settles', async () => {
    const bot = host(); const finish = deferred<typeof ok>();
    const first = executeAction(bot, 'mine-block', 0, () => finish.promise);
    await flush(); cancelActiveActions(bot);
    const cancelled = await first;
    expect(cancelled.execution?.quiescent).toBe(false);
    let nextStarted = false;
    const next = executeAction(bot, 'move-to', 1000, async () => { nextStarted = true; return ok; });
    await flush(); expect(nextStarted).toBe(false); expect(bot.executingSkill).toBe(true);
    const query = await executeAction(bot, 'get-position', 1000, async () => ok);
    expect(query.success).toBe(true); expect(bot.interruptExecution).toBe(true);
    expect(bot.executingSkill).toBe(true);
    finish.resolve(ok); expect((await next).success).toBe(true);
    expect(bot.executingSkill).toBe(false);
  });
  it('isolates different bots and respects an already cancelled task signal', async () => {
    const first = host(); const other = host(); const finish = deferred<typeof ok>();
    const running = executeAction(first, 'mine-block', 0, () => finish.promise); await flush();
    expect((await executeAction(other, 'mine-block', 1000, async () => ok)).success).toBe(true);
    const controller = new AbortController(); controller.abort(); const body = vi.fn(async () => ok);
    expect((await withActionSignal(other, controller.signal, () => executeAction(other, 'mine-block', 1000, body))).success).toBe(false);
    expect(body).not.toHaveBeenCalled(); finish.resolve(ok); await running;
  });
  it('returns timeout distinctly and records non-overlapping phase timing', async () => {
    vi.useFakeTimers();
    try {
      const bot = host();
      const run = executeAction(bot, 'mine-block', 100, async () => {
        reportActionProgress(bot, 'search'); await actionDelay(bot, 40);
        reportActionProgress(bot, 'dig'); await actionDelay(bot, 200); return ok;
      });
      await vi.advanceTimersByTimeAsync(105);
      expect(await run).toMatchObject({ failureType: 'timeout' });
      expect(bot.executingSkill).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('subscribes before reading and cleans up after immediate, event, timeout and abort outcomes', async () => {
    const source = new EventEmitter(); let ready = false;
    expect(await waitForObservation({}, () => true, 100, [{ source, event: 'changed' }])).toBe(true);
    const wait = waitForObservation({}, () => ready, 100, [{ source, event: 'changed' }]);
    ready = true; source.emit('changed'); expect(await wait).toBe(true);
    expect(await waitForObservation({}, () => false, 1, [{ source, event: 'changed' }])).toBe(false);
    const controller = new AbortController();
    const aborted = waitForObservation({}, () => false, 100, [{ source, event: 'changed' }], controller.signal);
    const rejected = expect(aborted).rejects.toThrow('interrupted'); controller.abort(); await rejected;
    expect(source.listenerCount('changed')).toBe(0);
  });
  it('refuses missing or insufficient tools before doing a radius scan', async () => {
    const data = minecraftData('1.21.11');
    for (const items of [[], [{ name: 'wooden_pickaxe', type: data.itemsByName.wooden_pickaxe.id, count: 1 }]]) {
      const bot: any = { version: '1.21.11', inventory: { items: () => items },
        instantSkills: { getSkill: () => ({}) }, findBlocks: vi.fn() };
      expect(await new MineBlock(bot).runImpl('iron_ore', 3, 64)).toMatchObject({ failureType: 'missing_tool' });
      expect(bot.findBlocks).not.toHaveBeenCalled();
    }
  });
});

describe('goal-scoped drops', () => {
  it('uses true item-to-walking-centre distance instead of a rounded one-block radius', () => {
    const bot: any = { blockAt: () => ({ boundingBox: 'empty' }) };
    const edgeLoot = pickupGoal(bot, new Vec3(2.875, 100, -3.875));
    expect(edgeLoot.isEnd({ x: 1, y: 100, z: -4 } as any)).toBe(false);
    expect(edgeLoot.isEnd({ x: 2, y: 100, z: -4 } as any)).toBe(true);
    const underCanopy = pickupGoal(bot, new Vec3(24.1, 100.1, 0.5));
    expect(underCanopy.isEnd({ x: 23, y: 100, z: 0 } as any)).toBe(true);
    expect(underCanopy.isEnd({ x: 25, y: 100, z: 0 } as any)).toBe(false);
  });
  it('does not report unrelated seeds as recovered logs in the parent mining result', async () => {
    const registry = minecraftData('1.21.11'); const items: any[] = [];
    let dug = false;
    const bot: any = Object.assign(host(), { version: '1.21.11', registry, entities: {},
      entity: { position: new Vec3(0, 100, 0) },
      inventory: { items: () => items, emptySlotCount: () => 36 },
      blockAt: () => ({ name: dug ? 'air' : 'oak_log' }), findBlocks: () => [new Vec3(1, 100, 0)],
      instantSkills: { getSkill: (name: string) => ({ run: async () => {
        if (name === 'dig-block-at') { dug = true; items.push({ name: 'wheat_seeds', count: 6 }); }
        return ok;
      } }) } });
    expect(await new MineBlock(bot).runImpl('oak_log', 1, 8)).toMatchObject({ failureType: 'drops_lost' });
    expect(items).toEqual([{ name: 'wheat_seeds', count: 6 }]);
  });
  it('uses versioned loot IDs for ore, stone and logs', () => {
    const registry = minecraftData('1.21.11');
    const bot: any = { registry };
    expect(expectedBlockDrops(bot, { name: 'iron_ore' })).toContain('raw_iron');
    expect(expectedBlockDrops(bot, { name: 'stone' })).toContain('cobblestone');
    expect(expectedBlockDrops(bot, { name: 'oak_log' })).toContain('oak_log');
  });
  it.each(['target', 'all'] as const)('collects according to %s policy without unconditional delays', async policy => {
    const registry = minecraftData('1.21.11'); let inventory: any[] = [];
    const seed = { id: 1, name: 'item', isValid: true, position: new Vec3(4, 100, 0), getDroppedItem: () => ({ name: 'wheat_seeds' }) };
    const log = { id: 2, name: 'item', isValid: true, position: new Vec3(2, 100, 0), getDroppedItem: () => ({ name: 'oak_log' }) };
    const bot: any = Object.assign(host(), { registry, entity: { position: new Vec3(0, 100, 0) }, entities: { 1: seed, 2: log },
      blockAt: () => ({ boundingBox: 'empty' }), inventory: Object.assign(new EventEmitter(), { items: () => inventory }) });
    bot.pathfinder.goto = vi.fn(async (goal: any) => {
      const entity = goal.x === 2 ? log : seed;
      bot.entity.position = entity.position;
      delete bot.entities[entity.id];
      inventory.push({ name: entity.getDroppedItem().name, count: 1 });
      bot.inventory.emit('updateSlot');
    });
    const start = Date.now();
    const result = await collectDrops(bot, { origins: [new Vec3(2, 100, 0)], expectedItems: ['oak_log'],
      beforeInventory: new Map(), beforeEntityIds: new Set([1]), policy });
    expect(result).toContain('oak_logx1');
    expect(result.includes('wheat_seedsx1')).toBe(policy === 'all');
    expect(Date.now() - start).toBeLessThan(300);
    expect(bot.listenerCount('entitySpawn')).toBe(0);
  });
  it('does not accept unrelated inventory gain as the requested pickup', async () => {
    const bot: any = Object.assign(host(), { registry: minecraftData('1.21.11'), entities: {},
      inventory: Object.assign(new EventEmitter(), { items: () => [{ name: 'wheat_seeds', count: 6 }] }) });
    const start = Date.now();
    expect(await collectDrops(bot, { origins: [new Vec3(0, 100, 0)], expectedItems: ['oak_log'],
      beforeInventory: new Map(), beforeEntityIds: new Set(), timeoutMs: 20 })).toEqual([]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});

const assessment = (input: any, override: Partial<CriticAssessment> = {}): CriticAssessment => ({
  id: 'test-assessment', runId: input.runId, evaluatedRevision: input.evaluatedRevision,
  receivedAt: new Date().toISOString(), elapsedMilliseconds: 5, source: 'jev', stale: false,
  progressState: 'STALLED', continueProbability: 0.1, needsObservationProbability: 0.1,
  needsReplanProbability: 0.9, failureCause: 'BLOCKED_PATH', nextControl: 'REPLAN', confidence: 0.9, ...override });

describe('live independent supervision', () => {
  it.each(['shadow', 'feedback'] as const)('evaluates a running skill in %s without waiting for it to finish', async mode => {
    const bot: any = Object.assign(host(), { health: 20, food: 20, entities: {}, inventory: { items: () => [] } });
    const workspace = new TaskWorkspace({ runId: 'test', goal: 'collect logs' });
    const assess = vi.fn(async input => assessment(input));
    const supervisor = new ExecutionSupervisor({ bot, workspace, mode, critic: { source: 'jev', assess }, minimumRequestMs: 0 });
    supervisor.start(); const finish = deferred<typeof ok>();
    const run = executeAction(bot, 'mine-block', 0, async () => {
      reportActionProgress(bot, 'recovery', { reason: 'no_path' }, false, 'blocked');
      return finish.promise;
    });
    await flush(); await supervisor.drain();
    expect(assess).toHaveBeenCalledOnce();
    expect(assess.mock.calls[0][0].activeAction.phase).toBe('recovery');
    expect(supervisor.assessments[0].applied).toBe(mode === 'feedback');
    finish.resolve(ok); await run; await flush(); supervisor.stop();
    expect(bot.listenerCount('minebotActionProgress')).toBe(0);
  });
  it.each(['progress', 'health', 'settled', 'fallback'] as const)('rejects unsafe application when %s changes', async change => {
    const bot: any = Object.assign(host(), { health: 20, food: 20, entities: {}, inventory: { items: () => [] } });
    const workspace = new TaskWorkspace({ runId: 'test', goal: 'goal' });
    const result = deferred<CriticAssessment>(); const finish = deferred<typeof ok>(); let input: any;
    const supervisor = new ExecutionSupervisor({ bot, workspace, mode: 'feedback',
      critic: { source: 'jev', assess: async i => { input = i; return result.promise; } }, minimumRequestMs: 0 });
    supervisor.start(); const run = executeAction(bot, 'mine-block', 0, async () => {
      reportActionProgress(bot, 'recovery', {}, false, 'blocked');
      if (change === 'progress') { await new Promise(r => setTimeout(r, 2)); reportActionProgress(bot, 'dig', {}, true); }
      return finish.promise;
    });
    await flush();
    if (change === 'progress') await new Promise(r => setTimeout(r, 5));
    if (change === 'health') bot.health = 8;
    if (change === 'settled') { finish.resolve(ok); await run; }
    result.resolve(assessment(input, change === 'fallback' ? { source: 'fallback' } : {}));
    await supervisor.drain();
    expect(supervisor.assessments[0].applied).toBe(false);
    expect(supervisor.assessments[0].rejected).not.toBeNull();
    finish.resolve(ok); await run; supervisor.stop();
  });
});

describe('background game work', () => {
  it('confirms open-furnace inventory instead of waiting on stale closed-window slots', async () => {
    const inventory = Object.assign(new EventEmitter(), { items: () => [], emptySlotCount: () => 36 });
    let visible: any[] = [];
    const furnace = Object.assign(new EventEmitter(), { items: () => visible, emptySlotCount: () => 35,
      inputItem: () => null, outputItem: () => visible.length ? null : { name: 'iron_ingot', count: 3 },
      takeOutput: async () => { visible = [{ name: 'iron_ingot', count: 3 }]; furnace.emit('updateSlot'); }, close: vi.fn() });
    const bot: any = { version: '1.21.11', entities: {}, blockAt: () => ({ name: 'furnace' }),
      entity: { position: { distanceTo: () => 1 } }, inventory, currentWindow: furnace,
      openFurnace: async () => furnace, activeFurnaces: [{ pos: { x: 0, y: 100, z: 0 } }] };
    const start = Date.now();
    const result = await new Withdraw(bot).runImpl(0, 100, 0, 'output');
    expect(result).toMatchObject({ success: true, result: '取り出しました: iron_ingot x3（完成品）' });
    expect(Date.now() - start).toBeLessThan(100);
    expect(bot.activeFurnaces).toHaveLength(0); expect(furnace.listenerCount('updateSlot')).toBe(0);
  });
  it('does not report an unfinished furnace as an empty successful output after a deadline', async () => {
    vi.useFakeTimers();
    try {
      const furnace = Object.assign(new EventEmitter(), { inputItem: () => ({ name: 'raw_iron', count: 1 }),
        outputItem: () => null, fuelItem: () => null, close: vi.fn() });
      const bot: any = { version: '1.21.11', blockAt: () => ({ name: 'furnace' }),
        entity: { position: { distanceTo: () => 1 } }, openFurnace: async () => furnace,
        activeFurnaces: [{ pos: { x: 0, y: 100, z: 0 } }] };
      const pending = new Withdraw(bot).runImpl(0, 100, 0, 'output', true);
      await vi.advanceTimersByTimeAsync(11000);
      expect(await pending).toMatchObject({ success: false, failureType: 'waiting_external' });
      expect(bot.activeFurnaces).toHaveLength(1); expect(furnace.listenerCount('update')).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('withdraws finished ingots without waiting for unfueled residual input', async () => {
    const inventory = Object.assign(new EventEmitter(), { items: () => [], emptySlotCount: () => 36 });
    let visible: any[] = [];
    const furnace = Object.assign(new EventEmitter(), {
      fuel: 0, totalFuel: 0, fuelItem: () => null, inputItem: () => ({ name: 'raw_iron', count: 2 }),
      outputItem: () => visible.length ? null : { name: 'iron_ingot', count: 8 },
      items: () => visible, emptySlotCount: () => 35,
      takeOutput: async () => { visible = [{ name: 'iron_ingot', count: 8 }]; furnace.emit('updateSlot'); },
      close: vi.fn(),
    });
    const bot: any = { version: '1.21.11', entities: {}, blockAt: () => ({ name: 'furnace' }),
      entity: { position: { distanceTo: () => 1 } }, inventory, currentWindow: furnace,
      openFurnace: async () => furnace, activeFurnaces: [{ pos: { x: 0, y: 100, z: 0 } }] };

    const result = await new Withdraw(bot).runImpl(0, 100, 0, 'output');
    expect(result).toMatchObject({ success: true });
    expect(result.result).toContain('iron_ingot x8');
    expect(result.result).toContain('材料2個が燃料切れ');
    expect(bot.activeFurnaces).toHaveLength(0);
  });
  it('does not turn an estimated ready time into verified completion', () => {
    const bot: any = { game: { dimension: 'overworld' }, activeFurnaces: [
      { pos: { x: 0, y: 100, z: 0 }, item: 'raw_iron', count: 3, startedAt: 100, readyAt: 200, dimension: 'overworld' },
    ] };
    expect(backgroundJobs(bot, 150)[0]).toMatchObject({ status: 'waiting_external', completionVerified: false });
    expect(backgroundJobs(bot, 250)[0]).toMatchObject({ status: 'verification_due', completionVerified: false });
    bot.game.dimension = 'the_nether';
    expect(backgroundJobs(bot, 250)[0].status).toBe('different_dimension');
  });
  it('returns waiting_external without taking fuel or dropping the active job', async () => {
    const furnace = { inputItem: () => ({ name: 'raw_iron', count: 3 }), outputItem: () => null, close: vi.fn() };
    const bot: any = { version: '1.21.11', blockAt: () => ({ name: 'furnace' }),
      entity: { position: { distanceTo: () => 1 } }, openFurnace: async () => furnace,
      activeFurnaces: [{ pos: { x: 0, y: 100, z: 0 } }] };
    expect(await new Withdraw(bot).runImpl(0, 100, 0, 'output', false)).toMatchObject({ success: false, failureType: 'waiting_external' });
    expect(furnace.close).toHaveBeenCalledOnce(); expect(bot.activeFurnaces).toHaveLength(1);
  });
});

describe('what needs no body is said before the body is asked for (paid run L70: a placement waited eleven seconds for the body to answer "too far")', () => {
  it('place-block-at answers "too far" at once while another action holds the body, and does not queue for it', async () => {
    const bot: any = Object.assign(host(), { version: '1.21.11', entity: { position: new Vec3(0.5, 64, 0.5) },
      inventory: { items: () => [{ name: 'cobblestone', count: 8 }] }, blockAt: () => ({ name: 'air', boundingBox: 'empty' }) });
    // The escape reflex has the body, as it does while a planner thinks in an emergency.
    const finish = deferred<typeof ok>();
    const holder = executeAction(bot, 'flee-from', 0, async () => finish.promise, { priority: 200 });
    await flush();
    const started = Date.now();
    const result: any = await new PlaceBlockAt(bot).run('cobblestone', 27, 64, 0);
    expect(Date.now() - started).toBeLessThan(200);
    expect(result).toMatchObject({ success: false, failureType: 'distance_too_far' });
    expect(result.result).toContain('現在位置: 0.5, 64.0, 0.5');
    finish.resolve(ok);
    await holder;
  });

  it('within reach it runs as before (the refusal is only for what cannot succeed from here)', async () => {
    const bot: any = Object.assign(host(), { version: '1.21.11', entity: { position: new Vec3(0.5, 64, 0.5) },
      inventory: { items: () => [] }, blockAt: () => ({ name: 'air', boundingBox: 'empty' }) });
    const result: any = await new PlaceBlockAt(bot).run('cobblestone', 2, 64, 0);
    expect(result.failureType).toBe('missing_item'); // it got as far as looking in the pack
  });
});

