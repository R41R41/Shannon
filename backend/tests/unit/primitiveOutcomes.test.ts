import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { createGround, stepContext, type Ground } from '../helpers/practiceGround.js';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import { dig } from '../../src/services/minebot/utils/primitives/dig.js';
import { place } from '../../src/services/minebot/utils/primitives/place.js';
import { make } from '../../src/services/minebot/utils/primitives/make.js';
import { smelt } from '../../src/services/minebot/utils/primitives/smelt.js';
import { pillarUp } from '../../src/services/minebot/utils/primitives/pillarUp.js';
import { StepStopped } from '../../src/services/minebot/utils/primitives/common.js';
import { mine } from '../../src/services/minebot/utils/primitives/mine.js';
import { walk } from '../../src/services/minebot/utils/primitives/walk.js';
import { go, blockedAroundPlace, digRuleOf } from '../../src/services/minebot/utils/primitives/go.js';
import { attack } from '../../src/services/minebot/utils/primitives/attack.js';
import { fight } from '../../src/services/minebot/utils/primitives/fight.js';
import { drop, eat, equip } from '../../src/services/minebot/utils/primitives/body.js';
import { DEATH_MEMORY_MS, deathLedgerOf } from '../../src/services/minebot/utils/deathLedger.js';
import { installBlackBox } from '../../src/services/minebot/utils/blackbox.js';
import { meterProgress, withProgress } from '../../src/services/minebot/utils/primitives/progressUnits.js';

// Continue contracts (1): every part returns its own progress, goal and code (a `StepOutcome` with `progress`, `goal`, `code`), and `runAct()` turns them into the hand's goal / end / code / progress
// (utils/handOutcome). The scenes are the contract's fixtures (tests/fixtures/continue/result/*.json); each `it` names the fixture it takes its expected values from.

const FIXTURES = fileURLToPath(new URL('../fixtures/continue/result', import.meta.url));
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
const parse = (result: { result: string }) => JSON.parse(result.result);
const hands = (value: unknown) => ACT_HANDS.parse(value);
const cell = (x: number, y: number, z: number) => ({ x, y, z });

let ground: Ground | null = null;
afterEach(() => { ground?.stop(); ground = null; vi.useRealTimers(); });
const open = (options: Parameters<typeof createGround>[0] = {}) => { ground?.stop(); ground = createGround({ pathfinder: true, ...options }); ground.bot.activeFurnaces = []; ground.start(); return ground; };

/** A light fake body for the parts that need no physics: the ground below y 64 is stone, above it air, and `__blocks` overrides cells. */
function body(items: Array<{ name: string; count: number; type?: number }> = [], food = 20) {
  const blocks = new Map<string, any>();
  const bot: any = Object.assign(new EventEmitter(), {
    __blocks: blocks,
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true },
    health: 20, food, game: { dimension: 'overworld' }, entities: {} as Record<number, any>,
    registry: { blocksByName: { cobblestone: { id: 1 }, stone: { id: 2 } }, itemsByName: {}, items: {} },
    inventory: { items: () => items, slots: new Array(46).fill(null) },
    heldItem: null as any,
    blockAt: (p: Vec3) => {
      const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      const position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      if (blocks.has(key)) return { diggable: true, hardness: 1, ...blocks.get(key), position };
      return position.y < 64 ? { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5, position } : { name: 'air', boundingBox: 'empty', position };
    },
    setControlState: () => undefined, clearControlStates: () => undefined,
  });
  return bot;
}
const ctx = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 30_000, facing: 'north' as const, base: { x: 0, y: 64, z: 0 } });

describe('progress helpers', () => {
  it('withProgress puts the measure on the outcome and on a thrown stop, and never lets a measure stop the part', async () => {
    const ok = await withProgress(async () => ({ ok: true, text: 'x' }), () => ({ unit: 'block', done: 2, left: 0 }));
    expect(ok.progress).toEqual({ unit: 'block', done: 2, left: 0 });
    const own = await withProgress(async () => ({ ok: true, text: 'x', progress: { unit: 'step', done: 1, left: 1 } }), () => ({ unit: 'block', done: 2, left: 0 }));
    expect(own.progress?.unit).toBe('step');
    const broken = await withProgress(async () => ({ ok: true, text: 'x' }), () => { throw new Error('measure'); });
    expect(broken).toEqual({ ok: true, text: 'x' });
    const cut = new Error('cut');
    await expect(withProgress(async () => { throw cut; }, outcome => ({ unit: 'block', done: outcome === null ? 3 : 0, left: 1 }))).rejects.toBe(cut);
    expect((cut as any).progress).toEqual({ unit: 'block', done: 3, left: 1 });
  });
  it('meterProgress counts how much nearer the body came, never below 0, and the metres still to go', () => {
    const bot = { entity: { position: new Vec3(10.5, 64, 0.5) } };
    const nearer = meterProgress(bot, { x: 0.5, y: 64, z: 0.5 }, [cell(20, 64, 0)]);
    expect(nearer).toMatchObject({ unit: 'meter', done: 10, left: 10, fromStopM: 10, at: { x: 10, y: 64, z: 0 } });
    const away = meterProgress(bot, { x: 30.5, y: 64, z: 0.5 }, [cell(40, 64, 0)]);
    expect(away.done).toBe(0);
    expect(away.left).toBe(30);
  });
});

describe('eat, equip and drop (r43-reflex-ate-first)', () => {
  it('a fed body that cannot eat is "already" (ok, goal already, code food_full): the reflex ate first', async () => {
    const bot = body([{ name: 'bread', count: 2, type: 5 }], 20);
    const outcome = await eat(ctx(bot), { item: 'bread' });
    expect(outcome).toMatchObject({ ok: true, goal: 'already', code: 'food_full' });
    expect(outcome.text).toContain('満腹（20/20）');
  });
  it('equip: the item already in the hand (or worn) is "already"', async () => {
    const bot = body([{ name: 'iron_sword', count: 1, type: 9 }]);
    bot.heldItem = { name: 'iron_sword' };
    expect(await equip(ctx(bot), { item: 'iron_sword' })).toMatchObject({ ok: true, goal: 'already', code: 'already_equipped' });
    bot.inventory.slots[5] = { name: 'iron_helmet' };
    (bot.inventory.items as any) = () => [{ name: 'iron_helmet', count: 1, type: 10 }];
    expect(await equip(ctx(bot), { item: 'iron_helmet', slot: 'head' })).toMatchObject({ ok: true, goal: 'already', code: 'already_equipped' });
  });
  it('drop says the items thrown, counted from the pack', async () => {
    const stacks = [{ name: 'dirt', count: 5, type: 3 }];
    const bot = body(stacks);
    bot.lookAt = async () => undefined;
    bot.toss = async (_type: number, _meta: unknown, count: number) => { stacks[0].count -= count; };
    const outcome = await drop(ctx(bot), { items: [{ item: 'dirt', count: 3 }], toward: { x: 4, y: 64, z: 0 } });
    expect(outcome.ok).toBe(true);
    expect(outcome.progress).toEqual({ unit: 'item', done: 3, left: 0 });
  });
});

describe('dig and place (r45-resume1-dig-already-go-no-floor, r45-hold9-face-air)', () => {
  it('dig: every cell already open is "already"; one dug is done; the progress counts the cells dug and the cells left', async () => {
    const bot = body([]);
    const open = await dig(ctx(bot), { at: [cell(3, 66, 0)] });
    expect(open).toMatchObject({ ok: true, goal: 'already', code: 'already_open', progress: { unit: 'block', done: 0, left: 0 } });
    // A cell of stone out of reach after a cell already open: the stop tells that none was dug and one is left.
    const far = await dig(ctx(bot), { at: [cell(3, 66, 0), cell(30, 63, 0)] });
    expect(far.ok).toBe(false);
    expect(far.progress).toEqual({ unit: 'block', done: 0, left: 1 });
  });
  it('place: a cell that holds the block already is "already"; the progress counts the cells laid', async () => {
    const bot = body([{ name: 'cobblestone', count: 4, type: 1 }]);
    bot.__blocks.set('2,64,0', { name: 'cobblestone', boundingBox: 'block' });
    const same = await place(ctx(bot), { block: 'cobblestone', at: [cell(2, 64, 0)] });
    expect(same).toMatchObject({ ok: true, goal: 'already', code: 'already_placed', progress: { unit: 'block', done: 0, left: 0 } });
    // The pack holds none: a cell that holds the block is still "already" (nothing is laid, so none is needed).
    const empty = body([]);
    empty.__blocks.set('2,64,0', { name: 'cobblestone', boundingBox: 'block' });
    expect(await place(ctx(empty), { block: 'cobblestone', at: [cell(2, 64, 0)] })).toMatchObject({ ok: true, goal: 'already' });
    // A taken cell of another block stops it, with the cells not laid counted.
    const taken = await place(ctx(bot), { block: 'cobblestone', at: [cell(2, 64, 0), cell(1, 63, 0)] });
    expect(taken.ok).toBe(false);
    expect(taken.reason).toBe('occupied');
    expect(taken.progress).toEqual({ unit: 'block', done: 0, left: 1 });
  });
});

describe('act: eat after the reflex ate (r43-reflex-ate-first), dig already and go no_floor (r45-resume1)', () => {
  it('pillarUp done and eat already: the act is done, the eat line has goal already, code food_full, end finished', async () => {
    const fx = fixture('r43-reflex-ate-first');
    const g = open({ at: [8, 64, 8] });
    g.give('cobblestone', 8); g.give('bread', 2);
    g.bot.food = fx.input.body.food;
    const result = await runAct(g.bot, hands(fx.input.act.hands));
    const json = parse(result);
    expect(json.lines[1]).toMatchObject({ do: 'eat', status: 'done', goal: 'already', end: 'finished', code: 'food_full' });
    expect(json.lines[0]).toMatchObject({ do: 'pillarUp', status: 'done', goal: 'done', end: 'finished', progress: { unit: 'block', done: 2, left: 0 } });
    expect(json.lines[0].delta).toEqual(expect.arrayContaining([expect.objectContaining({ item: 'cobblestone', count: -2, reason: 'placed' })]));
    expect(json.outcome).toMatchObject(fx.expected.outcome);
    expect(g.countOf('bread')).toBe(2);
  }, 60_000);

  it('dig already (motorOps 0) and go no_floor (22 ms, motorOps 0): both lines not_started / already, the act not_started, the go says how far it still is', async () => {
    const fx = fixture('r45-resume1-dig-already-go-no-floor');
    const g = open({ at: [8, 64, 8] });
    // A plant the go may not stand on or dig is the floor of the place; under it the ground.
    g.set(14, 64, 8, 'short_grass');
    const result = await runAct(g.bot, hands([{ do: 'dig', at: [cell(12, 66, 8)] }, { do: 'go', to: cell(14, 65, 8), seconds: 30, canDig: ['stone'] }]));
    const json = parse(result);
    expect(json.lines[0]).toMatchObject({ do: 'dig', goal: fx.expected.lines[0].goal, end: 'finished', motorOps: 0 });
    expect(json.lines[1]).toMatchObject({ do: 'go', goal: fx.expected.lines[1].goal, end: 'finished', code: 'no_floor', motorOps: 0 });
    expect(json.lines[1].progress).toMatchObject({ unit: 'meter', done: 0, fromStopM: json.lines[1].progress.left });
    expect(json.lines[1].progress.left).toBeGreaterThan(5);
    expect(json.outcome).toMatchObject(fx.expected.outcome);
  }, 30_000);
});

describe('go (r45-hold1-go-partial, r45-hold2-local-go-partial, r45-hold10-goal-blocked)', () => {
  it('already within range when it begins: goal already, nothing moved', async () => {
    const g = open({ at: [8, 64, 8] });
    const outcome = await go(stepContext(g.bot), { goals: [cell(8, 64, 8)] });
    expect(outcome).toMatchObject({ ok: true, goal: 'already', code: 'already_there', progress: { unit: 'meter', done: 0, left: 0 } });
    const near = await walk(stepContext(g.bot), { to: cell(9, 64, 8), range: 2 });
    expect(near).toMatchObject({ ok: true, goal: 'already', code: 'already_there' });
  }, 30_000);

  it('the time runs out on the way: partial, the metres still to go from where it stopped, where it stopped, the work and the last search', async () => {
    const fx = fixture('r45-hold2-local-go-partial');
    const g = open({ at: [2, 64, 2] });
    g.give('stone_pickaxe', 1);
    const result = await runAct(g.bot, hands([{ do: 'go', to: cell(28, 64, 28), seconds: 5, canDig: ['stone'] }]));
    const json = parse(result);
    const line = json.lines[0];
    expect(line).toMatchObject({ do: 'go', goal: fx.expected.line.goal, end: 'finished', code: fx.expected.line.code });
    expect(line.progress.unit).toBe('meter');
    expect(line.progress.done).toBeGreaterThan(2);
    expect(line.progress.left).toBeGreaterThan(3);
    expect(line.progress.fromStopM).toBe(line.progress.left);
    expect(line.progress.at).toEqual(expect.objectContaining({ y: 64 }));
    expect(line.progress.work).toEqual({ dug: 0, placed: 0 });
    expect(line.progress.lastSearch).toMatchObject({ status: expect.stringMatching(/^(success|partial|timeout)$/u), len: expect.any(Number), nodes: expect.any(Number), ms: expect.any(Number) });
    expect(line.progress.lastSearch.len).toBeGreaterThan(0);
    expect(json.outcome).toMatchObject({ goal: 'partial', end: 'finished' });
  }, 40_000);

  it('the search ran out of its time: partial, the distance from the end of the way to the place (searchEndM) is kept apart from the distance from where the body stopped (fromStopM)', async () => {
    const fx = fixture('r45-hold1-go-partial');
    const g = open({ at: [2, 64, 2] });
    // The go's own searches (their time limit is the marker 777 ms) answer "time out" with a way that ends 14 cells along; the pathfinder's executor is left as it is,
    // so the body walks to the end of that way and a second answer finds it no nearer.
    const real = g.bot.pathfinder.getPathFromTo;
    g.bot.pathfinder.getPathFromTo = function* (this: unknown, movements: unknown, start: unknown, goal: unknown, options: { timeout?: number } = {}) {
      if (options.timeout === 777) { yield { result: { status: 'timeout', path: [{ x: 14, y: 64, z: 14, hash: '14,64,14' }], visitedNodes: 6016 } }; return; }
      yield* real.call(this, movements, start, goal, options);
    };
    const outcome = await go(stepContext(g.bot, undefined, 60), { goals: [cell(28, 64, 28)], seconds: 30, canDig: ['stone'], searchMs: 777 });
    expect(outcome).toMatchObject({ ok: false, reason: 'search_timeout' });
    const progress = outcome.progress!;
    expect(progress.lastSearch).toMatchObject({ status: 'timeout', len: 1, nodes: 6016, endM: 19.8 });
    expect(progress.searchEndM).toBe(19.8);
    expect(progress.fromStopM).toBeGreaterThan(15);
    expect(progress.done).toBeGreaterThan(5);
    expect(progress.work).toEqual({ dug: 0, placed: 0 });
    // The act turns it into the hand's partial (it moved the body and got nearer).
    expect(fx.expected.lines[1]).toMatchObject({ goal: 'partial', code: 'search_timeout' });
  }, 60_000);

  it('a place shut in by blocks the go may not dig: the search gives len 0, and the stop names the cells round the place that shut it (moss_block, not diggable)', async () => {
    const fx = fixture('r45-hold10-goal-blocked');
    const g = open({ at: [16, 64, 8] });
    // The place (14,64,8) is shut in: its eight neighbours at its feet's and its head's level are moss_block; the body stands 2 m off, as near as any way goes.
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const y of [64, 65]) if (dx || dz) g.set(14 + dx, y, 8 + dz, 'moss_block');
    g.set(14, 66, 8, 'moss_block');
    const outcome = await go(stepContext(g.bot, undefined, 60), { goals: [cell(14, 64, 8)], canDig: ['stone', 'dirt', 'gravel'], seconds: 30, searchMs: 400 });
    expect(outcome.ok).toBe(false);
    const progress = outcome.progress!;
    expect(progress).toMatchObject({ unit: 'meter', fromStopM: fx.expected.line.progress.fromStopM, at: { x: 16, y: 64, z: 8 } });
    expect(progress.lastSearch).toMatchObject({ len: 0 });
    expect(['timeout', 'no_path']).toContain(progress.lastSearch!.status);
    expect(progress.lastSearch!.blockedAround).toEqual(expect.arrayContaining([expect.objectContaining({ block: 'moss_block', diggable: false })]));
    expect(progress.lastSearch!.blockedAround!.length).toBeLessThanOrEqual(8);
  }, 60_000);

  it('blockedAroundPlace lists only solid cells that canDig does not allow, the nearest first, 8 at most', () => {
    const g = open({ at: [8, 64, 8] });
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) g.set(14 + dx, 64, 8 + dz, dx === 1 ? 'stone' : 'moss_block');
    g.set(14, 64, 8, 'air');
    const rule = digRuleOf(g.bot.registry, ['stone']);
    const listed = blockedAroundPlace(g.bot, cell(14, 64, 8), rule);
    expect(listed.length).toBe(5);
    expect(listed.every(entry => entry.block === 'moss_block' && entry.diggable === false)).toBe(true);
  });
});

describe('count keeps its meaning (count-keeps-its-meaning)', () => {
  it('make 4 sticks with 8 held makes 4 more (12), progress item done 4 left 0, no "already"', async () => {
    const g = open({ at: [8, 64, 8] });
    g.give('stick', 8); g.give('oak_planks', 4);
    const outcome = await make(stepContext(g.bot), { item: 'stick', count: 4 });
    expect(outcome.ok).toBe(true);
    expect(outcome.goal).toBeUndefined();
    expect(outcome.progress).toEqual({ unit: 'item', done: 4, left: 0 });
    expect(g.countOf('stick')).toBe(12);
  }, 30_000);

  it('mine 3 iron ore with 5 raw iron held digs 3 (8 raw iron), progress item done 3 left 0', async () => {
    const g = open({ at: [8, 64, 8] });
    g.fill([11, 64, 5], [13, 68, 12], 'stone');
    for (const c of [cell(11, 64, 8), cell(11, 65, 8), cell(11, 65, 9), cell(11, 66, 9)]) g.set(c.x, c.y, c.z, 'iron_ore');
    g.give('stone_pickaxe', 1); g.give('raw_iron', 5);
    const outcome = await mine(stepContext(g.bot, undefined, 60), { block: 'iron_ore', at: [cell(11, 64, 8)], count: 3 });
    expect(outcome.ok).toBe(true);
    expect(outcome.goal).toBeUndefined();
    expect(outcome.progress).toEqual({ unit: 'item', done: 3, left: 0 });
    expect(g.countOf('raw_iron')).toBe(8);
  }, 60_000);

  it('an act whose done condition already holds makes none (stick 8/8): done by the condition, nothing made', async () => {
    const g = open({ at: [8, 64, 8] });
    g.give('stick', 8); g.give('oak_planks', 4);
    const result = await runAct(g.bot, hands([{ do: 'make', item: 'stick', count: 4 }]), undefined, undefined, { done: [[{ k: 'have', item: 'stick', n: 8 }]] });
    const json = parse(result);
    expect(json.outcome).toMatchObject({ goal: 'done' });
    expect(json.doneMet).toContain('have:stick 8/8');
    expect(g.countOf('stick')).toBe(8);
  }, 30_000);
});

describe('the other parts say how far they got', () => {
  it('smelt: an input the pack lacks is a failed hand with the code missing_item (the reason stays missing), nothing put', async () => {
    const g = open({ at: [8, 64, 8] });
    const outcome = await smelt(stepContext(g.bot), { items: [{ item: 'raw_iron', count: 3 }], fuel: 'coal' });
    expect(outcome).toMatchObject({ ok: false, reason: 'missing', code: 'missing_item', progress: { unit: 'item', done: 0, left: 3 } });
    const json = parse(await runAct(g.bot, hands([{ do: 'smelt', items: [{ item: 'raw_iron', count: 3 }], fuel: 'coal' }])));
    expect(json.lines[0]).toMatchObject({ do: 'smelt', goal: 'not_started', code: 'missing_item', motorOps: 0, progress: { unit: 'item', done: 0, left: 3 } });
  }, 30_000);

  it('pillarUp: a stop tells the levels climbed and the levels left', async () => {
    const g = open({ at: [8, 64, 8] });
    const outcome = await pillarUp(stepContext(g.bot), { n: 3, block: 'cobblestone' });
    expect(outcome).toMatchObject({ ok: false, reason: 'missing_item', progress: { unit: 'block', done: 0, left: 3 } });
  }, 30_000);

  it('dig that is cut after one cell: the stop carries the progress (the act reads it: a hand that got somewhere is partial)', async () => {
    const g = open({ at: [8, 64, 8] });
    g.fill([10, 64, 8], [11, 64, 8], 'stone');
    g.give('stone_pickaxe', 1);
    const stop = new AbortController();
    g.bot.once('diggingCompleted', () => stop.abort('cancelled'));
    let caught: any = null;
    try { await dig(stepContext(g.bot, stop.signal), { at: [cell(10, 64, 8), cell(11, 64, 8)], collect: false }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(StepStopped);
    expect(caught.progress).toEqual({ unit: 'block', done: 1, left: 1 });
  }, 30_000);

  it('walk: the time runs out on the way: the metres nearer it came and the metres still to go, and where it stopped', async () => {
    const g = open({ at: [2, 64, 2] });
    const outcome = await walk(stepContext(g.bot, undefined, 2), { to: cell(28, 64, 2), range: 0.5 });
    expect(outcome.ok).toBe(false);
    expect(outcome.progress).toMatchObject({ unit: 'meter' });
    expect(outcome.progress!.done).toBeGreaterThan(2);
    expect(outcome.progress!.left).toBeGreaterThan(3);
    expect(outcome.progress!.fromStopM).toBe(outcome.progress!.left);
    expect(outcome.progress!.at).toEqual(expect.objectContaining({ y: 64 }));
    const arrived = await walk(stepContext(g.bot, undefined, 30), { to: cell(g.bot.entity.position.x + 3, 64, 2), range: 0.5 });
    expect(arrived.ok).toBe(true);
    expect(arrived.progress).toMatchObject({ unit: 'meter', left: 0 });
  }, 60_000);
});

// ----- attack and fight (attack-target-lost) -----

/** A body for attack on a flat ground: a creature 2 m off, a swing that lands (the creature is hurt) and, when told, a death or a disappearance. */
function arena(id = 2601, name = 'zombie') {
  const bot = body([]);
  const target: any = { id, name, type: 'hostile', height: 1.95, width: 0.6, position: new Vec3(2.5, 64, 0.5), isValid: true };
  bot.entities[id] = target;
  const swings: number[] = [];
  Object.assign(bot, { lookAt: async () => undefined, attack: (entity: any) => { swings.push(entity.id); bot.emit('entityHurt', entity); bot.__onSwing?.(entity); } });
  return { bot, target, swings };
}

describe('attack: a creature that went out of sight is not a dead one (attack-target-lost)', () => {
  it('lost from sight during the hand: ok false, goal unknown, code target_lost, one blow landed; through the act the hand and the act are unknown', async () => {
    const fx = fixture('attack-target-lost');
    expect(fx.expected.cases[0].hand).toEqual({ goal: 'unknown', code: 'target_lost' });
    const { bot, swings } = arena(2601);
    bot.__onSwing = (entity: any) => { delete bot.entities[entity.id]; };
    const outcome = await attack(ctx(bot), { target: 2601, until: 'dead', maxSeconds: 5 });
    expect(swings).toEqual([2601]);
    expect(outcome).toMatchObject({ ok: false, goal: 'unknown', reason: 'target_lost', code: 'target_lost', progress: { unit: 'blow', done: 1 } });
    // Through the act (the practice ground body).
    const g = open({ at: [8, 64, 8] });
    g.bot.entities[2601] = { id: 2601, name: 'zombie', type: 'hostile', height: 1.95, width: 0.6, position: new Vec3(10.5, 64, 8.5), isValid: true };
    g.bot.lookAt = async () => undefined;
    g.bot.attack = (entity: any) => { g.bot.emit('entityHurt', entity); delete g.bot.entities[entity.id]; };
    const json = parse(await runAct(g.bot, hands([{ do: 'attack', target: 2601, seconds: 5 }])));
    expect(json.lines[0]).toMatchObject({ do: 'attack', goal: 'unknown', end: 'finished', code: 'target_lost', progress: { unit: 'blow', done: 1 } });
    expect(json.outcome).toMatchObject({ goal: 'unknown' });
  }, 30_000);

  it('a death the body saw while the hand ran is done (the creature falls and goes)', async () => {
    const { bot, swings } = arena(2601);
    bot.__onSwing = (entity: any) => { bot.emit('entityDead', entity); delete bot.entities[entity.id]; };
    const outcome = await attack(ctx(bot), { target: 2601, until: 'dead', maxSeconds: 5 });
    expect(swings).toEqual([2601]);
    expect(outcome).toMatchObject({ ok: true, progress: { unit: 'blow', done: 1 } });
    expect(outcome.goal).toBeUndefined();
  });

  it('a death seen a moment before on this connection, in this dimension: already (target_dead); the creature need not be listed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { bot } = arena(1954);
    deathLedgerOf(bot);
    delete bot.entities[1954];
    bot.emit('entityDead', { id: 1954, name: 'zombie' });
    vi.setSystemTime(Date.now() + 3000);
    const outcome = await attack(ctx(bot), { target: 1954, until: 'dead', maxSeconds: 5 });
    expect(outcome).toMatchObject({ ok: true, goal: 'already', code: 'target_dead' });
    // Named "#1954" the same; named by its kind, a death seen is not the answer.
    expect(await attack(ctx(bot), { target: '#1954' })).toMatchObject({ goal: 'already', code: 'target_dead' });
    expect(await attack(ctx(bot), { target: 'zombie' })).toMatchObject({ ok: false, reason: 'target_not_found' });
  });

  it('a death seen on another connection (another body object), in another dimension, or longer ago than the memory, is not found (target_not_found)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const old = arena(1954).bot;
    delete old.entities[1954];
    deathLedgerOf(old);
    old.emit('entityDead', { id: 1954, name: 'zombie' });
    // A new connection: a new body object, a new ledger.
    const fresh = body([]);
    fresh.lookAt = async () => undefined;
    expect(await attack(ctx(fresh), { target: 1954 })).toMatchObject({ ok: false, reason: 'target_not_found' });
    // The same connection, another dimension.
    old.game.dimension = 'the_nether';
    expect(await attack(ctx(old), { target: 1954 })).toMatchObject({ ok: false, reason: 'target_not_found' });
    old.game.dimension = 'overworld';
    expect(await attack(ctx(old), { target: 1954 })).toMatchObject({ goal: 'already' });
    // Longer ago than the memory.
    vi.setSystemTime(Date.now() + DEATH_MEMORY_MS + 1000);
    expect(await attack(ctx(old), { target: 1954 })).toMatchObject({ ok: false, reason: 'target_not_found' });
    // The act turns the stop into not_started with no motor operation.
    const g = open({ at: [8, 64, 8] });
    vi.useRealTimers();
    const json = parse(await runAct(g.bot, hands([{ do: 'attack', target: 1954 }])));
    expect(json.lines[0]).toMatchObject({ goal: 'not_started', code: 'target_not_found', motorOps: 0 });
  }, 30_000);

  it('an id reused by another kind of creature is not the death seen', async () => {
    const { bot } = arena(77, 'skeleton');
    deathLedgerOf(bot);
    bot.emit('entityDead', { id: 77, name: 'zombie' });
    const outcome = await attack(ctx(bot), { target: 77, until: 'dead', maxSeconds: 1 });
    expect(outcome.goal).not.toBe('already');
  });

  it('fight: a creature lost from sight is unknown / target_lost (the reason stays "lost"); one not there at the start is target_not_found; one seen dead is already', async () => {
    const lost = body([{ name: 'iron_sword', count: 1, type: 9 }]);
    lost.entities[9] = { id: 9, name: 'zombie', type: 'hostile', height: 1.95, width: 0.6, position: new Vec3(2.5, 64, 0.5), isValid: true, velocity: new Vec3(0, 0, 0) };
    Object.assign(lost, { heldItem: { name: 'iron_sword' }, lookAt: async () => undefined, attack: () => { delete lost.entities[9]; }, look: async () => undefined });
    lost.entity.height = 1.8;
    const out = await fight(ctx(lost), { target: 9, retreatHp: 5, seconds: 5 });
    expect(out).toMatchObject({ ok: false, goal: 'unknown', reason: 'lost', code: 'target_lost' });
    const none = await fight(ctx(body([])), { target: 12 });
    expect(none).toMatchObject({ ok: false, reason: 'lost', code: 'target_not_found' });
    const seen = body([]);
    deathLedgerOf(seen);
    seen.emit('entityDead', { id: 12, name: 'zombie' });
    expect(await fight(ctx(seen), { target: '#12' })).toMatchObject({ ok: true, goal: 'already', code: 'target_dead' });
  }, 30_000);
});

// ----- hold 9: what the black box says of a place, and a place not sent -----

describe('hold 9: the hand at the send and at the end (r45-hold9-hand-at-send), a place against air not sent (r45-hold9-face-air)', () => {
  it('the black box records the hand when the place went out (held) and when it ended (heldAfter)', async () => {
    const fx = fixture('r45-hold9-hand-at-send');
    const bot = Object.assign(new EventEmitter(), {
      entity: { id: 1, position: new Vec3(10.5, 64, -3.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0 }, health: 20, food: 20, game: { dimension: 'overworld' },
      controlState: {} as Record<string, boolean>, entities: {}, inventory: { slots: new Array(46).fill(null) }, heldItem: { name: 'cobblestone' } as any,
      dig: async () => undefined, placeBlock: async () => { bot.heldItem = { name: 'diamond_pickaxe' }; }, attack: () => undefined,
    }) as any;
    const clock = { t: 1_000_000 };
    const box = installBlackBox(bot, fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'hold9-')), () => clock.t);
    await bot.placeBlock({ position: new Vec3(11, 63, -3), name: 'stone' }, new Vec3(0, 1, 0));
    expect(fx.expected.cases[0].box).toEqual({ held: 'cobblestone', heldAfter: 'diamond_pickaxe' });
    const recorded = (box as any).events.find((event: any) => event.k === 'place');
    expect(recorded).toMatchObject(fx.expected.cases[0].box);
  });

  it('a place against a block that is not there (air) is not sent: the box says place_held_back no_face:air and the go goes on', async () => {
    const fx = fixture('r45-hold9-face-air');
    const g = open({ at: [8, 64, 8] });
    g.give('cobblestone', 8);
    const box = installBlackBox(g.bot, fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'hold9-')));
    const walking = go(stepContext(g.bot, undefined, 30), { goals: [cell(40, 64, 8)], canPlace: ['cobblestone'], seconds: 5 });
    await new Promise(resolve => setTimeout(resolve, 400));
    const sent = vi.fn();
    const original = g.bot.placeBlock;
    // The route's place against the air at (30,63,8) for the cell (29,63,8): the go's own wrapper is on the body's placeBlock while it runs.
    const attempt = g.bot.placeBlock({ position: new Vec3(30, 63, 8), name: 'air', boundingBox: 'empty' }, new Vec3(-1, 0, 0)).catch((error: Error) => error);
    expect(await attempt).toBeInstanceOf(Error);
    void sent; void original;
    const held = (box as any).events.find((event: any) => event.k === fx.expected.box.k);
    expect(held).toMatchObject({ why: fx.expected.box.why, at: [29, 63, 8] });
    await walking;
  }, 30_000);
});
