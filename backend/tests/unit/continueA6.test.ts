import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { fightsFirst } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
import { EventStore, MAX_EVENTS } from '../../src/services/minebot/integration/commonFca/eventStore.js';
import { cancelAction, createMotorPort, executeAction, handoverOf, noteShieldState, physicalRoots, reservationOf, reserveHandover, setShieldNoteSink } from '../../src/services/minebot/execution/ActionExecution.js';
import { installShieldBlock } from '../../src/services/minebot/utils/shieldBlock.js';
import { runLastStand } from '../../src/services/minebot/utils/floorReflexes.js';
import { renderActReport, type ActReport } from '../../src/services/minebot/utils/actReport.js';
import type { InventoryEvent } from '../../src/services/minebot/integration/commonFca/continueContract.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Amendment A-6 (the final review's body items): the pieces that do not need the isolated lab.

describe('A-6 (1): the handover reads the first hand that moves the body', () => {
  const bot = (held: string | null, food = 20) => ({ heldItem: held ? { name: held } : null, food });
  it('an equip of what is already held, a look, a sneak, a wait and a meal at full food come before a fight that is still a fight first', () => {
    const fight = { do: 'fight', target: '#5' };
    expect(fightsFirst(bot('iron_sword'), [[{ do: 'equip', item: 'iron_sword' }, fight]])).toBe(true);
    expect(fightsFirst(bot(null), [[{ do: 'look', at: 'north' }, { do: 'sneak', on: true }, { do: 'wait', seconds: 1 }, fight]])).toBe(true);
    expect(fightsFirst(bot(null, 20), [[{ do: 'eat' }, { do: 'attack', target: '#5' }]])).toBe(true);
  });
  it('an equip of something not held, a meal when hungry, or any other hand first is not a fight first', () => {
    const fight = { do: 'fight', target: '#5' };
    expect(fightsFirst(bot('stone_sword'), [[{ do: 'equip', item: 'iron_sword' }, fight]])).toBe(false);
    expect(fightsFirst(bot(null, 10), [[{ do: 'eat' }, fight]])).toBe(false);
    expect(fightsFirst(bot(null), [[{ do: 'go', to: [1, 2, 3] }, fight]])).toBe(false);
    expect(fightsFirst(bot(null), [[fight]])).toBe(true);
    expect(fightsFirst(bot(null), { hands: [fight] })).toBe(true);
    expect(fightsFirst(bot(null), undefined)).toBe(false);
  });
});

describe('A-6 (2, 9): the shield through a handover', () => {
  function body(shieldUp: boolean) {
    const calls: string[] = [];
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { position: new Vec3(0, 64, 0), yaw: 0, onGround: true }, health: 20, food: 20, game: { dimension: 'overworld' }, entities: {},
      executingSkill: false, interruptExecution: false, usingHeldItem: shieldUp,
      shieldBlock: { up: shieldUp, lowered: 0, deactivateCalls: 0 },
      setControlState: () => undefined, clearControlStates: () => undefined, look: async () => undefined,
      deactivateItem: () => { calls.push('deactivate'); bot.shieldBlock.deactivateCalls++; }, activateItem: () => undefined, stopDigging: () => undefined,
    });
    return { bot, calls };
  }
  async function handoverWith(setup: (bot: any) => void, shield = true) {
    const { bot, calls } = body(true);
    const notes: Array<{ kind: string; data: Record<string, any> }> = [];
    setShieldNoteSink(bot, (kind, data) => notes.push({ kind, data }));
    const reflex = executeAction(bot, 'floor-melee', 5000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'x' }), 30)), { priority: 250, safetyLease: true, waitForQuiescence: false });
    await delay(5);
    const [root] = physicalRoots(bot);
    reserveHandover(bot, { fromActionId: root.actionId, reflex: 'floor-melee', target: 7, life: 1, forCommand: 'cmd', shield });
    setup(bot);
    let seen: any = null;
    const act = executeAction(bot, 'act', 2000, async () => { seen = handoverOf(bot) ?? null; createMotorPort(bot).look(0, 0); return { success: true, result: 'ok' }; }, { waitForQuiescence: true, handover: { command: 'cmd', verify: () => true } });
    await reflex;
    await act;
    return { bot, calls, notes, handover: seen as any };
  }
  it('stays "kept" only when the shield was up without a break from the reservation to the claim', async () => {
    const { handover, calls, notes } = await handoverWith(() => undefined);
    expect(handover).toMatchObject({ confirmed: true, shield: 'kept' });
    expect(calls).not.toContain('deactivate');
    // The actual state is written at the reservation, the claim and the first operation (the measurement reads them beside the operations).
    expect(notes.map(note => note.data.point)).toEqual(['reservation', 'acquire', 'first_op']);
    expect(notes.every(note => note.kind === 'motor_state' && note.data.shield === true && note.data.command === 'cmd')).toBe(true);
    expect(notes[1].data).toMatchObject({ result: 'kept', loweredSince: 0, deactivatedSince: 0, deactivateItem: false });
  });
  it('is "dropped" when it was lowered, or deactivated, or no longer in use, between the reservation and the claim', async () => {
    const lowered = await handoverWith(bot => { bot.shieldBlock.up = false; bot.shieldBlock.lowered++; });
    expect(lowered.handover).toMatchObject({ confirmed: true, shield: 'dropped' });
    expect(lowered.notes.find(note => note.data.point === 'acquire')!.data).toMatchObject({ shield: false, loweredSince: 1, result: 'dropped' });
    const deactivated = await handoverWith(bot => { bot.deactivateItem(); });
    expect(deactivated.handover.shield).toBe('dropped');
    expect(deactivated.notes.find(note => note.data.point === 'acquire')!.data.deactivatedSince).toBe(1);
    const idle = await handoverWith(bot => { bot.usingHeldItem = false; });
    expect(idle.handover.shield).toBe('dropped');
  });
  it('a reservation made without the shield says "none"', async () => {
    const { handover } = await handoverWith(() => undefined, false);
    expect(handover).toMatchObject({ confirmed: true, shield: 'none' });
  });
  it('the resident shield does not lower the shield while a shield reservation is held, and does once it is gone', async () => {
    const calls: string[] = [];
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0, onGround: true }, health: 20, entities: {}, game: { dimension: 'overworld' }, usingHeldItem: true,
      inventory: { slots: new Array(46).fill(null) }, getEquipmentDestSlot: () => 45, deactivateItem: () => { calls.push('deactivate'); }, activateItem: () => undefined,
      executingSkill: false, interruptExecution: false, clearControlStates: () => undefined, stopDigging: () => undefined,
    });
    installShieldBlock(bot);
    // No shield on the arm: on every tick the resident shield would lower what it holds.
    bot.shieldBlock.up = true;
    reserveHandover(bot, { fromActionId: 'a', reflex: 'floor-melee', target: 1, life: 1, forCommand: 'c', shield: true }, Date.now(), 5_000);
    bot.emit('physicsTick'); bot.emit('physicsTick');
    expect(bot.shieldBlock.up).toBe(true);
    expect(calls).toEqual([]);
    // Without a shield reservation it lowers as before.
    const { dropReservation } = await import('../../src/services/minebot/execution/ActionExecution.js');
    dropReservation(bot, 'cancelled');
    expect(reservationOf(bot)).toBeNull();
    bot.shieldBlock.up = true; calls.length = 0;
    bot.emit('physicsTick');
    expect(bot.shieldBlock.up).toBe(false);
    expect(calls).toEqual(['deactivate']);
    noteShieldState(bot, 'stop');
    setShieldNoteSink(bot, null);
  });
});

describe('A-6 (5): the life of an act is the life it ran in', () => {
  it('the outcome carries the life the act began in, not the life it is rendered in', () => {
    const bot: any = { life: undefined, entity: { position: new Vec3(0, 64, 0) }, health: 0, game: { dimension: 'overworld' }, entities: {}, inventory: { items: () => [], slots: [] } };
    const report: ActReport = { startedAt: Date.now(), lines: [], ok: false, done: 0, of: 1, life: 3, outcome: { goal: 'failed', end: 'cut', cutBy: 'death' } };
    const text = renderActReport(bot, report);
    expect(JSON.parse(text).outcome).toMatchObject({ goal: 'failed', end: 'cut', cutBy: 'death', life: 3 });
  });
});

describe('A-6 (6): the events of a command the head has not acknowledged are not dropped by age or count', () => {
  const events = (command: string, count: number): InventoryEvent[] => Array.from({ length: count }, (_, index) => ({ id: `${command}:${index}`, obsSeq: 1, item: 'cobblestone', count: -1, reason: 'placed' as const, deliverySeq: index }));
  it('an old unacknowledged record is kept, an old acknowledged one goes', () => {
    let clock = 1_000_000;
    const store = new EventStore(() => clock);
    store.add('a', events('a', 3)); store.add('b', events('b', 3));
    store.acknowledgeReceipt('b');
    store.add('c', events('c', 1));
    clock += 3 * 60 * 60_000;
    store.add('d', events('d', 1));
    expect(store.page('a', 0).lost).toBe(false);
    expect(store.page('a', 0).events).toHaveLength(3);
    expect(store.page('c', 0).lost).toBe(false);
    expect(store.page('b', 0).lost).toBe(true);   // acknowledged and old: pruned
  });
  it('past the 5,000 events the acknowledged records go first; only then an unacknowledged one is dropped, and it says lost with its total', () => {
    const store = new EventStore();
    store.add('acked', events('acked', 2_000)); store.acknowledgeReceipt('acked');
    store.add('old', events('old', 2_000));
    store.add('new', events('new', 2_000));
    // 6,000 held: the acknowledged one (still holding pages the head had not taken) is dropped first and nothing unacknowledged is lost.
    expect(store.isLost('old')).toBe(false); expect(store.isLost('new')).toBe(false);
    expect(store.page('old', 0).events.length).toBeGreaterThan(0);
    store.add('newer', events('newer', 2_000));
    // 6,000 again with nothing acknowledged left: the oldest unacknowledged one is lost, explicitly, and the head is told so.
    expect(store.isLost('old')).toBe(true);
    const reply = store.page('old', 0);
    expect(reply).toMatchObject({ lost: true, total: 2_000, events: [] });
    expect(store.more('old', [])).toMatchObject({ command: 'old', total: 2_000 });
    expect(store.page('new', 0).lost).toBe(false);
    expect(store.page('newer', 0).lost).toBe(false);
    expect(MAX_EVENTS).toBe(5_000);
    store.acknowledgeReceipt('old');
    expect(store.page('old', 0).lost).toBe(true);   // gone, and an absent record also answers lost
  });
});

describe('A-6 (8): a last stand\'s wait between blows ends when the action is stopped', () => {
  it('the second blow is not waited for once the action is cut during the gap', async () => {
    const target: any = { id: 7, name: 'zombie', type: 'hostile', position: new Vec3(1.5, 64, 0.5), isValid: true };
    const swings: number[] = [];
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { id: 1, position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, onGround: true }, health: 4, game: { dimension: 'overworld' }, entities: { 7: target },
      heldItem: null, inventory: { items: () => [], slots: [] }, executingSkill: false, interruptExecution: false,
      setControlState: () => undefined, clearControlStates: () => undefined, look: async () => undefined, lookAt: async () => undefined,
      deactivateItem: () => undefined, stopDigging: () => undefined, attack: vi.fn((entity: any) => { swings.push(entity.id); }),
    });
    let elapsed = -1, result: any;
    const running = executeAction(bot, 'floor-last-stand', 5000, async () => {
      const port = createMotorPort(bot);
      const t0 = Date.now();
      result = await runLastStand(bot as never, port as never, { kind: 'hit', target, weapon: null, detail: 'x' } as never);
      elapsed = Date.now() - t0;
      return { success: true, result: 'x' };
    }, { priority: 250, safetyLease: true, waitForQuiescence: false });
    await delay(120);
    const [root] = physicalRoots(bot);
    cancelAction(bot, root.actionId, 'interrupted');
    await running;
    expect(swings).toEqual([7]);
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(450);
    expect(result).toMatchObject({ success: true });
  });
});

describe('A-6 (5): the act\'s own life, read from the native body behind the motor port', () => {
  it('the outcome carries the life the act began in (1), also when the body dies during it and when the hands are refused before they start', async () => {
    const { installLife } = await import('../../src/services/minebot/utils/life.js');
    const { runAct } = await import('../../src/services/minebot/instantSkills/act.js');
    const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'life-a6-')), 'life.json');
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { id: 1, position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, onGround: true }, username: 'a6', health: 20, food: 20, game: { dimension: 'overworld' }, entities: {},
      inventory: { items: () => [], slots: new Array(46).fill(null) }, controlState: {}, executingSkill: false, interruptExecution: false,
      clearControlStates: () => undefined, setControlState: () => undefined, look: async () => undefined, stopDigging: () => undefined,
    });
    const keeper = installLife(bot, { file });
    expect(keeper.number).toBe(1);
    // died during the act: the life number goes up, the outcome stays the life it ran in
    const running = executeAction(bot, 'act', 5000, async () => {
      const result = await runAct(createMotorPort(bot), [{ do: 'wait', seconds: 0.4 } as never, { do: 'jump' } as never]);
      return { success: result.success, result: result.result };
    }, { waitForQuiescence: true });
    await delay(120);
    bot.health = 0; bot.emit('death');
    const done: any = await running;
    expect(keeper.number).toBe(2);
    expect(JSON.parse(done.result).outcome.life).toBe(1);
    // refused before it starts (a wrong hand list): the life it was made in, not 0
    const bad = await runAct(createMotorPort(bot), [{ do: 'wait' } as never, { do: 'vertical', dir: 'sideways' } as never]);
    expect(JSON.parse(bad.result).outcome).toMatchObject({ goal: 'not_started', end: 'not_run', life: 2 });
  });
});
