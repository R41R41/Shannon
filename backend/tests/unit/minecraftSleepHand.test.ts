import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGround, type Ground } from '../helpers/practiceGround.js';
import { enemiesInSleepBox, enemyWords, sleep } from '../../src/services/minebot/utils/primitives/sleep.js';
import { StepStopped } from '../../src/services/minebot/utils/primitives/common.js';
import { handProblem } from '../../src/services/minebot/utils/actHandRules.js';
import { closedWord } from '../../src/services/minebot/utils/actReport.js';
import { leaveBed } from '../../src/services/minebot/utils/bedRules.js';
import { ACT_HANDS, HAND_KINDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import { actionLeaseStatus, cancelActiveActions, createMotorPort, currentAction, executeAction, nativeActionHost, recentMotorOps }
  from '../../src/services/minebot/execution/ActionExecution.js';
import { installLife } from '../../src/services/minebot/utils/life.js';

const { default: SleepInBed } = await import('../../src/services/minebot/instantSkills/sleepInBed.js');

const lifeRoots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of lifeRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

// 2026-11-05, the owner's rule of 10/21: when and where she sleeps is the head's. Runs 60 and 61 carried a bed through a night of work and
// died to its zombies without lying down; the body does not sleep by itself (no floor reflex), the head asks for the act's `sleep` hand:
// set the bed down, sleep, take it back on waking. An enemy in the game's box comes back as facts, and no spot is ever dug.

const NIGHT = 13000;
const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));

function body(patch: Record<string, unknown> = {}) {
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, name: 'player', position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, onGround: true },
    health: 20, food: 20, game: { dimension: 'minecraft:overworld' }, time: { timeOfDay: NIGHT, day: 3 }, entities: {} as Record<string, any>,
    inventory: { items: () => [{ name: 'white_bed', count: 1 }] as any[], slots: new Array(46).fill(null) },
    isSleeping: false, executingSkill: false, interruptExecution: false, controlState: {},
    clearControlStates: vi.fn(), setControlState: vi.fn(), look: vi.fn(async () => {}),
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }), isABed: (block: any) => block?.name?.endsWith('_bed'), findBlock: () => null,
    wake: vi.fn(async () => { bot.isSleeping = false; bot.emit('wake'); }),
    ...patch,
  });
  return bot;
}
const ctxOf = (bot: any, signal: AbortSignal = new AbortController().signal) =>
  ({ bot, stop: signal, deadline: Date.now() + 60_000, facing: 'north' as const, base: { x: 0, y: 64, z: 0 } });
const skilled = (bot: any, runImpl: (...args: unknown[]) => Promise<unknown>) => {
  const skill: any = { bot: 'host', runImpl: vi.fn(runImpl) };
  bot.instantSkills = { getSkill: (name: string) => name === 'sleep-in-bed' ? skill : undefined };
  return skill;
};
const zombie = (id: number, x: number, y = 64, z = 0.5) => ({ id, name: 'zombie', type: 'hostile', position: new Vec3(x, y, z) });

describe('sleep: the facts before it lies down', () => {
  it('an enemy in the game\'s box (8 across, 5 up or down): enemy_near, with the kinds, the counts and the nearest, and nothing is tried', async () => {
    const bot = body();
    bot.entities = { 2: zombie(2, 5.6), 3: zombie(3, -6.5), 4: { id: 4, name: 'skeleton', type: 'hostile', position: new Vec3(0.5, 68.5, 3.5) },
      5: zombie(5, 9.5), 6: { id: 6, name: 'cow', type: 'animal', position: new Vec3(2.5, 64, 0.5) } };
    const skill = skilled(bot, async () => ({ success: true, nightPassed: true }));
    const out = await sleep(ctxOf(bot), {});
    expect(out).toMatchObject({ ok: false, reason: 'enemy_near', at: { x: 5, y: 64, z: 0 } });
    expect(out.text).toBe('sleep 止まった enemy_near: 8m 内（上下5）に zombie 2体・skeleton 1体（最も近い zombie 5.1m）。なのでこの場所では寝られない');
    expect(skill.runImpl).not.toHaveBeenCalled();
    expect(closedWord(out.reason)).toBe('敵が近い');
    expect(enemiesInSleepBox(bot).map(enemy => enemy.name)).toEqual(['zombie', 'skeleton', 'zombie']);
    expect(enemyWords([{ name: 'creeper', distance: 3 }])).toContain('creeper 1体');
  });
  it('by day: not_night with the seconds until night; in a thunderstorm it may sleep by day', async () => {
    const day = await sleep(ctxOf(body({ time: { timeOfDay: 6000 } })), {});
    expect(day).toMatchObject({ ok: false, reason: 'not_night' });
    expect(day.text).toContain('夜まであと約 327 秒');
    expect(closedWord(day.reason)).toBe('夜ではない');
    // end1109o09: far from the night the line says the day is the plan's; within a minute of it, only the seconds.
    expect(day.text).toContain('それまでは計画の手を進める');
    expect(day.text).toContain('30 分の目標の約 18%');
    const near = await sleep(ctxOf(body({ time: { timeOfDay: 12_000 } })), {});
    expect(near.text).toContain('夜まであと約 27 秒');
    expect(near.text).not.toContain('計画の手を進める');
    const storm = body({ time: { timeOfDay: 6000 }, isRaining: true, thunderState: 1 });
    skilled(storm, async () => ({ success: true, nightPassed: true, bedLeft: false }));
    expect((await sleep(ctxOf(storm), {})).ok).toBe(true);
  });
  it('the Nether and the End: bed_explodes; no bed carried and none standing near: no_bed', async () => {
    for (const dimension of ['minecraft:the_nether', 'minecraft:the_end']) {
      expect(await sleep(ctxOf(body({ game: { dimension } })), {})).toMatchObject({ ok: false, reason: 'bed_explodes' });
    }
    const none = await sleep(ctxOf(body({ inventory: { items: () => [{ name: 'bread', count: 3 }] } })), {});
    expect(none).toMatchObject({ ok: false, reason: 'no_bed' });
    expect(none.text).toContain('ベッドを持っていない');
    const named = await sleep(ctxOf(body()), { item: 'red_bed' });
    expect(named).toMatchObject({ ok: false, reason: 'no_bed' });
  });
});

describe('sleep: sleep-in-bed run as a skill calls another, never digging a spot', () => {
  it('the night passes: ok, the bed was taken back; the skill was told leaveIfNight and noDig, and its bot put back', async () => {
    const bot = body();
    const skill = skilled(bot, async () => ({ success: true, nightPassed: true, bedLeft: false, result: 'ベッドを設置して眠り、朝になりました' }));
    const out = await sleep(ctxOf(bot), {});
    expect(out.ok).toBe(true);
    expect(out.text).toMatch(/^white_bedで寝て朝にした（今 \d+）。ベッドは拾い直した$/u);
    expect(skill.runImpl).toHaveBeenCalledWith(false, false, { leaveIfNight: true, noDig: true });
    expect(skill.bot).toBe('host');
  });
  it('the night goes on (someone awake): night_went_on, and the body got up', async () => {
    const bot = body();
    skilled(bot, async () => ({ success: true, nightPassed: false, bedLeft: false, result: '' }));
    const out = await sleep(ctxOf(bot), {});
    expect(out).toMatchObject({ ok: false, reason: 'night_went_on' });
    expect(out.text).toContain('起き上がった'); expect(out.text).toContain('ベッドは拾い直した');
    expect(closedWord(out.reason)).toBe('夜が明けない');
  });
  it('no 2x1 floor near and none to walk to: no_bed_spot, said as a fact (no digging); a body still in bed is woken', async () => {
    const bot = body();
    skilled(bot, async () => { bot.isSleeping = true; return { success: false, failureType: 'no_bed_spot', result: 'ベッドを置ける2×1の床が無い（掘って作ることはしない）' }; });
    const out = await sleep(ctxOf(bot), {});
    expect(out).toMatchObject({ ok: false, reason: 'no_bed_spot' });
    expect(out.text).toContain('掘って作ることはしない');
    expect(bot.wake).toHaveBeenCalled(); expect(bot.isSleeping).toBe(false);
  });
  it('an enemy that came while it set the bed down (the skill\'s own check): enemy_near with the box read again', async () => {
    const bot = body();
    skilled(bot, async () => { bot.entities = { 2: zombie(2, 3.5) }; return { success: false, failureType: 'hostile_near', result: '近くに敵がいるため寝られません' }; });
    const out = await sleep(ctxOf(bot), {});
    expect(out).toMatchObject({ ok: false, reason: 'enemy_near', at: { x: 3, y: 64, z: 0 } });
    expect(out.text).toContain('zombie 1体（最も近い zombie 3.0m）');
  });
  it('a stop from outside (stopIf, a reflex) wakes the body at once and the hand is stopped', async () => {
    const bot = body();
    skilled(bot, () => { bot.isSleeping = true; return new Promise(resolve => bot.once('wake', () => resolve({ success: true, nightPassed: false, result: '' }))); });
    const stop = new AbortController();
    const running = sleep(ctxOf(bot, stop.signal), {});
    await settle(5);
    expect(bot.isSleeping).toBe(true);
    stop.abort('hostileWithin');
    await expect(running).rejects.toBeInstanceOf(StepStopped);
    expect(bot.wake).toHaveBeenCalled(); expect(bot.isSleeping).toBe(false);
  });
});

describe('sleep-in-bed with noDig: no spot is cut out of the rock', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('with no 2x1 floor round it and none to walk to, it says no_bed_spot and digs nothing', async () => {
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 }, entities: {}, time: { timeOfDay: NIGHT }, game: { dimension: 'minecraft:overworld' },
      isSleeping: false, isABed: (block: any) => block?.name?.endsWith('_bed'), inventory: { items: () => [{ name: 'red_bed', count: 1 }] },
      // A one-block hole in stone: no 2x1 floor with air above anywhere.
      blockAt: (pos: Vec3) => { const p = pos.floored(); const open = p.x === 0 && p.z === 0 && (p.y === 64 || p.y === 65);
        return { name: open ? 'air' : 'stone', boundingBox: open ? 'empty' : 'block', position: p }; },
      findBlock: vi.fn(() => null), findBlocks: vi.fn(() => []), equip: vi.fn(async () => {}), lookAt: vi.fn(async () => {}), pathfinder: { stop: () => {} },
      placeBlock: vi.fn(async () => {}), sleep: vi.fn(async () => {}), wake: vi.fn(async () => {}),
    });
    const skill: any = new SleepInBed(bot);
    skill.callSkill = vi.fn(async () => ({ success: true, result: '' }));
    const result = await skill.runImpl(false, false, { leaveIfNight: true, noDig: true });
    expect(result).toMatchObject({ success: false, failureType: 'no_bed_spot' });
    expect(skill.callSkill.mock.calls.filter(([name]: [string]) => /dig/u.test(name))).toEqual([]);
    expect(bot.placeBlock).not.toHaveBeenCalled();
    expect(result.result).toContain('掘って作れる安全な所も周りに無い');
  });
  it('end1109o09: in a one-wide passage with a pickaxe, it still digs nothing but says the hands that would make the spot', async () => {
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 }, entities: {}, time: { timeOfDay: NIGHT }, game: { dimension: 'minecraft:overworld' },
      isSleeping: false, isABed: (block: any) => block?.name?.endsWith('_bed'),
      inventory: { items: () => [{ name: 'red_bed', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'cobblestone', count: 12 }] },
      blockAt: (pos: Vec3) => { const p = pos.floored(); const open = p.x === 0 && p.z === 0 && (p.y === 64 || p.y === 65);
        return { name: open ? 'air' : 'stone', boundingBox: open ? 'empty' : 'block', position: p }; },
      findBlock: vi.fn(() => null), findBlocks: vi.fn(() => []), equip: vi.fn(async () => {}), lookAt: vi.fn(async () => {}), pathfinder: { stop: () => {} },
      placeBlock: vi.fn(async () => {}), sleep: vi.fn(async () => {}), wake: vi.fn(async () => {}),
    });
    const skill: any = new SleepInBed(bot);
    skill.callSkill = vi.fn(async () => ({ success: true, result: '' }));
    const result = await skill.runImpl(false, false, { leaveIfNight: true, noDig: true });
    expect(result).toMatchObject({ success: false, failureType: 'no_bed_spot' });
    expect(skill.callSkill.mock.calls.filter(([name]: [string]) => /dig/u.test(name))).toEqual([]);
    expect(result.result).toContain('掘れば作れる: 手 「dig ');
    expect(result.result).toMatch(/の後に「sleep」/u);
    expect(result.result).toContain('夜を穴で待つより速い');
  });
});

describe('leaveBed: getting out of bed on the server\'s version', () => {
  const named = { protocol: { play: { toServer: { types: { packet_entity_action: ['container', [{ name: 'actionId', type: ['mapper', { type: 'varint', mappings: { 0: 'leave_bed', 2: 'stop_sprinting' } }] }]] } } } } };
  const plain = { protocol: { play: { toServer: { types: { packet_entity_action: ['container', [{ name: 'actionId', type: 'varint' }]] } } } } };
  it('1.21.6 and later: the command is sent by name (the library\'s 2 is stop_sprinting there), not through wake()', async () => {
    const bot = { isSleeping: true, entity: { id: 7 }, registry: named, _client: { write: vi.fn() }, wake: vi.fn(async () => {}) };
    await leaveBed(bot);
    expect(bot._client.write).toHaveBeenCalledWith('entity_action', { entityId: 7, actionId: 'leave_bed', jumpBoost: 0 });
    expect(bot.wake).not.toHaveBeenCalled();
  });
  it('earlier versions use the library\'s wake(); a body not in bed sends nothing', async () => {
    const old = { isSleeping: true, entity: { id: 7 }, registry: plain, _client: { write: vi.fn() }, wake: vi.fn(async () => {}) };
    await leaveBed(old);
    expect(old.wake).toHaveBeenCalled(); expect(old._client.write).not.toHaveBeenCalled();
    const up = { isSleeping: false, entity: { id: 7 }, registry: named, _client: { write: vi.fn() }, wake: vi.fn(async () => {}) };
    await leaveBed(up);
    expect(up._client.write).not.toHaveBeenCalled(); expect(up.wake).not.toHaveBeenCalled();
  });
});

describe('the act\'s sleep hand', () => {
  let ground: Ground | null = null;
  afterEach(() => { ground?.stop(); ground = null; });
  it('is a hand of the act with its own fields and ranges', () => {
    expect(HAND_KINDS).toContain('sleep');
    expect(handProblem({ do: 'sleep' })).toBeNull();
    expect(handProblem({ do: 'sleep', item: 'red_bed', seconds: 30 })).toBeNull();
    expect(handProblem({ do: 'sleep', seconds: 5 })).toBe('seconds は 10〜60');
    expect(handProblem({ do: 'sleep', item: 'bread' })).toContain('ベッドの id');
    expect(handProblem({ do: 'sleep', at: [{ x: 0, y: 64, z: 0 }] })).toContain('at は使えない');
  });
  it('through the act on the practice ground: the line is the contract\'s own, enemies first, then a night slept', async () => {
    ground = createGround({}); ground.start();
    const bot: any = ground.bot;
    bot.time = { timeOfDay: NIGHT, day: 3 }; bot.isABed = (block: any) => block?.name?.endsWith('_bed'); bot.wake = vi.fn(async () => { bot.isSleeping = false; });
    ground.give('white_bed', 1);
    const at = bot.entity.position;
    bot.entities[90] = { id: 90, name: 'zombie', type: 'hostile', position: new Vec3(at.x + 4, at.y, at.z), metadata: [] };
    const skill = skilled(bot, async () => ({ success: true, nightPassed: true, bedLeft: false, result: '' }));
    const parse = (result: { result: string }) => JSON.parse(result.result);
    const near = parse(await runAct(bot, ACT_HANDS.parse([{ do: 'sleep' }])));
    expect(near.ok).toBe(false);
    expect(near.lines[0].line).toMatch(/^敵が近い: sleep 止まった enemy_near: 8m 内（上下5）に zombie 1体/u);
    expect(skill.runImpl).not.toHaveBeenCalled();
    delete bot.entities[90];
    const slept = parse(await runAct(bot, ACT_HANDS.parse([{ do: 'sleep', item: 'white_bed' }])));
    expect(slept.ok).toBe(true);
    expect(slept.lines[0].line).toContain('white_bedで寝て朝にした');
    expect(skill.runImpl).toHaveBeenCalledWith(false, false, { leaveIfNight: true, noDig: true });
  }, 30_000);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const namedBedCommands = { protocol: { play: { toServer: { types: { packet_entity_action: ['container',
  [{ name: 'actionId', type: ['mapper', { type: 'varint', mappings: { 0: 'leave_bed', 2: 'stop_sprinting' } }] }]] } } } } };

describe('sleep ownership through the real action lease and life keeper', () => {
  it('runs the sleep skill as a child when its caller already supplied a guarded parent view of the same native host', async () => {
    const bot = body({ registry: namedBedCommands });
    bot._client = { write: vi.fn() };
    skilled(bot, async () => { bot.time.timeOfDay = 1000; return { success: true, nightPassed: true, bedLeft: false }; });
    let outcome: unknown;
    const result = await executeAction(bot, 'act', 1000, async () => {
      const parent = createMotorPort(bot, () => true);
      const out = await sleep(ctxOf(parent), {}); outcome = out;
      return { success: out.ok, result: out.text };
    });
    expect(result, result.result).toMatchObject({ success: true }); expect(outcome).toMatchObject({ ok: true });
    expect(bot.instantSkills.getSkill('sleep-in-bed').bot).toBe('host');
    expect(actionLeaseStatus(bot)?.activeLocks).toHaveLength(0);
  });
  it('fences the final packet of a native sleep that already started before a life change during its await', async () => {
    const bot = body({ registry: namedBedCommands });
    const entered = deferred(), proceed = deferred(), nativeFinished = deferred();
    bot._client = { write: vi.fn() }; bot.nativeWrite = bot._client.write;
    bot.sleep = vi.fn(async () => {
      entered.resolve(); await proceed.promise;
      try { bot._client.write('block_place', { location: new Vec3(0, 64, 0), direction: 1, hand: 0 }); }
      finally { nativeFinished.resolve(); }
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-native-life-')); lifeRoots.push(root);
    const keeper = installLife(bot, { file: path.join(root, 'life.json'), key: () => 'sleep-fixture' });
    const skill = skilled(bot, async () => { await skill.bot.sleep({ name: 'white_bed' }); return { success: true }; });
    const running = sleep(ctxOf(bot), {}); await entered.promise;
    bot.health = 0; bot.emit('death'); bot.health = 20; bot.emit('respawn'); bot.emit('spawn');
    await running;
    proceed.resolve(); await nativeFinished.promise;
    expect(bot.nativeWrite).not.toHaveBeenCalled();
    keeper.dispose();
  });
  it('does not start a delayed sleep or wake a new life that reused the same Entity', async () => {
    const bot = body({ registry: namedBedCommands });
    bot.sleep = vi.fn(async () => { bot.isSleeping = true; });
    bot._client = { write: vi.fn(() => { bot.isSleeping = false; bot.emit('wake'); }) }; bot.nativeWrite = bot._client.write;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-life-')); lifeRoots.push(root);
    const keeper = installLife(bot, { file: path.join(root, 'life.json'), key: () => 'sleep-fixture' });
    const initial = keeper.view(), entity = bot.entity, began = deferred(), proceed = deferred();
    const skill = skilled(bot, async () => {
      const port = skill.bot; began.resolve(); await proceed.promise;
      await port.sleep({ name: 'white_bed' });
      return { success: true, nightPassed: false };
    });
    const running = sleep(ctxOf(bot), {}); await began.promise;
    bot.health = 0; bot.emit('death'); bot.health = 20; bot.emit('respawn'); bot.emit('spawn');
    expect(bot.entity).toBe(entity); expect(keeper.view().life).toBe(initial.life + 1);
    bot.isSleeping = true; // A different life has already lain down; the old callback must do nothing to it.
    proceed.resolve(); await running;
    expect(bot.sleep).not.toHaveBeenCalled();
    expect(bot.nativeWrite).not.toHaveBeenCalled();
    expect(bot.isSleeping).toBe(true);
    keeper.dispose();
  });

  it('cannot send a late leave_bed from an old owner after its reclaimed lease passed to a new sleeper', async () => {
    vi.useFakeTimers();
    const bot = body({ registry: namedBedCommands });
    bot._client = { write: vi.fn(() => { bot.isSleeping = false; bot.emit('wake'); }) }; bot.nativeWrite = bot._client.write;
    const began = deferred(), proceed = deferred(), oldFinished = deferred();
    const skill = skilled(bot, async () => {
      const oldPort = skill.bot; began.resolve(); await proceed.promise;
      try { await leaveBed(oldPort); return { success: true, nightPassed: false }; }
      finally { oldFinished.resolve(); }
    });
    const old = sleep(ctxOf(bot), {}); await began.promise;
    cancelActiveActions(bot, 'fixture cancellation'); await old;
    // The existing action core reclaims an unwinding physical lease after 15 seconds.
    await vi.advanceTimersByTimeAsync(16_000);
    const newerBegan = deferred(), newerDone = deferred();
    const newer = executeAction(bot, 'sleep-in-bed', 60_000, async () => {
      bot.isSleeping = true; newerBegan.resolve(); await newerDone.promise;
      bot.isSleeping = false; return { success: true, result: 'new owner finished' };
    });
    await newerBegan.promise;
    proceed.resolve(); await oldFinished.promise;
    expect(bot.nativeWrite).not.toHaveBeenCalled();
    expect(bot.isSleeping).toBe(true);
    newerDone.resolve(); await newer;
  });
});

describe('optional sleep guard on the registered native motor port', () => {
  function motor() {
    const bot = body({ registry: namedBedCommands });
    bot.sleep = vi.fn(async () => { bot.isSleeping = true; });
    bot._client = { write: vi.fn(() => { bot.isSleeping = false; }) }; bot.nativeWrite = bot._client.write;
    return bot;
  }
  it('leaves absent-guard behavior unchanged, including the legacy client view', async () => {
    const bot = motor(), port = createMotorPort(bot);
    expect(nativeActionHost(port)).toBe(bot); expect(port._client).toBe(bot._client);
    await port.sleep({ name: 'white_bed' }); await port.wake();
    expect(bot.sleep).toHaveBeenCalledOnce(); expect(bot.wake).toHaveBeenCalledOnce();
  });
  it.each(['sleep', 'wake', 'leave_bed'] as const)('blocks %s before its native method when the guard is false or throws', async operation => {
    for (const refusal of ['false', 'throw'] as const) {
      const bot = motor();
      const guard = vi.fn(() => { if (refusal === 'throw') throw new Error('fixture guard failure'); return false; });
      const result = await executeAction(bot, 'act', 1000, async () => {
        const port = createMotorPort(bot, guard);
        if (operation === 'leave_bed') port._client.write('entity_action', { entityId: 1, actionId: 'leave_bed', jumpBoost: 0 });
        else await port[operation]({ name: 'white_bed' });
        return { success: true, result: 'should not reach native method' };
      });
      expect(result.success).toBe(false); expect(guard).toHaveBeenCalledWith(operation);
      expect(bot.sleep).not.toHaveBeenCalled(); expect(bot.wake).not.toHaveBeenCalled(); expect(bot.nativeWrite).not.toHaveBeenCalled();
    }
  });
  it('keeps native identity and the parent lease in nested skills, records sleep, and fences the settled child', async () => {
    const bot = motor(); let childPort: any;
    const result = await executeAction(bot, 'act', 1000, async () => {
      const parent = currentAction(bot), port = createMotorPort(bot, () => true);
      expect(nativeActionHost(port)).toBe(bot);
      const child = await executeAction(port, 'sleep-in-bed', 1000, async () => {
        expect(currentAction(port)?.root).toBe(parent);
        childPort = createMotorPort(port, () => true);
        expect(nativeActionHost(childPort)).toBe(bot);
        await childPort.sleep({ name: 'white_bed' }); await leaveBed(childPort);
        return { success: true, result: 'child finished' };
      });
      expect(child.success).toBe(true);
      expect(() => childPort.sleep({ name: 'white_bed' })).toThrow('owner expired');
      expect(() => childPort.wake()).toThrow('owner expired');
      expect(() => childPort._client.write('entity_action', { entityId: 1, actionId: 'leave_bed' })).toThrow('owner expired');
      return { success: true, result: 'parent finished' };
    });
    expect(result.success).toBe(true); expect(bot.sleep).toHaveBeenCalledOnce(); expect(bot.nativeWrite).toHaveBeenCalledOnce();
    expect(recentMotorOps(bot).some(op => op.op === 'sleep' && op.capability === 'act')).toBe(true);
    expect(actionLeaseStatus(bot)?.activeLocks).toHaveLength(0);
  });
  it('does not give the sleep-specific client view permission for other raw packets', async () => {
    const bot = motor(), guard = vi.fn(() => true);
    const result = await executeAction(bot, 'act', 1000, async () => {
      createMotorPort(bot, guard)._client.write('position', { x: 0, y: 64, z: 0 });
      return { success: true, result: 'must not send' };
    });
    expect(result.success).toBe(false); expect(guard).not.toHaveBeenCalled(); expect(bot.nativeWrite).not.toHaveBeenCalled();
  });
  it('keeps another owner\'s native writer receiver, arguments and return value after a sleep guard was installed', async () => {
    const bot = motor(), value = { opaque: true }, calls: unknown[][] = [];
    const client = { write(this: unknown, ...args: unknown[]) { expect(this).toBe(client); calls.push(args); return value; } };
    bot._client = client;
    await executeAction(bot, 'act', 1000, async () => {
      createMotorPort(bot, () => false); return { success: true, result: 'guard installed for only this owner' };
    });
    await executeAction(bot, 'act', 1000, async () => {
      const reply = bot._client.write('block_place', { location: new Vec3(1, 64, 0) }, 'opaque trailing argument');
      expect(reply).toBe(value); return { success: true, result: 'other owner unchanged' };
    });
    expect(calls).toEqual([['block_place', { location: new Vec3(1, 64, 0) }, 'opaque trailing argument']]);
  });
});
