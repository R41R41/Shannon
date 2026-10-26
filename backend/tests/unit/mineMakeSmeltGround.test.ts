import { afterEach, describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { createGround, stepContext, type Ground } from '../helpers/practiceGround.js';
import { mine } from '../../src/services/minebot/utils/primitives/mine.js';
import { make } from '../../src/services/minebot/utils/primitives/make.js';
import { smelt } from '../../src/services/minebot/utils/primitives/smelt.js';
import { furnace } from '../../src/services/minebot/utils/primitives/furnace.js';
import { StepStopped } from '../../src/services/minebot/utils/primitives/common.js';
import { BodyEventWatcher } from '../../src/services/minebot/integration/commonFca/bodyEvents.js';
import { dueFurnaces } from '../../src/services/minebot/utils/furnaceDone.js';
import { runAct, ACT_HANDS } from '../../src/services/minebot/instantSkills/act.js';

// The practice ground for mine, make and smelt (hands-contract.md 3, 4, 6): real chunks and blocks (prismarine-chunk / -world, the game's dig
// times and harvest tables), the client's physics for the body (50 ms ticks), mineflayer-pathfinder's real route search for the walks, the real
// recipes. The server's side (a dig's packet and what drops, the crafting grid's clicks, the furnace window) is stood in for by
// tests/helpers/practiceGround.ts: what a real server does with a window click is not tested here. No API, no server.

let ground: Ground | null = null;
afterEach(() => { ground?.stop(); ground = null; });
const open = (options: Parameters<typeof createGround>[0] = {}) => { ground?.stop(); ground = createGround({ pathfinder: true, ...options }); ground.bot.activeFurnaces = []; ground.start(); return ground; };
const cell = (x: number, y: number, z: number) => ({ x, y, z });

/** A wall of stone in front of the body (x 11..13), with an iron vein on its face: A B C D F on x=11, and E behind the face, touching D by a corner only (a pocket in front of it shows it). */
function veinScene(g: Ground) {
  g.fill([11, 64, 5], [13, 68, 12], 'stone');
  const vein = [cell(11, 64, 8), cell(11, 65, 8), cell(11, 65, 9), cell(11, 66, 9), cell(11, 64, 9), cell(12, 65, 10)];
  for (const c of vein) g.set(c.x, c.y, c.z, 'iron_ore');
  g.set(11, 65, 10, 'air');                       // the pocket that shows E
  g.set(11, 66, 8, 'deepslate_iron_ore');          // another kind of iron ore, touching B and D
  g.set(11, 64, 7, 'coal_ore');                    // another ore, touching A
  g.set(11, 64, 12, 'iron_ore');                   // the same kind, two cells from the vein: not joined
  return { vein, decoys: [cell(11, 66, 8), cell(11, 64, 7), cell(11, 64, 12)] };
}
const goneOf = (g: Ground, cells: Array<{ x: number; y: number; z: number }>) => cells.filter(c => g.nameAt(c.x, c.y, c.z) === 'air');

describe('mine on the practice ground', () => {
  it('1. six joined iron ores in a wall: count 4 digs four of that vein with the stone pickaxe (not the wooden one), picks the drops, touches no other block', async () => {
    const g = open();
    const { vein, decoys } = veinScene(g);
    g.give('wooden_pickaxe', 1); g.give('stone_pickaxe', 1);
    const outcome = await mine(stepContext(g.bot), { block: 'iron_ore', at: [cell(11, 64, 8)], count: 4 });
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/^mine 済 iron_ore 4 個（raw_iron×4 を得た）・たどった \d+ マス/u);
    expect(goneOf(g, vein)).toHaveLength(4);
    expect(g.countOf('raw_iron')).toBe(4);
    expect(g.dugLog).toHaveLength(4);
    expect(g.dugLog.every(dug => dug.name === 'iron_ore' && dug.tool === 'stone_pickaxe' && dug.harvested)).toBe(true);
    for (const c of decoys) expect(g.nameAt(c.x, c.y, c.z)).not.toBe('air');
    expect(g.dropped()).toHaveLength(0);
    // The other two of the vein are still there, and the stone round them.
    expect(vein.filter(c => g.nameAt(c.x, c.y, c.z) === 'iron_ore')).toHaveLength(2);
    expect(g.nameAt(12, 64, 8)).toBe('stone');
  }, 60_000);

  it('2. the vein ends before the count: all six, the corner-only one too, done with 済 and "つながりが尽きた"; the other kinds and the cell two away are left', async () => {
    const g = open();
    const { vein, decoys } = veinScene(g);
    g.give('stone_pickaxe', 1);
    const outcome = await mine(stepContext(g.bot, undefined, 100), { block: 'iron_ore', at: [cell(11, 65, 8)], count: 8, seconds: 90 });
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('mine 済 iron_ore 6 個（raw_iron×6 を得た）');
    expect(outcome.text).toContain('つながりが尽きた（ほしい 8 個に足りない）');
    expect(goneOf(g, vein)).toHaveLength(6);
    expect(g.countOf('raw_iron')).toBe(6);
    for (const c of decoys) expect(g.nameAt(c.x, c.y, c.z)).not.toBe('air');
    expect(g.dugLog).toHaveLength(6);
  }, 100_000);

  it('3a. no tool that makes iron ore drop: stops with no_tool and digs nothing', async () => {
    const g = open();
    veinScene(g);
    g.give('wooden_pickaxe', 1);
    const outcome = await mine(stepContext(g.bot), { block: 'iron_ore', at: [cell(11, 64, 8)], count: 2 });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('no_tool');
    expect(outcome.text).toContain('mine 止まった no_tool');
    expect(outcome.text).toContain('stone_pickaxe');
    expect(g.dugLog).toHaveLength(0);
    // A tool asked for by name that is not carried, and one that is carried but does not make it drop.
    expect((await mine(stepContext(g.bot), { block: 'iron_ore', at: [cell(11, 64, 8)], tool: 'iron_pickaxe' })).reason).toBe('no_tool');
    const wooden = await mine(stepContext(g.bot), { block: 'iron_ore', at: [cell(11, 64, 8)], tool: 'wooden_pickaxe' });
    expect(wooden.reason).toBe('no_tool');
    expect(wooden.text).toContain('何も落ちない');
    expect(g.dugLog).toHaveLength(0);
  }, 20_000);

  it('3d. the tool breaks on the way and no other makes the ore drop: tool_broke (not no_tool), what was dug is told; a full pack with no room for the drop stops before any dig with full', async () => {
    const g = open();
    veinScene(g);
    g.give('stone_pickaxe', 1);
    const pickaxe = g.slots.find(slot => slot?.name === 'stone_pickaxe');
    pickaxe.durabilityUsed = pickaxe.maxDurability - 1;
    const broke = await mine(stepContext(g.bot), { block: 'iron_ore', at: [cell(11, 64, 8)], count: 4 });
    expect(broke.ok).toBe(false);
    expect(broke.reason).toBe('tool_broke');
    expect(broke.text).toContain('mine 止まった tool_broke');
    expect(broke.text).toContain('iron_ore を掘れたのは 1 個');
    expect(g.dugLog).toHaveLength(1);
    expect(g.countOf('stone_pickaxe')).toBe(0);
    const packed = open();
    veinScene(packed);
    packed.give('stone_pickaxe', 1);
    for (let n = 0; n < 40; n++) if (packed.give('cobblestone', 64) === 0) break;
    const full = await mine(stepContext(packed.bot), { block: 'iron_ore', at: [cell(11, 64, 8)], count: 2 });
    expect(full.ok).toBe(false);
    expect(full.reason).toBe('full');
    expect(packed.dugLog).toHaveLength(0);
  }, 30_000);

  it('3b. an at cell that is another kind of block: no_block, with what each cell holds; the block name is checked too', async () => {
    const g = open();
    veinScene(g);
    g.give('stone_pickaxe', 1);
    const outcome = await mine(stepContext(g.bot), { block: 'iron_ore', at: [cell(11, 64, 7), cell(11, 66, 8)], count: 2 });
    expect(outcome.reason).toBe('no_block');
    expect(outcome.text).toContain('mine 止まった no_block');
    expect(outcome.text).toContain('coal_ore');
    expect(outcome.text).toContain('deepslate_iron_ore');
    expect((await mine(stepContext(g.bot), { block: 'iron_oar', at: [cell(11, 64, 8)] })).reason).toBe('no_block');
    expect(g.dugLog).toHaveLength(0);
  }, 20_000);

  it('3c. a cell with lava beside it is never dug: the one beside the lava is left, the others are taken; a vein that is only that cell is a danger', async () => {
    const g = open();
    g.fill([11, 64, 5], [13, 68, 12], 'stone');
    g.set(11, 64, 8, 'iron_ore'); g.set(11, 65, 8, 'iron_ore');
    g.set(10, 64, 8, 'lava');                       // beside A, in front of it, on the floor level of the body's side
    g.give('stone_pickaxe', 1);
    const some = await mine(stepContext(g.bot), { block: 'iron_ore', at: [cell(11, 64, 8)], count: 2 });
    expect(some.ok).toBe(true);
    expect(some.text).toContain('mine 済 iron_ore 1 個');
    expect(some.text).toContain('掘らなかった: (11,64,8) は隣の (10,64,8) が lava');
    expect(g.nameAt(11, 64, 8)).toBe('iron_ore');
    expect(g.nameAt(11, 65, 8)).toBe('air');
    // Only the cell beside the lava is left of the vein.
    const only = await mine(stepContext(g.bot), { block: 'iron_ore', at: [cell(11, 64, 8)], count: 1 });
    expect(only.ok).toBe(false);
    expect(only.reason).toBe('danger');
    expect(g.nameAt(11, 64, 8)).toBe('iron_ore');
    expect(g.nameAt(10, 64, 8)).toBe('lava');
  }, 60_000);

  it('4. a cell behind stone: without canDig it is not reached (nothing dug); with canDig:["stone"] the way is dug within maxDig, and over maxDig it stops with limit_dig', async () => {
    const build = () => {
      const g = open();
      g.fill([11, 64, 5], [17, 68, 12], 'stone');
      g.set(15, 64, 8, 'iron_ore');                 // inside the stone, no face open
      g.give('stone_pickaxe', 1); g.give('iron_pickaxe', 1);
      return g;
    };
    let g = build();
    const shut = await mine(stepContext(g.bot), { block: 'iron_ore', at: [cell(15, 64, 8)], count: 1 });
    expect(shut.ok).toBe(false);
    expect(shut.reason).toBe('unreachable');
    expect(g.dugLog).toHaveLength(0);
    g = build();
    const road = await mine(stepContext(g.bot, undefined, 100), { block: 'iron_ore', at: [cell(15, 64, 8)], count: 1, canDig: ['stone'], maxDig: 12, seconds: 90 });
    expect(road.ok).toBe(true);
    expect(road.text).toContain('mine 済 iron_ore 1 個');
    expect(road.text).toContain('道を');
    expect(g.countOf('raw_iron')).toBe(1);
    const roadBlocks = g.dugLog.filter(dug => dug.name !== 'iron_ore');
    expect(roadBlocks.length).toBeGreaterThan(0);
    expect(roadBlocks.length).toBeLessThanOrEqual(12);
    expect(roadBlocks.every(dug => dug.name === 'stone')).toBe(true);
    g = build();
    const over = await mine(stepContext(g.bot, undefined, 100), { block: 'iron_ore', at: [cell(15, 64, 8)], count: 1, canDig: ['stone'], maxDig: 1, seconds: 90 });
    expect(over.ok).toBe(false);
    expect(over.reason).toBe('limit_dig');
    expect(g.dugLog.filter(dug => dug.name !== 'iron_ore').length).toBeLessThanOrEqual(2);
    expect(g.nameAt(15, 64, 8)).toBe('iron_ore');
  }, 200_000);

  it('5. what is not on the canDig list is not dug on the way (dirt named, stone in the way: not reached, no stone broken)', async () => {
    const g = open();
    g.fill([11, 64, 5], [17, 68, 12], 'stone');
    g.set(15, 64, 8, 'iron_ore');
    g.give('stone_pickaxe', 1);
    const outcome = await mine(stepContext(g.bot, undefined, 60), { block: 'iron_ore', at: [cell(15, 64, 8)], count: 1, canDig: ['dirt'], maxDig: 10, seconds: 40 });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('unreachable');
    expect(g.dugLog).toHaveLength(0);
  }, 90_000);

  it('6. the act\'s own stop cuts the hand between two cells: the cells after it are not dug', async () => {
    const g = open();
    veinScene(g);
    g.give('stone_pickaxe', 1);
    const stop = new AbortController();
    g.bot.once('diggingCompleted', () => stop.abort('cancelled'));
    await expect(mine(stepContext(g.bot, stop.signal), { block: 'iron_ore', at: [cell(11, 64, 8)], count: 5 })).rejects.toBeInstanceOf(StepStopped);
    expect(g.dugLog).toHaveLength(1);
  }, 30_000);

  it('7. through the act: the line says 済 with the count, and a wrong field or a wrong kind is refused before the hand moves, a missing block is "無い: mine 止まった no_block"', async () => {
    const g = open();
    veinScene(g);
    g.give('stone_pickaxe', 1);
    const parse = (result: { result: string }) => JSON.parse(result.result);
    const ok = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'mine', block: 'iron_ore', at: [cell(11, 64, 8)], count: 2 }])));
    expect(ok.ok).toBe(true);
    expect(ok.lines[0].line).toMatch(/^mine 済 iron_ore 2 個（raw_iron×2 を得た）/u);
    expect(g.dugLog).toHaveLength(2);
    const wrongField = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'mine', block: 'iron_ore', at: [cell(11, 64, 8)], item: 'stone_pickaxe' }])));
    expect(wrongField.ok).toBe(false);
    expect(wrongField.lines[0].line).toContain('mine 止まった invalid_input: item は使えない');
    const wrongRange = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'mine', block: 'iron_ore', at: [cell(11, 64, 8)], seconds: 2 }])));
    expect(wrongRange.lines[0].line).toContain('seconds は 5〜120');
    const none = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'mine', block: 'iron_ore', at: [cell(11, 64, 7)] }])));
    expect(none.ok).toBe(false);
    expect(none.lines[0].line).toMatch(/^無い: mine 止まった no_block/u);
    expect(g.dugLog).toHaveLength(2);
  }, 60_000);
});

describe('mine with the conditions of the act', () => {
  it('a done condition that holds in the middle of the hand ends the act ok there: three raw irons asked, six cells would have been dug', async () => {
    const g = open();
    veinScene(g);
    g.give('stone_pickaxe', 1);
    const out = JSON.parse((await runAct(g.bot, ACT_HANDS.parse([{ do: 'mine', block: 'iron_ore', at: [cell(11, 64, 8)], count: 6 }]), undefined, undefined,
      { done: [[{ k: 'have', item: 'raw_iron', n: 3 }]] })).result);
    expect(out.ok).toBe(true);
    expect(out.doneMet).toContain('have:raw_iron');
    expect(g.dugLog.length).toBeGreaterThanOrEqual(3);
    expect(g.dugLog.length).toBeLessThan(6);
    expect(g.countOf('raw_iron')).toBeGreaterThanOrEqual(3);
  }, 40_000);
});

describe('make on the practice ground', () => {
  it('1. two logs and a table at hand: planks, sticks, then the wooden pickaxe (the chain), nothing else touched', async () => {
    const g = open();
    g.set(10, 64, 8, 'crafting_table');
    g.give('oak_log', 2);
    const outcome = await make(stepContext(g.bot), { item: 'wooden_pickaxe' });
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('make 済 wooden_pickaxe×1');
    expect(outcome.text).toContain('oak_planks×8');
    expect(outcome.text).toContain('stick×4');
    expect(g.countOf('wooden_pickaxe')).toBe(1);
    expect(g.countOf('oak_log')).toBe(0);
    expect(g.countOf('oak_planks')).toBe(3);
    expect(g.countOf('stick')).toBe(2);
    // The 3x3 craft was made at the table; the planks and the sticks in the hand's own grid.
    expect(g.craftLog.map(c => `${c.item}${c.table ? '@table' : ''}`)).toEqual(['oak_planks', 'oak_planks', 'stick', 'wooden_pickaxe@table']);
    expect(g.placeLog).toHaveLength(0);
  }, 30_000);

  it('2. a table is needed and none stands near: the one in the pack is put down and used (and left); an item of the hand\'s own 2x2 grid puts none down', async () => {
    const g = open();
    g.give('oak_planks', 8); g.give('crafting_table', 1);
    const sticks = await make(stepContext(g.bot), { item: 'stick', count: 8 });
    expect(sticks.ok).toBe(true);
    expect(g.countOf('stick')).toBe(8);
    expect(g.placeLog).toHaveLength(0);
    expect(g.countOf('crafting_table')).toBe(1);
    const pickaxe = await make(stepContext(g.bot), { item: 'wooden_pickaxe' });
    expect(pickaxe.ok).toBe(true);
    expect(pickaxe.text).toContain('作業台を');
    expect(g.placeLog).toHaveLength(1);
    expect(g.placeLog[0].name).toBe('crafting_table');
    expect(g.countOf('crafting_table')).toBe(0);
    expect(g.nameAt(g.placeLog[0].x, g.placeLog[0].y, g.placeLog[0].z)).toBe('crafting_table');
    expect(g.craftLog[g.craftLog.length - 1]).toMatchObject({ item: 'wooden_pickaxe', table: true });
    expect(g.countOf('wooden_pickaxe')).toBe(1);
  }, 30_000);

  it('3. short of a material: nothing is made and no table is put down; the list is of what the pack cannot make itself', async () => {
    const g = open();
    g.give('oak_log', 1); g.give('crafting_table', 1);
    const outcome = await make(stepContext(g.bot), { item: 'wooden_pickaxe' });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('missing');
    expect(outcome.text).toContain('make 止まった missing: oak_log×1');
    expect(outcome.text).toContain('何も作っていない');
    expect(g.craftLog).toHaveLength(0);
    expect(g.placeLog).toHaveLength(0);
    expect(g.countOf('oak_log')).toBe(1);
    // Two kinds of material short at once.
    const stone = await make(stepContext(g.bot), { item: 'stone_pickaxe' });
    expect(stone.reason).toBe('missing');
    expect(stone.text).toContain('cobblestone×3');
    expect(stone.text).toMatch(/oak_log×\d/u);
    // An ingot is told as the ingot (what is smelted), not as the block or the nuggets it can be made of.
    const iron = await make(stepContext(g.bot), { item: 'iron_pickaxe' });
    expect(iron.reason).toBe('missing');
    expect(iron.text).toContain('iron_ingot×3');
    expect(iron.text).not.toContain('iron_block');
    expect(iron.text).not.toContain('iron_nugget');
    expect(g.craftLog).toHaveLength(0);
  }, 30_000);

  it('4. a 3x3 recipe with no table near and none carried: no_table; and no_recipe for what is not crafted', async () => {
    const g = open();
    g.give('oak_planks', 8);
    const outcome = await make(stepContext(g.bot), { item: 'wooden_pickaxe' });
    expect(outcome.reason).toBe('no_table');
    expect(outcome.text).toContain('make 止まった no_table');
    expect(g.craftLog).toHaveLength(0);
    g.set(1, 64, 1, 'crafting_table');
    g.bot.entity.position = new Vec3(14.5, 64, 14.5);
    expect((await make(stepContext(g.bot), { item: 'wooden_pickaxe' })).reason).toBe('no_table');
    expect((await make(stepContext(g.bot), { item: 'cobblestone' })).reason).toBe('no_recipe');
    expect((await make(stepContext(g.bot), { item: 'wooden_pikaxe' })).reason).toBe('no_recipe');
  }, 20_000);

  it('5. a three-deep chain with the ingots held: logs to planks to sticks to the iron pickaxe, at the table', async () => {
    const g = open();
    g.set(10, 64, 8, 'crafting_table');
    g.give('oak_log', 1); g.give('iron_ingot', 3);
    const outcome = await make(stepContext(g.bot), { item: 'iron_pickaxe' });
    expect(outcome.ok).toBe(true);
    expect(g.countOf('iron_pickaxe')).toBe(1);
    expect(g.countOf('iron_ingot')).toBe(0);
    expect(outcome.text).toContain('oak_planks×');
  }, 30_000);

  it('6. through the act: the line says what was made; a field the hand does not take is refused; a pack that is full and takes nothing says full before any craft', async () => {
    const g = open();
    g.set(10, 64, 8, 'crafting_table');
    g.give('oak_log', 2);
    const parse = (result: { result: string }) => JSON.parse(result.result);
    const made = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'make', item: 'wooden_pickaxe' }])));
    expect(made.ok).toBe(true);
    expect(made.lines[0].line).toMatch(/^make 済 wooden_pickaxe×1（oak_planks×8・stick×4 も作った）/u);
    const bad = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'make', item: 'stick', count: 2, seconds: 5 }])));
    expect(bad.lines[0].line).toContain('seconds は使えない');
    // Full: every slot holds something that is not the item, and what is wanted needs a new slot.
    const full = open();
    full.set(10, 64, 8, 'crafting_table');
    full.give('oak_planks', 4);
    for (let n = 0; n < 40; n++) if (full.give('cobblestone', 64) === 0) break;
    const stopped = await make(stepContext(full.bot), { item: 'stick' });
    expect(stopped.reason).toBe('full');
    expect(full.craftLog).toHaveLength(0);
  }, 30_000);
});

describe('smelt on the practice ground', () => {
  const twoFurnaces = (g: Ground) => { g.set(10, 64, 8, 'furnace'); g.set(10, 64, 10, 'furnace'); };

  it('1. sixteen ores over two furnaces with fuel: each gets 8 and one coal, the batches are written, the hand ends without waiting', async () => {
    const g = open();
    twoFurnaces(g);
    g.give('iron_ore', 16); g.give('coal', 4);
    const started = Date.now();
    const outcome = await smelt(stepContext(g.bot), { items: [{ item: 'iron_ore', count: 16 }], fuel: 'coal', fuelCount: 2, furnaces: 2, at: [cell(10, 64, 8), cell(10, 64, 10)] });
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('smelt 済 iron_ore×16 を 2 基に入れた（(10,64,8)・(10,64,10)）');
    expect(outcome.text).toContain('燃料 coal×2');
    expect(outcome.text).toContain('焼き上がり 約 80 秒後');
    expect(Date.now() - started).toBeLessThan(10_000);
    for (const key of ['10,64,8', '10,64,10']) {
      const state = g.furnaces.get(key)!;
      expect(state.input).toMatchObject({ name: 'iron_ore', count: 8 });
      expect(state.fuel).toMatchObject({ name: 'coal', count: 1 });
    }
    expect(g.countOf('iron_ore')).toBe(0);
    expect(g.countOf('coal')).toBe(2);
    const batches = g.bot.activeFurnaces as Array<{ pos: { x: number; y: number; z: number }; item: string; count: number; readyAt: number }>;
    expect(batches).toHaveLength(2);
    for (const batch of batches) { expect(batch.item).toBe('iron_ore'); expect(batch.count).toBe(8); expect(batch.readyAt - Date.now()).toBeGreaterThan(75_000); expect(batch.readyAt - Date.now()).toBeLessThan(81_000); }
  }, 30_000);

  it('2. three furnaces in the pack and no cell given: they are put down near the body and loaded; two kinds go in their own furnaces', async () => {
    const g = open();
    g.give('furnace', 3); g.give('iron_ore', 9); g.give('raw_gold', 4); g.give('coal', 8);
    const outcome = await smelt(stepContext(g.bot), { items: [{ item: 'iron_ore', count: 9 }, { item: 'raw_gold', count: 4 }], fuel: 'coal', furnaces: 3 });
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('iron_ore×9・raw_gold×4 を 3 基に入れた');
    expect(outcome.text).toContain('置いたかまど');
    expect(g.placeLog.filter(p => p.name === 'furnace')).toHaveLength(3);
    expect(g.countOf('furnace')).toBe(0);
    const loads = [...g.furnaces.values()].map(state => `${state.input?.name}×${state.input?.count}`).sort();
    expect(loads).toEqual(['iron_ore×4', 'iron_ore×5', 'raw_gold×4']);
    expect((g.bot.activeFurnaces as unknown[]).length).toBe(3);
  }, 30_000);

  it('3a. fuel short: only what the fuel smelts is put in, the rest stays in the pack, and the code is fuel_short', async () => {
    const g = open();
    twoFurnaces(g);
    g.give('iron_ore', 16); g.give('coal', 1);
    const outcome = await smelt(stepContext(g.bot), { items: [{ item: 'iron_ore', count: 16 }], fuel: 'coal', furnaces: 2, at: [cell(10, 64, 8), cell(10, 64, 10)] });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('fuel_short');
    expect(outcome.text).toContain('smelt 止まった fuel_short');
    expect(outcome.text).toContain('iron_ore×8');
    expect(g.furnaces.get('10,64,8')!.input).toMatchObject({ name: 'iron_ore', count: 8 });
    expect(g.furnaces.get('10,64,10')?.input ?? null).toBeNull();
    expect(g.countOf('iron_ore')).toBe(8);
    expect((g.bot.activeFurnaces as unknown[]).length).toBe(1);
    // A fuel not carried at all is said before anything is put in; new furnaces with too little fuel are said before they are put down.
    expect((await smelt(stepContext(g.bot), { items: [{ item: 'iron_ore', count: 8 }], fuel: 'charcoal', at: [cell(10, 64, 10)] })).reason).toBe('fuel_short');
    g.give('furnace', 1);
    const fresh = await smelt(stepContext(g.bot), { items: [{ item: 'iron_ore', count: 8 }], fuel: 'coal', fuelCount: 1 });
    expect(fresh.reason).toBe('fuel_short');
    expect(g.placeLog.filter(p => p.name === 'furnace')).toHaveLength(0);
  }, 30_000);

  it('3b. no furnace: a cell that is not one, a pack with none to put down, too many kinds for the furnaces, a slot over 64, a missing input', async () => {
    const g = open();
    twoFurnaces(g);
    g.set(10, 64, 12, 'stone');
    g.give('iron_ore', 16); g.give('coal', 4); g.give('raw_gold', 2);
    expect((await smelt(stepContext(g.bot), { items: [{ item: 'iron_ore', count: 4 }], fuel: 'coal', at: [cell(10, 64, 12)] })).reason).toBe('no_furnace');
    const none = await smelt(stepContext(g.bot), { items: [{ item: 'iron_ore', count: 4 }], fuel: 'coal' });
    expect(none.reason).toBe('no_furnace');
    expect(none.text).toContain('smelt 止まった no_furnace');
    expect((await smelt(stepContext(g.bot), { items: [{ item: 'iron_ore', count: 4 }, { item: 'raw_gold', count: 2 }], fuel: 'coal', furnaces: 1, at: [cell(10, 64, 8)] })).reason).toBe('no_furnace');
    g.give('iron_ore', 100);
    expect((await smelt(stepContext(g.bot), { items: [{ item: 'iron_ore', count: 116 }], fuel: 'coal', furnaces: 1, at: [cell(10, 64, 8)] })).reason).toBe('no_furnace');
    const missing = await smelt(stepContext(g.bot), { items: [{ item: 'iron_ore', count: 200 }, { item: 'raw_copper', count: 3 }], fuel: 'coal', furnaces: 2, at: [cell(10, 64, 8)] });
    expect(missing.reason).toBe('missing');
    expect(missing.text).toContain('raw_copper×3');
    expect(g.furnaces.size).toBe(0);
    expect(g.countOf('iron_ore')).toBe(116);
  }, 30_000);

  it('3c. a furnace far from the body: the body walks to it (the route search) and loads it; a furnace walled in is unreachable', async () => {
    const g = open();
    g.set(2, 64, 3, 'furnace');
    g.give('iron_ore', 8); g.give('coal', 2);
    const outcome = await smelt(stepContext(g.bot), { items: [{ item: 'iron_ore', count: 8 }], fuel: 'coal', at: [cell(2, 64, 3)] });
    expect(outcome.ok).toBe(true);
    expect(g.furnaces.get('2,64,3')!.input).toMatchObject({ name: 'iron_ore', count: 8 });
    expect(g.bot.entity.position.distanceTo(new Vec3(2.5, 64.5, 3.5))).toBeLessThan(6);
    // Walled in on every side.
    const walled = open();
    walled.fill([1, 64, 1], [5, 67, 5], 'stone');
    walled.set(3, 64, 3, 'furnace');
    walled.give('iron_ore', 8); walled.give('coal', 2);
    const shut = await smelt(stepContext(walled.bot, undefined, 40), { items: [{ item: 'iron_ore', count: 8 }], fuel: 'coal', at: [cell(3, 64, 3)], seconds: 10 });
    expect(shut.ok).toBe(false);
    expect(['unreachable', 'limit_time']).toContain(shut.reason);
    expect(walled.furnaces.size).toBe(0);
  }, 60_000);

  it('4. through the act: the line, and a hand that has a field it does not take', async () => {
    const g = open();
    twoFurnaces(g);
    g.give('iron_ore', 16); g.give('coal', 4);
    const parse = (result: { result: string }) => JSON.parse(result.result);
    const out = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'smelt', items: [{ item: 'iron_ore', count: 16 }], fuel: 'coal', fuelCount: 2, furnaces: 2, at: [cell(10, 64, 8), cell(10, 64, 10)] }])));
    expect(out.ok).toBe(true);
    expect(out.lines[0].line).toMatch(/^smelt 済 iron_ore×16 を 2 基に入れた（\(10,64,8\)・\(10,64,10\)）・燃料 coal×2・焼き上がり 約 80 秒後/u);
    const wrong = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'smelt', items: [{ item: 'iron_ore' }] }])));
    expect(wrong.lines[0].line).toContain('items には 1 以上の整数の個数が要る');
    expect(ACT_HANDS.safeParse([{ do: 'smelt', items: [{ item: 'iron_ore', count: 8 }], furnaces: 5 }]).success).toBe(false);
  }, 30_000);
});

describe('the furnace.done event', () => {
  it('is told once per batch when it falls due; not before, not for a batch taken out first, not while in another dimension, and again for a batch put in anew', async () => {
    const g = open();
    g.set(10, 64, 8, 'furnace'); g.set(10, 64, 10, 'furnace');
    g.give('iron_ore', 16); g.give('coal', 4);
    await smelt(stepContext(g.bot), { items: [{ item: 'iron_ore', count: 16 }], fuel: 'coal', furnaces: 2, at: [cell(10, 64, 8), cell(10, 64, 10)] });
    let clock = Date.now();
    const watcher = new BodyEventWatcher(g.bot as never, () => clock, () => []);
    const events = () => watcher.pending(99).filter(event => event.kind === 'furnace.done');
    watcher.tick();
    expect(events()).toHaveLength(0);
    clock += 79_000; watcher.tick();
    expect(events()).toHaveLength(0);
    // The first furnace is emptied before its time (the entry is dropped); the second is let to fall due while the body is in the Nether.
    await furnace(stepContext(g.bot), { at: cell(10, 64, 8), take: 'input' });
    expect((g.bot.activeFurnaces as unknown[]).length).toBe(1);
    g.bot.game.dimension = 'the_nether';
    clock += 5_000; watcher.tick();
    expect(events()).toHaveLength(0);
    g.bot.game.dimension = 'overworld';
    clock += 1_000; watcher.tick(); watcher.tick(); watcher.tick();
    const told = events();
    expect(told).toHaveLength(1);
    expect(told[0].subject).toBe('furnace:10,64,10');
    expect(told[0].data).toMatchObject({ x: 10, y: 64, z: 10, text: 'かまど (10,64,10) の焼きが終わった', input: 'iron_ore', count: 8, dimension: 'overworld', estimated: true });
    expect(Number(told[0].data.lateSec)).toBeGreaterThanOrEqual(5);
    // Once only, also after the events are taken and the clock moves on; a batch put in again later is a new one.
    watcher.acknowledge(told[0].seq);
    clock += 60_000; watcher.tick();
    expect(events()).toHaveLength(0);
    g.give('iron_ore', 2);
    await furnace(stepContext(g.bot), { at: cell(10, 64, 10), put: { item: 'iron_ore', count: 2 } });
    clock = Date.now() + 100_000; watcher.tick();
    expect(events()).toHaveLength(1);
    expect(Number((g.bot.activeFurnaces as Array<{ count: number }>)[0].count)).toBe(10);
  }, 40_000);

  it('is the pure reading a body without the watcher can make too: due batches, told once, the told forgotten when the batch is gone', () => {
    const told = new Set<string>();
    const body = { game: { dimension: 'overworld' }, activeFurnaces: [{ pos: { x: 1, y: 2, z: 3 }, item: 'raw_iron', count: 3, startedAt: 10, readyAt: 1_000, dimension: 'overworld' },
      { pos: { x: 4, y: 5, z: 6 }, item: 'beef', count: 2, startedAt: 10, readyAt: 1_000, dimension: 'the_nether' }] };
    expect(dueFurnaces(body, told, 999)).toEqual([]);
    expect(dueFurnaces(body, told, 1_500).map(done => done.subject)).toEqual(['furnace:1,2,3']);
    expect(dueFurnaces(body, told, 2_000)).toEqual([]);
    body.game.dimension = 'the_nether';
    expect(dueFurnaces(body, told, 2_500).map(done => done.subject)).toEqual(['furnace:4,5,6']);
    body.activeFurnaces.length = 0;
    dueFurnaces(body, told, 3_000);
    expect(told.size).toBe(0);
  });
});
