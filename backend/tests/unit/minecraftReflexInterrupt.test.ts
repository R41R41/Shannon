import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { actionSignal, activeActionCapabilities, cancelActiveActions } from '../../src/services/minebot/execution/ActionExecution.js';
import { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
import { floorConfig } from '../../src/services/minebot/utils/floorConfig.js';
import { installFloorReflexes } from '../../src/services/minebot/utils/floorReflexes.js';
import { ensureReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';

const context = { scopeKey: 'owner', taskId: 'task1', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 'session1', generation: 1, goal: 'test', completionCondition: 'done' };
const command = (fields = {}, ms = 5000): any => ({ schemaVersion: 1, id: 'one', serverId: 'home', connectionId: 'connection1', kind: 'skill', context,
  lease: { id: 'lease1', generation: 1, holder: 'task1' }, deadlineAt: new Date(Date.now() + ms).toISOString(), skill: 'mine-block', arguments: {}, ...fields });

/** A long physical skill that ends when its action is cancelled, as the real ones do through assertActionActive. */
function longSkill(bot: any, name = 'mine-block') {
  return { skillName: name, description: 'long test skill', isToolForLLM: true, maxDurationMs: 60_000, params: [],
    run: vi.fn(async () => {
      const signal = actionSignal(bot)!;
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      return { success: true, result: 'stopped' };
    }) };
}
function fixture(options: { food?: number; health?: number; reflexTag?: boolean } = {}) {
  const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, name: 'player', position: new Vec3(0, 65, 0), yaw: 0, pitch: 0, onGround: true },
    health: options.health ?? 20, food: options.food ?? 20, oxygenLevel: 20, game: { dimension: 'overworld' }, entities: {} as Record<string, any>,
    inventory: { items: () => [{ name: 'bread' }] }, controlState: {} as Record<string, boolean>, executingSkill: false, interruptExecution: false,
    clearControlStates: vi.fn(function(this: any) { this.controlState = {}; }),
    setControlState: vi.fn(function(this: any, key: string, value: boolean) { this.controlState[key] = value; }),
    look: vi.fn(async () => {}), equip: vi.fn(async () => {}), consume: vi.fn(async () => { bot.food = 20; bot.health = Math.min(20, bot.health + 2); }) });
  const skill = longSkill(bot), other = longSkill(bot, 'move-to');
  bot.instantSkills = { getSkills: () => [skill, other] };
  const ledger = ensureReflexLedger(bot);
  const body = new NativeCommonFcaBody(bot, { serverId: 'home', capture: async () => { throw Error('unused'); }, reflexTag: options.reflexTag });
  return { bot, body, skill, ledger };
}
const tick = (bot: EventEmitter) => bot.emit('physicsTick');
const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

describe('interrupted_by_reflex', () => {
  it('names the body reflex that took the body from a command, and the command can be run again after it', async () => {
    const { bot, body } = fixture({ food: 2 });
    installFloorReflexes(bot, floorConfig({}));
    const pending = body.execute(command(), new AbortController().signal);
    await settle();
    expect(activeActionCapabilities(bot)).toEqual(['mine-block']);
    tick(bot); // starving: the meal cannot wait and cuts the action
    const receipt = await pending;
    expect(receipt).toMatchObject({ outcome: 'failed', failureType: 'interrupted_by_reflex', recoverable: true, inputsReleased: true });
    expect(receipt.result).toContain('体の反射「食事」');
    expect(bot.consume).toHaveBeenCalledTimes(1);
    await settle(); expect(activeActionCapabilities(bot)).toEqual([]);
    // The same command, asked again after the reflex ended, is accepted and runs.
    const again = body.execute(command({ id: 'two' }), new AbortController().signal);
    await settle(); expect(activeActionCapabilities(bot)).toEqual(['mine-block']);
    cancelActiveActions(bot, 'test'); await again; await body.dispose();
  });
  it('tells the planner what the reflex did on the receipt of the command it touched, and only that command', async () => {
    const { bot, body, ledger } = fixture({ food: 2, health: 8 });
    installFloorReflexes(bot, floorConfig({}));
    const pending = body.execute(command(), new AbortController().signal);
    await settle(); tick(bot);
    expect((await pending).result).toMatch(/［体の反射: 食事（bread） 体力8→10 満腹度2→20］$/u);
    await settle();
    expect(ledger.entriesSince(-1).map(entry => [entry.kind, entry.outcome])).toEqual([['eat', 'done']]);
    const quiet = body.execute(command({ id: 'quiet' }), new AbortController().signal);
    await settle(); cancelActiveActions(bot, 'test');
    expect((await quiet).result).not.toContain('体の反射'); await body.dispose();
  });
  it('adds the note to a command that finished, when a reflex moved while it ran', async () => {
    const { bot, body, ledger } = fixture();
    bot.instantSkills.getSkills()[0].run = vi.fn(async () => { ledger.note('shield', '盾を構えた'); return { success: true, result: '掘った' }; });
    const receipt = await body.execute(command(), new AbortController().signal);
    expect(receipt).toMatchObject({ outcome: 'completed', result: '掘った ［体の反射: 盾を構えた］' });
    expect(receipt).not.toHaveProperty('failureType'); await body.dispose();
  });
  it('leaves an API cancel, an operator stop and a deadline as they were, reflex or not', async () => {
    const { bot, body } = fixture({ food: 2 });
    installFloorReflexes(bot, floorConfig({}));
    const abort = new AbortController(), cancelled = body.execute(command(), abort.signal);
    await settle(); abort.abort('server_cancel'); tick(bot);
    const first = await cancelled;
    expect(first.outcome).toBe('cancelled'); expect(first).not.toHaveProperty('failureType');
    await settle(50);
    // A command that runs into its own deadline (no reflex) keeps the failure type it had before this change.
    const late = await body.execute(command({ id: 'late' }, 120), new AbortController().signal);
    expect(late).toMatchObject({ outcome: 'failed', failureType: 'interrupted' });
    expect(late.result).not.toContain('体の反射'); await body.dispose();
  });
  it('leaves an interruption that no reflex caused as interrupted', async () => {
    const { bot, body } = fixture();
    installFloorReflexes(bot, floorConfig({}));
    const pending = body.execute(command(), new AbortController().signal);
    await settle(); cancelActiveActions(bot, 'planner_interrupt');
    expect(await pending).toMatchObject({ outcome: 'failed', failureType: 'interrupted' });
    await body.dispose();
  });
  it('does not blame a reflex that cut a different action', async () => {
    const { bot, body, ledger } = fixture();
    const pending = body.execute(command(), new AbortController().signal);
    await settle();
    ledger.preempted('floor-eat', ['move-to']);
    cancelActiveActions(bot, 'planner_interrupt');
    expect(await pending).toMatchObject({ failureType: 'interrupted' }); await body.dispose();
  });
  it('is switched off by ledger-tag: the old interrupted and no note', async () => {
    const { bot, body } = fixture({ food: 2, reflexTag: false });
    installFloorReflexes(bot, floorConfig({ MINEBOT_FCA_REFLEX_OFF: 'ledger-tag' }));
    const pending = body.execute(command(), new AbortController().signal);
    await settle(); tick(bot);
    const receipt = await pending;
    expect(receipt).toMatchObject({ outcome: 'failed', failureType: 'interrupted' });
    expect(receipt.result).not.toContain('体の反射'); await body.dispose();
  });
});
