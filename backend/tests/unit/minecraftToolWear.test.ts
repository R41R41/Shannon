import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { describeRemainingTools, installToolWearMonitor } from '../../src/services/minebot/utils/toolWear.js';
import { actionDelay } from '../../src/services/minebot/execution/observedWait.js';
import { InstantSkill } from '../../src/services/minebot/types/skills.js';

function body(): any {
  const client = new EventEmitter();
  let items: any[] = [
    { name: 'stone_pickaxe', count: 1, maxDurability: 131, durabilityUsed: 130 },
    { name: 'wooden_pickaxe', count: 1, maxDurability: 59, durabilityUsed: 19 },
    { name: 'cobblestone', count: 64 },
  ];
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 7, position: new Vec3(0, 64, 0) }, _client: client, heldItem: { name: 'stone_pickaxe', maxDurability: 131 },
    inventory: { slots: [], items: () => items }, setItems: (next: any[]) => { items = next; },
    executingSkill: false, interruptExecution: false, health: 20, food: 20,
    clearControlStates: vi.fn(), stopDigging: vi.fn(), pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
  });
  return bot;
}

afterEach(() => { vi.useRealTimers(); });

describe('the body notices a tool breaking in its hand', () => {
  it('names the item that was in the hand when the server announces the break, and ignores other entities', () => {
    const bot = body();
    installToolWearMonitor(bot);
    const heard: any[] = [];
    bot.on('minebotToolBroke', (entry: any) => heard.push(entry.name));
    bot.emit('physicsTick');
    // The hand passes over something that cannot wear out before the break is announced: it is not what broke.
    bot.heldItem = { name: 'dark_oak_sapling' };
    bot.emit('physicsTick');
    bot.heldItem = null; // the slot is already empty when the break is announced
    bot.emit('physicsTick');
    bot._client.emit('entity_status', { entityId: 99, entityStatus: 47 });
    bot._client.emit('entity_status', { entityId: 7, entityStatus: 2 });
    expect(heard).toEqual([]);
    bot._client.emit('entity_status', { entityId: 7, entityStatus: 47 });
    expect(heard).toEqual(['stone_pickaxe']);
    expect(bot.toolBreaks).toHaveLength(1);
  });

  it('lists what is left of the tools still carried', () => {
    const bot = body();
    expect(describeRemainingTools(bot)).toBe('stone_pickaxe（耐久 残り1/131）、wooden_pickaxe（耐久 残り40/59）');
    bot.setItems([{ name: 'cobblestone', count: 64 }]);
    expect(describeRemainingTools(bot)).toBe('なし');
  });
});

describe('a broken tool hands the decision back to the planner (paid run L21)', () => {
  class Mining extends InstantSkill {
    blocks = 0;
    constructor(bot: any) { super(bot); this.skillName = 'mine-block'; }
    async runImpl() { for (; this.blocks < 20; this.blocks++) await actionDelay(this.bot, 500); return { success: true, result: 'mined 20' }; }
  }

  it('stops the running action at the break and reports which tool and what remains', async () => {
    vi.useFakeTimers();
    const bot = body();
    installToolWearMonitor(bot);
    bot.emit('physicsTick');
    const skill = new Mining(bot);
    const running = skill.run();
    await vi.advanceTimersByTimeAsync(1600);
    bot.setItems([{ name: 'wooden_pickaxe', count: 1, maxDurability: 59, durabilityUsed: 19 }, { name: 'cobblestone', count: 67 }]);
    bot._client.emit('entity_status', { entityId: 7, entityStatus: 47 });
    await vi.advanceTimersByTimeAsync(600);
    const result: any = await running;
    expect(result).toMatchObject({ success: false, failureType: 'tool_broke', recoverable: true });
    expect(result.result).toContain('mine-blockの途中でstone_pickaxeが壊れたため、行動を止めました');
    expect(result.result).toContain('残っている道具: wooden_pickaxe（耐久 残り40/59）');
    const stoppedAt = skill.blocks;
    await vi.advanceTimersByTimeAsync(5000);
    expect(skill.blocks).toBe(stoppedAt);
    expect(stoppedAt).toBeLessThan(6);
  });

  it('leaves an action untouched when nothing breaks', async () => {
    vi.useFakeTimers();
    const bot = body();
    installToolWearMonitor(bot);
    const running = new Mining(bot).run();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await running).toMatchObject({ success: true, result: 'mined 20' });
    expect(bot.listenerCount('minebotToolBroke')).toBe(0);
  });

  it('leaves the skill usable for the next call in the same response (L39: every dig after a break failed with "Motor owner expired")', async () => {
    const bot = body();
    bot.equip = vi.fn(async () => {});
    class Digging extends InstantSkill {
      calls = 0;
      constructor(host: any) { super(host); this.skillName = 'dig-block-at'; }
      async runImpl() {
        const call = ++this.calls;
        await (this.bot as any).equip({ name: 'pickaxe' }, 'hand');      // a motor call through this run's port
        // The first call is still unwinding (a native wait that does not hear the cancellation) when the second begins.
        if (call === 1) await new Promise(resolve => setTimeout(resolve, 60));
        return { success: true, result: `dug ${call}` };
      }
    }
    const skill = new Digging(bot);
    const first = skill.run();
    await new Promise(resolve => setTimeout(resolve, 10));
    bot.emit('minebotToolBroke', { name: 'iron_pickaxe' });               // the tool breaks: the first call is cancelled
    expect(await first).toMatchObject({ success: false, failureType: 'tool_broke' });
    // The planner's next call arrives at once, before the cancelled work has finished unwinding.
    const second = await skill.run();
    expect(second).toMatchObject({ success: true, result: 'dug 2' });
    await new Promise(resolve => setTimeout(resolve, 80));
    // And the one after that, once everything has settled: the skill still holds its real body.
    expect(await skill.run()).toMatchObject({ success: true, result: 'dug 3' });
    expect(skill.bot).toBe(bot);
    expect(bot.equip).toHaveBeenCalledTimes(3);
  });
});
