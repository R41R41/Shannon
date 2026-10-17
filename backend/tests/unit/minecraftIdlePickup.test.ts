import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const walking = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: walking.goto }));

import { actionSignal, activeActionCapabilities, executeAction } from '../../src/services/minebot/execution/ActionExecution.js';
import { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
import { floorConfig } from '../../src/services/minebot/utils/floorConfig.js';
import { IDLE_PICKUP_PRIORITY, installIdlePickup, pickupTarget, type PickupBody } from '../../src/services/minebot/utils/idlePickup.js';
import { ensureReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';

const extended = floorConfig({ MINEBOT_FCA_REFLEXES: 'extended' });
const goals = async () => ({ GoalNear: class { constructor(public x: number, public y: number, public z: number, public range: number) {} } });
const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
function fixture(patch: Record<string, unknown> = {}) {
  let leaseHeld = false;
  const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, name: 'player', position: new Vec3(0, 65, 0), yaw: 0, pitch: 0, onGround: true },
    health: 20, food: 20, game: { dimension: 'overworld' }, entities: { 7: { id: 7, name: 'item', position: new Vec3(3, 65, 0), velocity: new Vec3(0, 0, 0) } } as Record<string, any>,
    inventory: { items: () => [], slots: new Array(46).fill(null), emptySlotCount: () => 5 }, controlState: {}, executingSkill: false, interruptExecution: false,
    clearControlStates: vi.fn(), setControlState: vi.fn(), look: vi.fn(), blockAt: () => ({ name: 'stone', boundingBox: 'block' }),
    toss: vi.fn(async () => undefined), fcaLeaseHeld: () => leaseHeld, ...patch });
  return { bot: bot as PickupBody & any, hold: (value: boolean) => { leaseHeld = value; }, ledger: ensureReflexLedger(bot) };
}
beforeEach(() => { walking.goto.mockReset(); });
const ticks = (bot: EventEmitter, count = 10) => { for (let i = 0; i < count; i++) bot.emit('physicsTick'); };

describe('idle pickup: when it may start', () => {
  it('picks a still drop within 4 blocks when the body is idle', () => {
    const { bot } = fixture(); installIdlePickup(bot, extended, { goals });
    expect(pickupTarget(bot, Date.now())).toMatchObject({ id: 7 });
  });
  it('never while a command or lease holds the body, and never when it cannot tell', () => {
    const { bot, hold } = fixture(); installIdlePickup(bot, extended, { goals });
    hold(true); expect(pickupTarget(bot, Date.now())).toBeNull();
    hold(false); delete bot.fcaLeaseHeld; expect(pickupTarget(bot, Date.now())).toBeNull();
  });
  it('never with an action or a safety reflex running, an enemy within 16, low health, a full pack, or a reflex holding the body', async () => {
    const { bot } = fixture(); installIdlePickup(bot, extended, { goals });
    const running = executeAction(bot, 'mine-block', 1000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'ok' }), 30)));
    await settle(5); expect(pickupTarget(bot, Date.now())).toBeNull(); await running;
    const lease = executeAction(bot, 'floor-eat', 1000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'ok' }), 30)), { priority: 200, safetyLease: true });
    await settle(5); expect(pickupTarget(bot, Date.now())).toBeNull(); await lease;
    expect(pickupTarget(bot, Date.now())).not.toBeNull();
    bot.entities[9] = { id: 9, name: 'zombie', position: new Vec3(15, 65, 0) }; expect(pickupTarget(bot, Date.now())).toBeNull();
    delete bot.entities[9];
    bot.health = 9; expect(pickupTarget(bot, Date.now())).toBeNull(); bot.health = 10; expect(pickupTarget(bot, Date.now())).not.toBeNull();
    bot.inventory.emptySlotCount = () => 0; expect(pickupTarget(bot, Date.now())).toBeNull(); bot.inventory.emptySlotCount = () => 1;
    bot.floorReflexes = { retreat: { engaged: false }, busy: 'eat' }; expect(pickupTarget(bot, Date.now())).toBeNull(); bot.floorReflexes = undefined;
    bot.lavaReflex = { engaged: true }; expect(pickupTarget(bot, Date.now())).toBeNull();
  });
  it('skips a drop that is far, still moving, would burn, or that the body threw away itself', async () => {
    const { bot } = fixture(); installIdlePickup(bot, extended, { goals });
    bot.entities[7].position = new Vec3(5, 65, 0); expect(pickupTarget(bot, Date.now())).toBeNull();
    bot.entities[7].position = new Vec3(3, 65, 0); bot.entities[7].velocity = new Vec3(0, -0.4, 0); expect(pickupTarget(bot, Date.now())).toBeNull();
    bot.entities[7].velocity = new Vec3(0, 0, 0);
    const lava = fixture({ blockAt: (position: Vec3) => position.y < 65 ? { name: 'lava', boundingBox: 'empty' } : { name: 'air', boundingBox: 'empty' } });
    installIdlePickup(lava.bot, extended, { goals }); expect(pickupTarget(lava.bot, Date.now())).toBeNull();
    await bot.toss(); expect(pickupTarget(bot, Date.now())).toBeNull();
    expect(pickupTarget(bot, Date.now() + 61_000)).not.toBeNull();
  });
  it('is not installed unless extended allows it', () => {
    const { bot } = fixture(); installIdlePickup(bot, floorConfig({})); expect(bot.idlePickup).toBeUndefined();
    installIdlePickup(bot, floorConfig({ MINEBOT_FCA_REFLEXES: 'extended', MINEBOT_FCA_REFLEX_OFF: 'pickup' })); expect(bot.idlePickup).toBeUndefined();
  });
});

describe('idle pickup: yielding to a command', () => {
  it('walks at priority -1, once per 10 seconds and once per drop, and reports it', async () => {
    const { bot, ledger } = fixture(); installIdlePickup(bot, extended, { goals });
    walking.goto.mockImplementation(async () => ({ success: true }));
    ticks(bot); await settle(10); ticks(bot, 30); await settle(10);
    expect(walking.goto).toHaveBeenCalledTimes(1);
    expect(ledger.entriesSince(-1).map(entry => [entry.kind, entry.outcome])).toEqual([['pickup', 'done']]);
    expect(IDLE_PICKUP_PRIORITY).toBeLessThan(0);
    walking.goto.mockClear();
  });
  it('is cancelled the moment a command arrives, and the command then has the body alone', async () => {
    const { bot, ledger } = fixture(); installIdlePickup(bot, extended, { goals });
    walking.goto.mockImplementation(async (walker: any) => { const signal = actionSignal(walker)!; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { success: false, error: 'no_path' }; });
    const skill = { skillName: 'mine-block', description: 'x', isToolForLLM: true, maxDurationMs: 1000, params: [], run: vi.fn(async () => ({ success: true, result: '掘った' })) };
    bot.instantSkills = { getSkills: () => [skill] };
    const body = new NativeCommonFcaBody(bot, { serverId: 'home', capture: async () => { throw Error('unused'); } });
    ticks(bot); await settle(10);
    expect(activeActionCapabilities(bot)).toEqual(['idle-pickup']);
    const context = { scopeKey: 'o', taskId: 't', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 's', generation: 1, goal: 'g', completionCondition: 'c' };
    const receipt = await body.execute({ schemaVersion: 1, id: 'c1', serverId: 'home', connectionId: 'x', kind: 'skill', context, lease: { id: 'l', generation: 1, holder: 't' },
      deadlineAt: new Date(Date.now() + 3000).toISOString(), skill: 'mine-block', arguments: {} } as any, new AbortController().signal);
    expect(receipt).toMatchObject({ outcome: 'completed', result: '掘った', inputsReleased: true });
    expect(skill.run).toHaveBeenCalledTimes(1);
    expect(activeActionCapabilities(bot)).toEqual([]);
    expect(ledger.entriesSince(-1).map(entry => [entry.kind, entry.outcome])).toEqual([['pickup', 'cut']]);
    // The walk was idle work: it is not why the command was interrupted, and it is not in the command's receipt.
    expect(receipt.result).not.toContain('反射'); await body.dispose();
  });
  it('does not start a second walk while one is running, nor a walk over a safety reflex', async () => {
    const { bot } = fixture(); installIdlePickup(bot, extended, { goals });
    let release!: () => void;
    walking.goto.mockImplementation(() => new Promise(resolve => { release = () => resolve({ success: true }); }));
    ticks(bot); await settle(10); ticks(bot, 40); await settle(5);
    expect(walking.goto).toHaveBeenCalledTimes(1);
    release(); await settle(10);
  });
});
