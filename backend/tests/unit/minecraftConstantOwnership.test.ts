import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AutoFollow from '../../src/services/minebot/constantSkills/autoFollow.js';
import AutoEat from '../../src/services/minebot/constantSkills/autoEat.js';
import AutoFaceMovedEntity from '../../src/services/minebot/constantSkills/autoFaceMovedEntity.js';
import { ConstantSkill, InstantSkill } from '../../src/services/minebot/types/skills.js';
import { ConstantSkills } from '../../src/services/minebot/types/collections.js';
import { actionDelay } from '../../src/services/minebot/execution/observedWait.js';
import { currentAction } from '../../src/services/minebot/execution/ActionExecution.js';
import { SkillExecutor } from '../../src/services/minebot/execution/SkillExecutor.js';
afterEach(() => vi.useRealTimers());
const fixture = (): any => Object.assign(new EventEmitter(), { entity: { position: new Vec3(0, 64, 0) },
  health: 20, food: 20, executingSkill: false, interruptExecution: false, entities: {},
  inventory: { items: () => [{ name: 'bread', count: 1 }] }, pathfinder: { stop: () => {}, setGoal: () => {}, isMoving: () => false },
  clearControlStates: () => {}, constantSkills: { getSkills: () => [] }, utils: { getNearestEntitiesByName: vi.fn(async () => []) },
  equip: async () => {}, consume: async () => {} });
describe('constant motor ownership without behavior degradation', () => {
  it('grants a queued survival lease before an ordinary successor, only after current quiescence', async () => {
    const executor = new SkillExecutor(); const release = await executor.acquire('mine-block'); const order: string[] = [];
    const ordinary = executor.acquire('place-block-at').then(release => { order.push('ordinary'); release(); });
    const survival = executor.acquire('auto-eat', undefined, 100).then(release => { order.push('survival'); release(); });
    expect(order).toEqual([]); release(); await Promise.all([ordinary, survival]); expect(order).toEqual(['survival', 'ordinary']);
  });
  it('does not self-suppress a constant using the legacy instant-execution flag', async () => {
    vi.useFakeTimers(); const bot = fixture();
    bot.lookAt = vi.fn(async () => { expect(bot.executingSkill).toBe(false); expect(currentAction(bot)?.physical).toBe(true); });
    const run = new AutoFaceMovedEntity(bot).run({ name: 'player', position: new Vec3(1, 64, 0), height: 1.8 });
    await vi.advanceTimersByTimeAsync(501); await run; expect(bot.lookAt).toHaveBeenCalledOnce();
  });
  it('preempts persistent following for survival eating and retains its target for later resumption', async () => {
    vi.useFakeTimers(); const bot = fixture(); const follow = new AutoFollow(bot); follow.status = true;
    const first = follow.run('Tester'); await vi.advanceTimersByTimeAsync(1);
    expect(follow.isLocked).toBe(true); expect(follow.maxDurationMs).toBe(0);
    bot.health = 6; bot.food = 6; bot.consume = vi.fn(async () => { bot.food = 11; });
    const eat = new AutoEat(bot).run(); await vi.advanceTimersByTimeAsync(20); await eat; await first;
    expect(bot.consume).toHaveBeenCalledOnce(); expect(follow.status).toBe(true); expect(follow.isLocked).toBe(false);
    const second = follow.run(); await vi.advanceTimersByTimeAsync(1);
    expect(bot.utils.getNearestEntitiesByName.mock.calls.at(-1)[1]).toBe('Tester');
    follow.cancel(); await vi.advanceTimersByTimeAsync(20); await second;
  });
  it('queue clearing cancels the owned current task and never starts a concurrent body', async () => {
    vi.useFakeTimers(); const bot = fixture(); let bodies = 0; let maxBodies = 0;
    class Slow extends ConstantSkill { async runImpl() { bodies++; maxBodies = Math.max(maxBodies, bodies); try { await actionDelay(this.bot, 2000); } finally { bodies--; } } }
    const collection = new ConstantSkills(); const skill = new Slow(bot); skill.skillName = 'auto-slow-fixture';
    try {
      await collection.requestExecution(skill); await vi.advanceTimersByTimeAsync(100);
      expect(bodies).toBe(1); await collection.requestExecution(skill); collection.clearQueue();
      await vi.advanceTimersByTimeAsync(200); expect(bodies).toBe(0); expect(maxBodies).toBe(1);
    } finally { collection.destroy(); }
  });
  it('internal building subskills retain their own deadline and cannot issue late native-event writes', async () => {
    vi.useFakeTimers(); const bot = fixture(); const writes = vi.fn(); bot.setControlState = writes;
    let captured: any;
    class Child extends InstantSkill { async runImpl() { captured = this.bot; await actionDelay(this.bot, 1000); return { success: true, result: 'dug' }; } }
    class Parent extends InstantSkill { async runImpl() { return this.callSkill('dig-block-at'); } }
    const child = new Child(bot); child.skillName = 'dig-block-at'; child.maxDurationMs = 20;
    const parent = new Parent(bot); parent.skillName = 'build-structure'; parent.maxDurationMs = 2000;
    bot.instantSkills = { getSkill: () => child };
    const run = parent.run(); await vi.advanceTimersByTimeAsync(25);
    expect(await run).toMatchObject({ success: false, failureType: 'timeout' });
    expect(() => captured.setControlState('forward', true)).toThrow('Motor owner expired'); expect(writes).not.toHaveBeenCalled();
    expect(child.bot).toBe(bot);
  });
});
