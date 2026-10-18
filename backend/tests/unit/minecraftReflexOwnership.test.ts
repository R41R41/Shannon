import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { activeActionCapabilities, executeAction, preemptLowerPriorityActions } from '../../src/services/minebot/execution/ActionExecution.js';
import { floorConfig } from '../../src/services/minebot/utils/floorConfig.js';
import { ESCAPE_SKILLS, fleeStart, fleeThreat, floorActive, installFloorReflexes, type FloorBody, type FloorState } from '../../src/services/minebot/utils/floorReflexes.js';
import { ensureReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';

function fixture(patch: Record<string, unknown> = {}) {
  const concurrent: string[][] = [];
  const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, name: 'player', position: new Vec3(0, 65, 0), yaw: 0, pitch: 0, onGround: true },
    health: 5, food: 20, game: { dimension: 'overworld' }, entities: { 2: { id: 2, name: 'zombie', position: new Vec3(2, 65, 0) } } as Record<string, any>,
    inventory: { items: () => [] as any[], slots: new Array(46).fill(null) }, controlState: {} as Record<string, boolean>, executingSkill: false, interruptExecution: false,
    clearControlStates: vi.fn(),
    setControlState: vi.fn(function(this: any, key: string, value: boolean) { this.controlState[key] = value; concurrent.push(activeActionCapabilities(bot)); }),
    look: vi.fn(async () => {}), equip: vi.fn(async () => {}), consume: vi.fn(async () => {}), ...patch });
  return { bot, concurrent, ledger: ensureReflexLedger(bot) };
}
const tick = (bot: EventEmitter) => bot.emit('physicsTick');
const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const extended = floorConfig({ MINEBOT_FCA_REFLEXES: 'extended' });
const state = (patch: Partial<FloorState> = {}): FloorState => ({ retreat: { engaged: false, ticks: 0, cooldown: 0, engagements: 0 }, busy: null, retryAt: 0, engagements: { eat: 0, armor: 0 }, fleeStarts: [], ...patch });

describe('low-health flee: when it may start (precedence)', () => {
  it('needs health at most 6 and a reachable hostile within 3 blocks', () => {
    const { bot } = fixture();
    expect(fleeThreat(bot as FloorBody)?.from.x).toBe(2);
    bot.health = 7; expect(fleeThreat(bot)).toBeNull();
    bot.health = 6; expect(fleeThreat(bot)).not.toBeNull();
    bot.health = 0; expect(fleeThreat(bot)).toBeNull();
    bot.health = 5; bot.entities[2].position = new Vec3(3.5, 65, 0); expect(fleeThreat(bot)).toBeNull();
    bot.entities[2] = { id: 2, name: 'cow', position: new Vec3(1, 65, 0) }; expect(fleeThreat(bot)).toBeNull();
    bot.entities[2] = { id: 2, name: 'zombie', position: new Vec3(1, 65, 0) }; bot.entity.isInLava = true; expect(fleeThreat(bot)).toBeNull();
    // Walled off (it can neither see nor reach the body): nothing to run from.
    bot.entity.isInLava = false; expect(fleeThreat(bot)).not.toBeNull();
    const walled = fixture({ blockAt: () => ({ name: 'stone', boundingBox: 'block' }) });
    expect(fleeThreat(walled.bot)).toBeNull();
  });
  it('is yielded to a floor retreat, a held floor action, the lava and breathing reflexes, and the API\'s own escape skills', async () => {
    const { bot } = fixture();
    expect(fleeStart(bot, state(), Date.now())).not.toBeNull();
    expect(fleeStart(bot, state({ retreat: { engaged: true, ticks: 0, cooldown: 0, engagements: 1 } }), Date.now())).toBeNull();
    expect(fleeStart(bot, state({ busy: 'eat' }), Date.now())).toBeNull();
    bot.lavaReflex = { engaged: true }; expect(fleeStart(bot, state(), Date.now())).toBeNull(); bot.lavaReflex = { engaged: false };
    bot.breathingReflex = { engaged: true }; expect(fleeStart(bot, state(), Date.now())).toBeNull(); bot.breathingReflex = { engaged: false };
    for (const skill of ESCAPE_SKILLS) {
      const held = executeAction(bot, skill, 1000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'ok' }), 40)), { priority: 0 });
      await settle(5);
      expect(fleeStart(bot, state(), Date.now()), skill).toBeNull();
      await held;
    }
    const lease = executeAction(bot, 'floor-eat', 1000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'ok' }), 40)),
      { priority: 200, safetyLease: true });
    await settle(5); expect(fleeStart(bot, state(), Date.now())).toBeNull(); await lease;
    // A fight or a task action under it does not stop it: at this health the API's fast judgment would cut it too.
    const fight = executeAction(bot, 'attack-continuously', 1000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'ok' }), 40)), { priority: 0 });
    await settle(5); expect(fleeStart(bot, state(), Date.now())).not.toBeNull(); await fight;
  });
  it('is at most twice in 20 seconds', () => {
    const { bot } = fixture();
    const now = 1_000_000, spent = state({ fleeStarts: [now - 15_000, now - 5_000] });
    expect(fleeStart(bot, spent, now)).toBeNull();
    expect(fleeStart(bot, spent, now + 6_000)).not.toBeNull();
  });
});

describe('low-health flee: the reflex itself (extended only)', () => {
  it('does nothing under the default floor: no new movement', async () => {
    const { bot } = fixture();
    installFloorReflexes(bot, floorConfig({}));
    for (let i = 0; i < 5; i++) { tick(bot); await settle(2); }
    expect(bot.setControlState).not.toHaveBeenCalled(); expect(bot.floorReflexes.busy).toBeNull();
    const off = fixture(); installFloorReflexes(off.bot, floorConfig({ MINEBOT_FCA_REFLEXES: 'extended', MINEBOT_FCA_REFLEX_OFF: 'flee' }));
    tick(off.bot); await settle(2); expect(off.bot.setControlState).not.toHaveBeenCalled();
  });
  it('runs away from the hostile for a bounded time on its own lease, then lets go, with one owner at a time', async () => {
    const { bot, concurrent, ledger } = fixture();
    installFloorReflexes(bot, extended, { fleeTickMs: 1 });
    tick(bot);
    expect(bot.floorReflexes.busy).toBe('flee');
    expect(floorActive(bot)).toBe(true);
    // A second tick while it runs starts nothing more.
    tick(bot); tick(bot);
    await settle(500);
    expect(bot.floorReflexes.busy).toBeNull();
    expect(floorActive(bot)).toBe(false);
    const forward = bot.setControlState.mock.calls.filter(([key, value]: [string, boolean]) => key === 'forward' && value).length;
    expect(forward).toBeGreaterThan(0); expect(forward).toBeLessThanOrEqual(24);
    expect(bot.controlState.forward).toBe(false); expect(bot.controlState.sprint).toBe(false);
    // Turned its back on the zombie at +x: yaw for -x is +PI/2.
    expect(Math.abs(Math.sin(bot.look.mock.calls[0][0]) - 1)).toBeLessThan(1e-9);
    // Every key write happened while exactly the flee held the body, never two physical owners.
    expect(concurrent.length).toBeGreaterThan(0);
    expect(concurrent.filter(owners => owners.length !== 1 || owners[0] !== 'floor-flee')).toEqual([]);
    expect(ledger.entriesSince(-1).map(entry => [entry.kind, entry.outcome])).toEqual([['flee', 'done']]);
    expect(bot.floorReflexes.engagements.flee).toBe(1);
  });
  it('stops after five blocks and when the enemy is no longer near', async () => {
    const far = fixture();
    installFloorReflexes(far.bot, extended, { fleeTickMs: 1 });
    far.bot.setControlState = vi.fn(function(this: any, key: string, value: boolean) { if (key === 'forward' && value) far.bot.entity.position = far.bot.entity.position.offset(-2.5, 0, 0); });
    tick(far.bot); await settle(40);
    expect(far.bot.floorReflexes.busy).toBeNull();
    expect(far.bot.setControlState.mock.calls.filter(([key, value]: [string, boolean]) => key === 'forward' && value).length).toBeLessThanOrEqual(3);
    const gone = fixture();
    installFloorReflexes(gone.bot, extended, { fleeTickMs: 1 });
    tick(gone.bot); gone.bot.entities = {}; await settle(40);
    expect(gone.bot.floorReflexes.busy).toBeNull();
  });
  it('is twice in 20 seconds however often the danger comes back', async () => {
    const { bot, ledger } = fixture();
    installFloorReflexes(bot, extended, { fleeTickMs: 1 });
    for (let i = 0; i < 4; i++) { tick(bot); await settle(500); }
    expect(ledger.entriesSince(-1).filter(entry => entry.kind === 'flee')).toHaveLength(2);
  });
  it('gives way to a stronger reflex taking the body, and is reported as cut', async () => {
    const { bot, ledger } = fixture();
    installFloorReflexes(bot, extended, { fleeTickMs: 20 });
    tick(bot); await settle(25);
    expect(activeActionCapabilities(bot)).toEqual(['floor-flee']);
    preemptLowerPriorityActions(bot, 350, 'floor-retreat');
    const writes = bot.setControlState.mock.calls.length;
    await settle(60);
    // Having lost the body, the flee writes nothing more (not even its key release): whatever took it holds the keys now.
    expect(bot.setControlState.mock.calls.length).toBe(writes);
    expect(ledger.entriesSince(-1).map(entry => [entry.kind, entry.outcome])).toEqual([['flee', 'cut']]);
    expect(ledger.preemptsSince(-1)[0]).toMatchObject({ by: 'floor-retreat', aborted: ['floor-flee'] });
    expect(bot.floorReflexes.busy).toBeNull();
  });
  it('cuts a fight under it at this health, and never the API\'s own flee', async () => {
    const { bot, ledger } = fixture();
    installFloorReflexes(bot, extended, { fleeTickMs: 1 });
    const fight = executeAction(bot, 'attack-continuously', 5000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'ok' }), 500)), { priority: 0 });
    await settle(5); tick(bot);
    expect(await fight).toMatchObject({ success: false, failureType: 'interrupted' });
    await settle(60);
    expect(ledger.cutOff(-1, 'attack-continuously')?.by).toBe('floor-flee');
    const running = fixture();
    installFloorReflexes(running.bot, extended, { fleeTickMs: 1 });
    const escape = executeAction(running.bot, 'flee-from', 5000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'ran' }), 60)), { priority: 0 });
    await settle(5); tick(running.bot);
    expect(running.bot.floorReflexes.busy).toBeNull();
    expect(await escape).toMatchObject({ success: true, result: 'ran' });
  });
  it('does not start a meal or an armour change while it holds the body', async () => {
    const { bot } = fixture({ food: 2, inventory: { items: () => [{ name: 'bread' }, { name: 'iron_helmet' }], slots: new Array(46).fill(null) } });
    bot.entities = { 2: { id: 2, name: 'zombie', position: new Vec3(2.5, 65, 0) } };
    installFloorReflexes(bot, extended, { fleeTickMs: 20 });
    tick(bot); tick(bot); tick(bot);
    expect(bot.floorReflexes.busy).toBe('flee');
    await settle(10);
    expect(bot.equip).not.toHaveBeenCalled(); expect(bot.consume).not.toHaveBeenCalled();
    await settle(600);
  });
});

describe('floor reflexes under the switch', () => {
  it('off settings for retreat, eat and armor stop each one without touching the others', async () => {
    const items = [{ name: 'bread' }];
    const eatOff = fixture({ health: 20, food: 2, entities: {}, inventory: { items: () => items, slots: new Array(46).fill(null) } });
    installFloorReflexes(eatOff.bot, floorConfig({ MINEBOT_FCA_REFLEX_OFF: 'eat' })); tick(eatOff.bot); await settle(5);
    expect(eatOff.bot.consume).not.toHaveBeenCalled();
    const eatOn = fixture({ health: 20, food: 2, entities: {}, inventory: { items: () => items, slots: new Array(46).fill(null) } });
    installFloorReflexes(eatOn.bot, floorConfig({})); tick(eatOn.bot); await settle(5);
    expect(eatOn.bot.consume).toHaveBeenCalledTimes(1);
    const lit: unknown[] = []; lit[16] = 1;
    const retreatOff = fixture({ health: 20, entities: { 2: { id: 2, name: 'creeper', position: new Vec3(3, 65, 0), metadata: lit } } });
    installFloorReflexes(retreatOff.bot, floorConfig({ MINEBOT_FCA_REFLEX_OFF: 'retreat' })); tick(retreatOff.bot); await settle(5);
    expect(retreatOff.bot.setControlState).not.toHaveBeenCalled();
    const retreatOn = fixture({ health: 20, entities: { 2: { id: 2, name: 'creeper', position: new Vec3(3, 65, 0), metadata: lit } } });
    installFloorReflexes(retreatOn.bot, floorConfig({})); tick(retreatOn.bot); await settle(5);
    expect(retreatOn.bot.setControlState).toHaveBeenCalledWith('forward', true);
    retreatOn.bot.entities = {}; tick(retreatOn.bot); await settle(5);
    expect(retreatOn.ledger.entriesSince(-1).map(entry => [entry.kind, entry.detail])).toEqual([['retreat', '火の付いたクリーパーから離れた']]);
  });
});
