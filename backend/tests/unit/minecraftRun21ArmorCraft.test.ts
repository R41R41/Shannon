import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { actionSignal, activeActionCapabilities, preemptLowerPriorityActions } from '../../src/services/minebot/execution/ActionExecution.js';
import { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
import { floorConfig } from '../../src/services/minebot/utils/floorConfig.js';
import { installFloorReflexes } from '../../src/services/minebot/utils/floorReflexes.js';
import { craftDoneDespiteCut, craftWitness } from '../../src/services/minebot/utils/cutCraftRecovery.js';
import { markHeadCombat } from '../../src/services/minebot/utils/combatOwner.js';
import { ensureReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';

const context = { scopeKey: 'owner', taskId: 'task1', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 'session1', generation: 1, goal: 'test', completionCondition: 'done' };
const command = (fields = {}, ms = 5000): any => ({ schemaVersion: 1, id: 'one', serverId: 'home', connectionId: 'connection1', kind: 'skill', context,
  lease: { id: 'lease1', generation: 1, holder: 'task1' }, deadlineAt: new Date(Date.now() + ms).toISOString(), skill: 'craft-one',
  arguments: { itemName: 'iron_chestplate' }, ...fields });
const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const tick = (bot: EventEmitter) => bot.emit('physicsTick');

/**
 * A craft that puts the piece in the pack when `makeAt` passes and then keeps the body until it is cancelled or `finishAt` passes, as
 * the real craft-one holds it for a second or two (the table, the click on the output slot).
 */
function craftSkill(bot: any, state: { make: boolean; finish: () => void }) {
  return { skillName: 'craft-one', description: 'craft', isToolForLLM: true, maxDurationMs: 60_000,
    params: [{ name: 'itemName', type: 'string', required: true }, { name: 'count', type: 'number', default: 1 }],
    run: vi.fn(async () => {
      const signal = actionSignal(bot)!;
      if (state.make) bot.inventory.add('iron_chestplate');
      await new Promise<void>(resolve => {
        state.finish = () => resolve();
        if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { success: true, result: '作った' };
    }) };
}

function fixture(options: { make?: boolean; skeletonAt?: number } = {}) {
  const slots: any[] = Array.from({ length: 46 }, () => null);
  const carried: Array<{ name: string; count: number }> = [];
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, name: 'player', position: new Vec3(0, 65, 0), yaw: 0, pitch: 0, onGround: true },
    health: 20, food: 20, oxygenLevel: 20, game: { dimension: 'overworld' }, controlState: {} as Record<string, boolean>,
    entities: { 7: { id: 7, name: 'skeleton', position: new Vec3(options.skeletonAt ?? 12, 65, 0), isValid: true } } as Record<string, any>,
    executingSkill: false, interruptExecution: false,
    inventory: { slots, items: () => carried, add: (name: string) => { carried.push({ name, count: 1 }); } },
    clearControlStates: vi.fn(function(this: any) { this.controlState = {}; }),
    setControlState: vi.fn(function(this: any, key: string, value: boolean) { this.controlState[key] = value; }),
    look: vi.fn(async () => {}),
    // Wearing a piece moves it from the pack to its slot.
    equip: vi.fn(async (item: { name: string }, destination: string) => {
      const index = carried.findIndex(entry => entry.name === item.name); if (index >= 0) carried.splice(index, 1);
      slots[{ head: 5, torso: 6, legs: 7, feet: 8 }[destination as 'head'] ?? 6] = { name: item.name, count: 1 };
    }),
    consume: vi.fn(async () => {}) });
  const state = { make: options.make ?? true, finish: () => {} };
  const skill = craftSkill(bot, state);
  bot.instantSkills = { getSkills: () => [skill] };
  const ledger = ensureReflexLedger(bot);
  const body = new NativeCommonFcaBody(bot, { serverId: 'home', capture: async () => { throw Error('unused'); } });
  return { bot, body, skill, state, ledger, slots, carried };
}

describe('run 21: the armour reflex and a craft', () => {
  it('does not cut a craft for armour while the enemy is not close; the armour goes on when the craft ends', async () => {
    const { bot, body, state, slots } = fixture({ skeletonAt: 12 });
    installFloorReflexes(bot, floorConfig({}));
    const pending = body.execute(command(), new AbortController().signal);
    await settle();
    expect(activeActionCapabilities(bot)).toEqual(['craft-one']);
    tick(bot); await settle();
    expect(bot.equip).not.toHaveBeenCalled();
    expect(activeActionCapabilities(bot)).toEqual(['craft-one']);
    state.finish();
    const receipt = await pending;
    expect(receipt).toMatchObject({ outcome: 'completed' });
    expect(receipt).not.toHaveProperty('failureType');
    await settle();
    tick(bot); await settle();
    expect(bot.equip).toHaveBeenCalledTimes(1);
    expect(slots[6]?.name).toBe('iron_chestplate');
    await body.dispose();
  });

  it('still cuts the craft for armour when an enemy is close', async () => {
    const { bot, body } = fixture({ skeletonAt: 4 });
    installFloorReflexes(bot, floorConfig({}));
    const pending = body.execute(command(), new AbortController().signal);
    await settle();
    tick(bot);
    const receipt = await pending;
    expect(bot.equip).toHaveBeenCalledTimes(1);
    // The piece had been made and is worn by the reflex: the command did what it was for.
    expect(receipt).toMatchObject({ outcome: 'completed' });
    await body.dispose();
  });

  it('floor mode (the production floor) is unchanged: the craft is cut with an enemy within 16', async () => {
    const { bot, body } = fixture({ skeletonAt: 12, make: false });
    installFloorReflexes(bot, floorConfig({ MINEBOT_FCA_REFLEXES: 'floor' }));
    bot.inventory.add('iron_chestplate');
    const pending = body.execute(command(), new AbortController().signal);
    await settle();
    tick(bot);
    await pending;
    expect(bot.equip).toHaveBeenCalledTimes(1);
    await body.dispose();
  });
});

describe('run 21: a craft cut off after the piece was made is a success', () => {
  it('craft-one cut by the armour reflex, the piece worn: completed, and says so', async () => {
    const { bot, body, slots } = fixture();
    const pending = body.execute(command(), new AbortController().signal);
    await settle();
    expect(bot.inventory.items().map((item: any) => item.name)).toEqual(['iron_chestplate']);
    // The reflex's cut and its equip, as floorReflexes does them.
    preemptLowerPriorityActions(bot, 150, 'floor-armor');
    await bot.equip({ name: 'iron_chestplate' }, 'torso');
    const receipt = await pending;
    expect(slots[6]?.name).toBe('iron_chestplate');
    expect(receipt).toMatchObject({ outcome: 'completed', inputsReleased: true });
    expect(receipt).not.toHaveProperty('failureType');
    expect(receipt.result).toContain('iron_chestplate');
    expect(receipt.result).toContain('防具の装着');
    expect(receipt.result).toContain('装備まで済ませています');
    await body.dispose();
  });

  it('craft-one cut by a reflex, the piece still in the pack: completed too', async () => {
    const { bot, body } = fixture();
    const pending = body.execute(command(), new AbortController().signal);
    await settle();
    preemptLowerPriorityActions(bot, 200, 'floor-eat');
    const receipt = await pending;
    expect(receipt).toMatchObject({ outcome: 'completed' });
    expect(receipt.result).toContain('持ち物に入っています');
    await body.dispose();
  });

  it('craft-one cut by a reflex before anything was made: still interrupted_by_reflex', async () => {
    const { bot, body } = fixture({ make: false });
    const pending = body.execute(command(), new AbortController().signal);
    await settle();
    preemptLowerPriorityActions(bot, 200, 'floor-eat');
    expect(await pending).toMatchObject({ outcome: 'failed', failureType: 'interrupted_by_reflex', recoverable: true });
    await body.dispose();
  });

  it('a different item in the pack does not make the craft a success', async () => {
    const { bot, body, carried } = fixture({ make: false });
    carried.push({ name: 'iron_helmet', count: 1 });
    const pending = body.execute(command(), new AbortController().signal);
    await settle();
    preemptLowerPriorityActions(bot, 150, 'floor-armor');
    expect(await pending).toMatchObject({ outcome: 'failed', failureType: 'interrupted_by_reflex' });
    await body.dispose();
  });

  it('an API cancel stays cancelled even when the piece exists', async () => {
    const { bot, body } = fixture();
    const abort = new AbortController(), pending = body.execute(command(), abort.signal);
    await settle();
    abort.abort('server_cancel');
    preemptLowerPriorityActions(bot, 150, 'floor-armor');
    const receipt = await pending;
    expect(receipt.outcome).toBe('cancelled');
    expect(receipt).not.toHaveProperty('failureType');
    await body.dispose();
  });

  it('asked for more than was made, the cut stands as a failure', () => {
    const bot: any = { inventory: { items: () => [{ name: 'iron_helmet', count: 1 }], slots: [] } };
    const witness = craftWitness(bot, 'craft-one', ['iron_helmet', 2])!;
    expect(witness).toMatchObject({ itemName: 'iron_helmet', wanted: 2, before: 1 });
    expect(craftDoneDespiteCut(bot, witness)).toBeNull();
    bot.inventory.items = () => [{ name: 'iron_helmet', count: 3 }];
    expect(craftDoneDespiteCut(bot, witness)?.gained).toBe(2);
  });

  it('only a craft has a witness, and a piece worn before the craft is not counted as made', () => {
    const slots: any[] = Array.from({ length: 46 }, () => null); slots[5] = { name: 'iron_helmet', count: 1 };
    const bot: any = { inventory: { items: () => [], slots } };
    expect(craftWitness(bot, 'mine-block', ['iron_helmet'])).toBeNull();
    const witness = craftWitness(bot, 'craft-one', ['iron_helmet'])!;
    expect(witness.before).toBe(1);
    expect(craftDoneDespiteCut(bot, witness)).toBeNull();
  });
});

describe('run 21: the observation says who owns the fight', () => {
  it('facts.combatOwner is head while the planner\'s fight holds the body, and null otherwise', async () => {
    const { bot, body } = fixture();
    expect(body.observe().facts).toMatchObject({ combatOwner: null, closeInAdvised: false });
    markHeadCombat(bot, 'attack-nearest', ['*']);
    expect(body.observe().facts.combatOwner).toBe('head');
    await body.dispose();
  });
});