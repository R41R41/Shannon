import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { LifeKeeper } from '../../src/services/minebot/utils/life.js';
import { lapseOf, madenessOf, type BodyNow } from '../../src/services/minebot/integration/commonFca/lapse.js';
import { BodyQueue, readEnvelope, type QueueEnvelope } from '../../src/services/minebot/integration/commonFca/bodyQueue.js';
import { aggregateGoal, dependStateOf, isReliable, keepVerdict, startVerdict } from '../../src/services/minebot/integration/commonFca/continueContract.js';
import { EventStore } from '../../src/services/minebot/integration/commonFca/eventStore.js';
import { runAct, ACT_HANDS, dependsProblem } from '../../src/services/minebot/instantSkills/act.js';
import { executeAction, holderSeqOf, motorOpsOf, createMotorPort, reserveHandover, reservationOf, dropReservation, physicalRoots } from '../../src/services/minebot/execution/ActionExecution.js';
import { renderActReport, RECEIPT_MAX, type ActReport } from '../../src/services/minebot/utils/actReport.js';
import { trackPack, installPackTap } from '../../src/services/minebot/utils/packEvents.js';
import { parseDependencyTable } from './helpers/dependencyTable.js';

const tempFile = (name: string) => path.join(mkdtempSync(path.join(tmpdir(), 'continue-')), name);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('the life number (contract 5)', () => {
  const botOf = () => Object.assign(new EventEmitter(), { username: 'shannon', health: 20, game: { dimension: 'overworld' } });
  it('starts at 1 for a first world, counts a death, and keeps the number in the file', () => {
    const file = tempFile('life.json');
    const bot: any = botOf();
    const keeper = new LifeKeeper(bot, { file });
    expect(keeper.view()).toMatchObject({ life: 1, deathSeq: 0, alive: true });
    const epoch = keeper.view().deathEpoch;
    bot.health = 0; bot.emit('death');
    expect(keeper.view()).toMatchObject({ life: 2, deathSeq: 1, deathEpoch: epoch, advancedBy: 'death', alive: false });
    bot.health = 20; bot.emit('spawn');
    expect(keeper.view().alive).toBe(true);
    // A restart of the process reads the same numbers (the number does not go back to 1).
    const again = new LifeKeeper(botOf(), { file });
    expect(again.view()).toMatchObject({ life: 2, deathSeq: 1, deathEpoch: epoch });
  });
  it('does not go back to 1 when the file is there and cannot be read: a big number, a new epoch counted from 0, no death', () => {
    const file = tempFile('life.json');
    writeFileSync(file, '{ not json');
    const notes: string[] = [];
    const keeper = new LifeKeeper(botOf(), { file, now: () => 1793164759174, note: what => { notes.push(what); } });
    expect(keeper.view()).toMatchObject({ life: 1793164759174, advancedBy: 'file_unreadable', deathSeq: 0 });
    expect(notes).toEqual(['life_file_unreadable']);
  });
  it('a change of dimension is not a death: the life stays and the dimension generation moves (also on a return)', () => {
    const bot: any = botOf();
    let at = 1000;
    const keeper = new LifeKeeper(bot, { file: tempFile('life.json'), now: () => at });
    const first = keeper.view();
    at = 2000; bot.game.dimension = 'the_nether'; bot.emit('respawn');
    const second = keeper.view();
    expect(second.life).toBe(first.life);
    expect(second.dimension).toBe('the_nether');
    expect(second.dimensionSince).not.toBe(first.dimensionSince);
    at = 3000; bot.game.dimension = 'overworld'; bot.emit('respawn');
    const third = keeper.view();
    expect(third.dimension).toBe('overworld');
    expect(third.dimensionSince).not.toBe(first.dimensionSince);
  });
});

describe('the lapses (contract 2, 5): the first that applies', () => {
  const made = { life: 4, dim: 'overworld' as const, dimSince: 'd1', bodyBoot: 'bb', connectionId: 'c1', headBoot: 'h1', obsSeq: 10 };
  const now = (over: Partial<BodyNow> = {}): BodyNow => ({ life: { life: 4, since: 'x', alive: true, dimension: 'overworld', dimensionSince: 'd1' }, bodyBoot: 'bb', connectionId: 'c1', headBoot: 'h1', ...over });
  const ctx = { life: 4, headBoot: 'h1', madeIn: made } as never;
  it('a command with no life or no madeIn is life_missing', () => {
    expect(lapseOf(madenessOf({} as never), now(), { dimension: true })?.code).toBe('life_missing');
    expect(lapseOf(madenessOf({ life: 4 } as never), now(), { dimension: true })?.code).toBe('life_missing');
  });
  it('is none when everything is the one now', () => { expect(lapseOf(madenessOf(ctx), now(), { dimension: true })).toBeNull(); });
  it('a changed connection, boot or head is connection_changed, before a changed life', () => {
    expect(lapseOf(madenessOf(ctx), now({ connectionId: 'c2', life: { ...now().life, life: 5 } }), { dimension: true })?.code).toBe('connection_changed');
    expect(lapseOf(madenessOf(ctx), now({ bodyBoot: 'other' }), { dimension: true })?.code).toBe('connection_changed');
    expect(lapseOf(madenessOf(ctx), now({ headBoot: 'h2' }), { dimension: true })?.code).toBe('connection_changed');
  });
  it('a new life is stale_life; a new dimension generation is dimension_changed unless the command is the one changing it', () => {
    expect(lapseOf(madenessOf(ctx), now({ life: { ...now().life, life: 5 } }), { dimension: true })?.code).toBe('stale_life');
    const nether = now({ life: { ...now().life, dimension: 'the_nether', dimensionSince: 'd2' } });
    expect(lapseOf(madenessOf(ctx), nether, { dimension: true })?.code).toBe('dimension_changed');
    expect(lapseOf(madenessOf(ctx), nether, { dimension: false })).toBeNull();
  });
  it('a dead body starts nothing', () => {
    expect(lapseOf(madenessOf(ctx), now({ life: { ...now().life, alive: false } }), { dimension: true })?.code).toBe('not_alive');
  });
});

describe('the dependency table (fixture continue/dependency-table.json)', () => {
  const table = parseDependencyTable();
  it('every row of the table gives the dependState the rules give', () => {
    for (const row of table.outcomes) {
      expect(dependStateOf({ goal: row.goal, end: row.end, released: row.released, ended: true }), JSON.stringify(row)).toBe(row.dependState);
    }
    expect(dependStateOf(null)).toBe('unknown');
    expect(dependStateOf({ goal: 'done', end: 'finished', released: true, ended: false })).toBe('pending');
  });
  it('a goal and end that the table does not allow are never reliable', () => {
    for (const row of table.notAllowed) expect(isReliable({ goal: row.goal, end: row.end })).toBe(false);
  });
  it('keeps and starts as the table says', () => {
    expect(keepVerdict(['succeeded', 'pending'])).toBe('keep');
    expect(keepVerdict(['succeeded', 'failed'])).toBe('depends_failed');
    expect(keepVerdict(['pending', 'unknown'])).toBe('depends_unknown');
    expect(startVerdict(['succeeded'])).toBe('start');
    expect(startVerdict(['succeeded', 'pending'])).toBe('wait');
    expect(startVerdict(['failed'])).toBe('drop');
  });
  it('aggregates the hands top to bottom (doneMet, done, unknown, partial, failed, not_started)', () => {
    expect(aggregateGoal([{ goal: 'failed', motorOps: 3 }], true)).toBe('done');
    expect(aggregateGoal([{ goal: 'done' }, { goal: 'already' }], false)).toBe('done');
    expect(aggregateGoal([{ goal: 'already' }, { goal: 'already' }], false)).toBe('already');
    expect(aggregateGoal([{ goal: 'partial' }, { goal: 'unknown' }], false)).toBe('unknown');
    expect(aggregateGoal([{ goal: 'done' }, { goal: 'failed', motorOps: 1 }, { goal: 'not_started' }], false)).toBe('partial');
    expect(aggregateGoal([{ goal: 'not_started', motorOps: 2 }], false)).toBe('failed');
    expect(aggregateGoal([{ goal: 'already' }, { goal: 'not_started', motorOps: 0 }], false)).toBe('not_started');
  });
});

describe('the queue (contract 2): what waits is judged by what it depends on', () => {
  const made = { life: 1, dim: 'overworld' as const, dimSince: 'd', bodyBoot: 'bb', connectionId: 'c', headBoot: 'h', obsSeq: 1 };
  const Q = 't-run:hb-1:40';
  const item = (id: string, after: string | null, dependsOn?: string[], extra: Record<string, unknown> = {}) => ({
    id: `skill:${id}`, kind: 'skill', skill: 'act', queue: { item: id, after, node: null, maxMs: 10_000, startBy: new Date(Date.now() + 60_000).toISOString(), queue: Q, madeIn: made, ...(dependsOn ? { dependsOn } : {}), ...extra },
  }) as never;
  const envelope = (id: string, after: string | null, dependsOn?: string[]) => readEnvelope(item(id, after, dependsOn)) as QueueEnvelope;
  const failed = { goal: 'failed' as const, end: 'finished' as const, released: true };
  const ok = { goal: 'done' as const, end: 'finished' as const, released: true };

  it('admits an item behind one that stopped when it names what it depends on without it, and never skips the tail', () => {
    const queue = new BodyQueue();
    queue.note(Q, 'q20', failed);
    expect(queue.admit(envelope('q21', 'q20', []))).toBe('start');
    expect(queue.admit(envelope('q21', 'q20'))).toMatchObject({ failureType: 'queue_after_gone' });
    expect(queue.admit(envelope('q21', 'q20', ['q20']))).toMatchObject({ failureType: 'queue_after_gone' });
    const busy = new BodyQueue();
    busy.note(Q, 'q20', failed);
    busy.begin(item('q22', null));
    expect(busy.admit(envelope('q23', 'q20', []))).toMatchObject({ failureType: 'queue_after_gone', result: expect.stringContaining('q22') });
  });
  it('after a failure: the independent one stays (keptDespite), the ones that name it or name nothing are dropped, naming the item', () => {
    const queue = new BodyQueue();
    queue.begin(item('q12', null));
    queue.waiting.push(item('q13', 'q12', []), item('q14', 'q13'));
    const judged = queue.judgeWaiting({ queue: Q, item: 'q12', unit: { ...failed, code: 'stuck' } });
    expect(judged.kept.map(entry => [entry.command.queue?.item, entry.item.item, entry.code])).toEqual([['q13', 'q12', 'failed']]);
    expect(judged.dropped.map(entry => [entry.command.queue?.item, entry.code, entry.item?.item])).toEqual([['q14', 'depends_failed', 'q12']]);
    expect(queue.waiting.map(command => command.queue?.item)).toEqual(['q13']);
  });
  it('an item that names a dropped one is dropped with it; one that names an item it does not remember is depends_unknown; after a success all stay', () => {
    const queue = new BodyQueue();
    queue.waiting.push(item('q13', 'q12'), item('q15', 'q13', ['q13']));
    const judged = queue.judgeWaiting({ queue: Q, item: 'q12', unit: failed });
    expect(judged.dropped.map(entry => [entry.command.queue?.item, entry.code, entry.item?.item])).toEqual([['q13', 'depends_failed', 'q12'], ['q15', 'depends_failed', 'q13']]);
    const strange = new BodyQueue();
    strange.waiting.push(item('q30', 'q29', ['q99']));
    expect(strange.judgeWaiting({ queue: Q, item: 'q29', unit: failed }).dropped.map(entry => entry.code)).toEqual(['depends_unknown']);
    const good = new BodyQueue();
    good.waiting.push(item('q31', 'q30'), item('q32', 'q31', ['q31']));
    expect(good.judgeWaiting({ queue: Q, item: 'q30', unit: ok })).toEqual({ dropped: [], kept: [] });
  });
  it('keeps an item that depends on a pending one, and the state of a reference follows the table', () => {
    const queue = new BodyQueue();
    queue.begin(item('q1', null));
    expect(queue.stateOf(Q, 'q1')).toBe('pending');
    queue.end('q1', Q, failed);
    expect(queue.stateOf(Q, 'q1')).toBe('failed');
    queue.note(Q, 'q2', { goal: 'done', end: 'finished', released: false });
    expect(queue.stateOf(Q, 'q2')).toBe('unknown');
    queue.note(Q, 'q3', { goal: 'unknown', end: 'unknown', released: true });
    expect(queue.stateOf(Q, 'q3')).toBe('unknown');
    expect(queue.stateOf(Q, 'q404')).toBe('unknown');
    queue.waiting.push(item('q5', 'q3'));
    expect(queue.stateOf(Q, 'q5')).toBe('pending');
  });
  it('a cancel (replace) takes the item and the ones behind it that name it or name nothing; an explicit independent one stays', () => {
    const queue = new BodyQueue();
    queue.begin(item('q12', null));
    queue.waiting.push(item('q13', 'q12'), item('q14', 'q13'));
    expect(queue.removeWithDependents('skill:q13').map(command => command.queue?.item)).toEqual(['q13', 'q14']);
    const second = new BodyQueue();
    second.waiting.push(item('q13', 'q12'), item('q16', 'q13', []));
    expect(second.removeWithDependents('skill:q13').map(command => command.queue?.item)).toEqual(['q13']);
    expect(second.waiting.map(command => command.queue?.item)).toEqual(['q16']);
  });
  it('refuses an envelope that is not well formed (self dependency, a repeat, no madeIn)', () => {
    expect(readEnvelope(item('q5', null, ['q5']))).toBeNull();
    expect(readEnvelope(item('q5', null, ['q4', 'q4']))).toBeNull();
    expect(readEnvelope(item('q5', null, undefined, { madeIn: undefined }))).toBeNull();
  });
});

describe('the execution layer (contract 4, 8): owners, operations, the handover reservation', () => {
  function body() {
    const calls: string[] = [];
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { position: new Vec3(0, 64, 0), yaw: 0, onGround: true }, health: 20, food: 20, game: { dimension: 'overworld' }, entities: {},
      executingSkill: false, interruptExecution: false,
      setControlState: (key: string, value: boolean) => { calls.push(`set ${key}=${value}`); },
      clearControlStates: () => { calls.push('clear'); },
      look: async () => { calls.push('look'); },
      deactivateItem: () => { calls.push('deactivate'); },
      activateItem: () => { calls.push('activate'); },
      stopDigging: () => { calls.push('stopDigging'); },
    });
    return { bot, calls };
  }
  it('counts only the root action\'s effective operations (a release is not one) and its owner number rises per action that moves the body', async () => {
    const { bot } = body();
    const before = holderSeqOf(bot);
    let ops = -1;
    const result = await executeAction(bot, 'jump', 1000, async () => {
      const port: any = createMotorPort(bot);
      port.setControlState('jump', true); port.setControlState('jump', false); port.clearControlStates(); port.look(0, 0);
      ops = motorOpsOf(port);
      return { success: true, result: 'ok' };
    }, { waitForQuiescence: true });
    expect(ops).toBe(2);   // jump=true and look; the release and the clear are not counted
    expect((result as any).execution.motorOps).toBe(2);
    expect((result as any).execution.lockAt).toBeGreaterThan(0);
    expect((result as any).execution.firstMotorAt).toBeGreaterThanOrEqual((result as any).execution.lockAt);
    expect(holderSeqOf(bot)).toBe(before + 1);
    await executeAction(bot, 'get-health', 1000, async () => ({ success: true, result: 'ok' }), { waitForQuiescence: true });
    expect(holderSeqOf(bot)).toBe(before + 1);   // a query takes no owner
  });
  it('a stop for a handover leaves the shield up; a stop for anything else lowers it', async () => {
    for (const [reason, lowered] of [['handover', false], ['interrupted', true]] as const) {
      const { bot, calls } = body();
      const running = executeAction(bot, 'floor-melee', 5000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'late' }), 200)),
        { priority: 250, safetyLease: true, waitForQuiescence: false });
      await delay(10);
      const [root] = physicalRoots(bot);
      const { cancelAction } = await import('../../src/services/minebot/execution/ActionExecution.js');
      cancelAction(bot, root.actionId, reason);
      await running;
      expect(calls.includes('deactivate'), reason).toBe(lowered);
    }
  });
  it('the command a reservation is for takes the body with the lock (confirmed); anyone else removes it and the shield it held is lowered', async () => {
    const { bot, calls } = body();
    bot.shieldBlock = { up: true };
    const reflex = executeAction(bot, 'floor-melee', 5000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'x' }), 30)),
      { priority: 250, safetyLease: true, waitForQuiescence: false });
    await delay(5);
    const [root] = physicalRoots(bot);
    reserveHandover(bot, { fromActionId: root.actionId, reflex: 'floor-melee', target: 7, life: 1, forCommand: 'cmd1', shield: true });
    expect(reservationOf(bot)?.holderSeq).toBe(holderSeqOf(bot));
    const act = executeAction(bot, 'act', 2000, async () => ({ success: true, result: 'ok' }), { waitForQuiescence: true, handover: { command: 'cmd1', verify: () => true } });
    await reflex;
    const result: any = await act;
    expect(result.success).toBe(true);
    expect(calls).not.toContain('deactivate');
    expect(reservationOf(bot)).toBeNull();
    // Another holder takes the body first: the reservation is removed and the shield lowered.
    const second = body();
    second.bot.shieldBlock = { up: true };
    const first = executeAction(second.bot, 'floor-melee', 5000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'x' }), 20)), { priority: 250, safetyLease: true, waitForQuiescence: false });
    await delay(5);
    const [again] = physicalRoots(second.bot);
    reserveHandover(second.bot, { fromActionId: again.actionId, reflex: 'floor-melee', target: 7, life: 1, forCommand: 'cmd2', shield: true });
    const eat = executeAction(second.bot, 'floor-eat', 2000, async () => ({ success: true, result: 'ate' }), { priority: 200, safetyLease: true, waitForQuiescence: true });
    await first; await eat;
    expect(reservationOf(second.bot)).toBeNull();
    expect(second.calls).toContain('deactivate');
    expect(second.bot.shieldBlock.up).toBe(false);
  });
  it('a reservation that is not taken in its window lapses by itself and lowers the shield it held', async () => {
    const { bot, calls } = body();
    bot.shieldBlock = { up: true };
    reserveHandover(bot, { fromActionId: 'a', reflex: 'floor-melee', target: 1, life: 1, forCommand: 'cmd3', shield: true }, Date.now(), 40);
    expect(reservationOf(bot)).not.toBeNull();
    await delay(80);
    expect(reservationOf(bot)).toBeNull();
    expect(calls).toContain('deactivate');
    expect(dropReservation(bot)).toBe(false);
  });
  it('a command that comes after the window is not confirmed, and says it (shield lowered)', async () => {
    const { bot } = body();
    bot.shieldBlock = { up: true };
    const reflex = executeAction(bot, 'floor-melee', 5000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'x' }), 80)),
      { priority: 250, safetyLease: true, waitForQuiescence: false });
    await delay(5);
    const [root] = physicalRoots(bot);
    reserveHandover(bot, { fromActionId: root.actionId, reflex: 'floor-melee', target: 7, life: 1, forCommand: 'cmd4', shield: true }, Date.now(), 30);
    const act = executeAction(bot, 'act', 2000, async () => ({ success: true, result: 'ok' }), { waitForQuiescence: true, handover: { command: 'cmd4', verify: () => true } });
    await reflex; await act;
    expect(reservationOf(bot)).toBeNull();
  });
});

describe('the inventory events (contract 3)', () => {
  it('pages the events by delivery number: the same range gives the same events, a lost record says so', () => {
    const store = new EventStore();
    const events = Array.from({ length: 340 }, (_, index) => ({ id: `c:1:1:${index}`, obsSeq: 1, item: 'cobblestone', count: -1, reason: 'placed' as const, deliverySeq: index }));
    store.add('c', events);
    const one = store.page('c', 120, 120);
    expect(one).toMatchObject({ from: 120, to: 240, total: 340, nextSeq: 240, done: false, lost: false });
    expect(one.events.map(event => event.deliverySeq)[0]).toBe(120);
    const two = store.page('c', 240, 120);
    expect(two).toMatchObject({ from: 240, to: 340, total: 340, nextSeq: 340, done: true });
    expect(store.page('c', 120, 120).events).toEqual(one.events);
    expect(store.page('other', 0)).toMatchObject({ lost: true, events: [] });
  });
  it('tells what a hand changed with its reason, takes off what a reflex did in the middle, and a reflex\'s meal is told once on its own', async () => {
    const pack = new Map([['bread', 2], ['cobblestone', 10]]);
    const bot: any = Object.assign(new EventEmitter(), {
      inventory: { items: () => [...pack.entries()].map(([name, count]) => ({ name, count })) }, heldItem: { name: 'bread' },
      consume: vi.fn(async () => { pack.set('bread', (pack.get('bread') ?? 0) - 1); }), equip: vi.fn(async () => undefined),
    });
    installPackTap(bot);
    const told: any[] = [];
    bot.on('minebotInventoryChanged', (info: unknown) => told.push(info));
    const track = trackPack(bot);
    pack.set('cobblestone', 8);
    await bot.consume();                        // by no command's hand: a reflex's meal
    const drafts: any[] = [];
    track.finish({ loss: 'placed' }, event => drafts.push(event));
    expect(drafts).toEqual([{ item: 'cobblestone', count: -2, reason: 'placed' }]);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ item: 'bread', count: -1, reason: 'reflex_eat' });
  });
});

describe('the act\'s result on two axes (contract 1) and its hands\' dependencies (contract 2)', () => {
  function body() {
    const blocks = new Map<string, any>();
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true, height: 1.8 }, health: 20, food: 20, game: { dimension: 'overworld' }, entities: {},
      inventory: { items: () => [], slots: new Array(46).fill(null) },
      blockAt: (p: Vec3) => {
        const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
        if (blocks.has(key)) return { ...blocks.get(key), position: p.floored() };
        return Math.floor(p.y) < 64 ? { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5, position: p.floored() } : { name: 'air', boundingBox: 'empty', position: p.floored() };
      },
      setControlState: () => undefined, clearControlStates: () => undefined,
    });
    return bot;
  }
  const hands = (value: unknown) => ACT_HANDS.parse(value);
  const parse = (result: { result: string }) => JSON.parse(result.result);
  const far = { x: 9, y: 63, z: 0 };   // out of reach: a dig that stops by itself

  it('a hand that stops by itself is finished; a hand the act never reached is not started and not run; the act is not_started when nothing moved', async () => {
    const json = parse(await runAct(body(), hands([{ do: 'dig', at: [far] }, { do: 'wait', seconds: 0.1 }])));
    expect(json.lines[0]).toMatchObject({ i: 1, status: 'stopped', goal: 'not_started', end: 'finished', code: 'out_of_reach', motorOps: 0 });
    expect(json.lines[1]).toMatchObject({ i: 2, status: 'skipped', goal: 'not_started', end: 'not_run' });
    expect(json.outcome).toMatchObject({ goal: 'not_started', end: 'finished' });
  });
  it('a hand that explicitly depends on nothing goes on after a hand that stopped the act; one that depends on the stopped hand is not run; one that says nothing is not run, as now', async () => {
    const json = parse(await runAct(body(), hands([{ do: 'dig', at: [far] }, { do: 'wait', seconds: 0.05, dependsOn: [] }, { do: 'wait', seconds: 0.05, dependsOn: [1] }, { do: 'wait', seconds: 0.05 }])));
    expect(json.lines.map((line: any) => [line.i, line.status, line.goal, line.end, line.code])).toEqual([
      [1, 'stopped', 'not_started', 'finished', 'out_of_reach'],
      [2, 'done', 'done', 'finished', undefined],
      [3, 'skipped', 'not_started', 'not_run', 'depends_failed:1'],
      [4, 'skipped', 'not_started', 'not_run', undefined],
    ]);
    expect(json.ok).toBe(false);
    expect(json.outcome).toMatchObject({ goal: 'partial', end: 'finished' });
  });
  it('a failure with onFail continue does not excuse the hands that name it; the next hand with no dependsOn goes on', async () => {
    const json = parse(await runAct(body(), hands([{ do: 'dig', at: [far], onFail: 'continue' }, { do: 'wait', seconds: 0.05, dependsOn: [1] }, { do: 'wait', seconds: 0.05 }])));
    expect(json.lines.map((line: any) => [line.i, line.status, line.goal, line.code])).toEqual([[1, 'failed', 'not_started', 'out_of_reach'], [2, 'skipped', 'not_started', 'depends_failed:1'], [3, 'done', 'done', undefined]]);
  });
  it('is indirect: a hand that names a hand that did not run does not run either', async () => {
    const json = parse(await runAct(body(), hands([{ do: 'dig', at: [far], onFail: 'continue' }, { do: 'wait', seconds: 0.05, dependsOn: [1] }, { do: 'wait', seconds: 0.05, dependsOn: [2] }])));
    expect(json.lines.map((line: any) => [line.i, line.end, line.code])).toEqual([[1, 'finished', 'out_of_reach'], [2, 'not_run', 'depends_failed:1'], [3, 'not_run', 'depends_failed:2']]);
  });
  it('refuses a dependsOn that is not well formed before any hand moves', async () => {
    expect(dependsProblem(hands([{ do: 'wait', dependsOn: [1] }]))).toContain('自分自身');
    expect(dependsProblem(hands([{ do: 'wait' }, { do: 'wait', dependsOn: [3] }, { do: 'wait' }]))).toContain('まだ先');
    expect(dependsProblem(hands([{ do: 'wait' }, { do: 'wait', dependsOn: [1, 1] }]))).toContain('重複');
    expect(dependsProblem(hands([{ do: 'wait' }, { do: 'wait', dependsOn: [7] }]))).toContain('範囲外');
    const result = await runAct(body(), hands([{ do: 'wait', seconds: 0.05 }, { do: 'wait', dependsOn: [2] }]));
    expect(result.success).toBe(false);
    expect(result.failureType).toBe('invalid_input');
    expect(parse(result).lines.every((line: any) => line.end === 'not_run')).toBe(true);
  });
});

describe('the receipt\'s size (contract 8): the lines of the older passes become a count, the events are never lost', () => {
  const fake: any = { entity: { position: new Vec3(0, 64, 0) }, health: 20, food: 20, game: { dimension: 'overworld' } };
  it('stays within the limit with a long text per line and many events, naming where to fetch what it left out', () => {
    const lines = Array.from({ length: 80 }, (_, index) => ({ i: (index % 4) + 1, do: 'place', status: 'done' as const, line: 'x'.repeat(150), pass: Math.floor(index / 4) + 1, goal: 'done' as const, end: 'finished' as const,
      delta: Array.from({ length: 6 }, (_, seq) => ({ id: `c:${Math.floor(index / 4) + 1}:${(index % 4) + 1}:${seq}`, obsSeq: 1, item: 'cobblestone', count: -1, reason: 'placed' as const, deliverySeq: index * 6 + seq })) }));
    const events = lines.flatMap(line => line.delta);
    const report: ActReport = { startedAt: Date.now(), lines, ok: true, done: 80, of: 80, command: 'skill:q70', events };
    const text = renderActReport(fake, report);
    expect(text.length).toBeLessThanOrEqual(RECEIPT_MAX);
    const json = JSON.parse(text);
    expect(json.eventsMore).toMatchObject({ command: 'skill:q70', total: 480 });
    const carried = json.lines.flatMap((line: any) => line.delta ?? []).map((event: any) => event.deliverySeq);
    expect(Math.max(...carried, -1)).toBeLessThan(json.eventsMore.nextSeq);
  });
});
