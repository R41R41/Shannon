import { afterEach, describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { createGround, stepContext, type Ground } from '../helpers/practiceGround.js';
import { place } from '../../src/services/minebot/utils/primitives/place.js';
import { make } from '../../src/services/minebot/utils/primitives/make.js';
import { judgeStation, stationMs, STATION_MIN_MS, STATION_MAX_MS, LEAVE_M, type StationFacts } from '../../src/services/minebot/utils/primitives/stations.js';
import { noteStation, noteStationContents, stationsOf } from '../../src/services/minebot/utils/primitives/stationLedger.js';
import { runAct, ACT_HANDS } from '../../src/services/minebot/instantSkills/act.js';

// Run 5 (2026-11-11): four crafting tables and four furnaces were set down and left standing (16 planks, 32 cobblestone). The body takes a station it
// set down into the pack before a hand that goes far from it; a furnace with a batch in it, a station a hand names, a near target, danger: it stays.

let ground: Ground | null = null;
afterEach(() => { ground?.stop(); ground = null; });
const open = () => { ground?.stop(); ground = createGround({ pathfinder: true }); ground.bot.activeFurnaces = []; ground.start(); return ground; };
const cell = (x: number, y: number, z: number) => ({ x, y, z });
const parse = (result: { result: string }) => JSON.parse(result.result);

const facts = (over: Partial<StationFacts> = {}, block = 'furnace'): StationFacts => ({
  station: { block, x: 10, y: 64, z: 8, dim: 'overworld', life: null, told: false },
  targets: [cell(10 + LEAVE_M + 5, 64, 8)], named: [], fromBody: 3, sameDimension: true, busyFurnace: false, hostileNear: false, lowHealth: false,
  inLiquidOrAir: false, hasPickaxe: true, packFull: false, ...over,
});

describe('judgeStation: what stays and what is taken', () => {
  it('a furnace left behind (target past the leave distance) is taken with a pickaxe; a crafting table is never taken back (make builds one) and is forgotten', () => {
    expect(judgeStation(facts())).toEqual({ do: 'take' });
    expect(judgeStation(facts({}, 'crafting_table'))).toEqual({ do: 'keep', why: 'recraft', forget: true });
  });

  it('the leave distance is 10 m: a target at 10 stays, one past it goes', () => {
    expect(judgeStation(facts({ targets: [cell(10 + 10, 64, 8)] }))).toMatchObject({ do: 'keep', why: 'near' });
    expect(judgeStation(facts({ targets: [cell(10 + 11, 64, 8)] }))).toEqual({ do: 'take' });
    // Several goals: the nearest one decides.
    expect(judgeStation(facts({ targets: [cell(60, 64, 8), cell(14, 64, 8)] }))).toMatchObject({ do: 'keep', why: 'near' });
  });

  it('a furnace with a batch in it (or done and untaken) stays and says so; an idle one does not', () => {
    const verdict = judgeStation(facts({ busyFurnace: true }, 'furnace'));
    expect(verdict).toMatchObject({ do: 'keep', why: 'smelting', forget: false });
    expect((verdict as { say?: string }).say).toContain('焼き途中');
    expect(judgeStation(facts({ busyFurnace: false }, 'furnace'))).toEqual({ do: 'take' });
  });

  it('a station a hand names (a later furnace at, or the hand itself) stays', () => {
    expect(judgeStation(facts({ named: [cell(10, 64, 8)] }, 'furnace'))).toMatchObject({ do: 'keep', why: 'named' });
    expect(judgeStation(facts({ targets: [cell(10, 64, 8)] }))).toMatchObject({ do: 'keep', why: 'named' });
  });

  it('danger, no pickaxe for a furnace, a full pack, a station out of the 8 m: left, said only for a hostile', () => {
    expect(judgeStation(facts({ hostileNear: true }))).toMatchObject({ do: 'keep', why: 'hostile', forget: false, say: expect.stringContaining('敵が近い') });
    expect(judgeStation(facts({ lowHealth: true }))).toMatchObject({ do: 'keep', why: 'unsafe' });
    expect(judgeStation(facts({ inLiquidOrAir: true }))).toMatchObject({ do: 'keep', why: 'unsafe' });
    expect(judgeStation(facts({ hasPickaxe: false }))).toMatchObject({ do: 'keep', why: 'no_pickaxe' });
    expect(judgeStation(facts({ packFull: true }))).toMatchObject({ do: 'keep', why: 'pack_full' });
    expect(judgeStation(facts({ fromBody: 8.5 }))).toMatchObject({ do: 'keep', why: 'far', forget: true });
    expect(judgeStation(facts({ sameDimension: false }))).toMatchObject({ do: 'keep', why: 'dimension', forget: true });
    expect(judgeStation(facts({ targets: [] }))).toMatchObject({ do: 'keep', why: 'no_target' });
  });
});

describe('the stations a body set down, through the act', () => {
  it('place notes a furnace; a go far from it takes it up into the pack first, and the line says so', async () => {
    const g = open();
    g.give('furnace', 1); g.give('stone_pickaxe', 1);
    const put = await place(stepContext(g.bot), { block: 'furnace', at: [cell(10, 64, 8)] });
    expect(put.ok, put.text).toBe(true);
    expect(g.nameAt(10, 64, 8)).toBe('furnace');
    expect(stationsOf(g.bot).map(s => s.block)).toEqual(['furnace']);
    const act = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'go', to: { x: 30, y: 64, z: 8 } }])));
    expect(act.lines[0].line).toContain('拾って持った');
    expect(g.nameAt(10, 64, 8)).toBe('air');
    expect(g.countOf('furnace')).toBe(1);
    expect(stationsOf(g.bot)).toHaveLength(0);
  }, 60_000);

  it('a hunt whose first animal is far from the table takes the furnace up first (hunt has no cell: the animal is its target); one within 10 m leaves it', async () => {
    const g = open();
    g.give('furnace', 1); g.give('stone_pickaxe', 1);
    await place(stepContext(g.bot), { block: 'furnace', at: [cell(10, 64, 8)] });
    const here = g.bot.entity.position;
    const cow = (x: number) => { const id = 9000 + x; g.bot.entities[id] = { id, name: 'cow', type: 'animal', position: new Vec3(x + 0.5, here.y, here.z), height: 1.4, width: 0.9, metadata: [] }; return id; };
    const near = cow(16);
    const stay = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'hunt', target: 'cow', count: 1, seconds: 5 }])));
    expect(stay.lines[0].line).not.toContain('拾って持った');
    expect(g.nameAt(10, 64, 8)).toBe('furnace');
    delete g.bot.entities[near];
    cow(30);
    const taken = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'hunt', target: 'cow', count: 1, seconds: 5 }])));
    expect(taken.lines[0].line).toContain('拾って持った');
    expect(g.nameAt(10, 64, 8)).toBe('air');
    expect(g.countOf('furnace')).toBe(1);
  }, 90_000);

  it('a go that stays within 10 m of it leaves it standing (and keeps it for a later hand)', async () => {
    const g = open();
    g.give('furnace', 1); g.give('stone_pickaxe', 1);
    await place(stepContext(g.bot), { block: 'furnace', at: [cell(10, 64, 8)] });
    const act = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'go', to: { x: 16, y: 64, z: 8 } }])));
    expect(act.ok).toBe(true);
    expect(act.lines[0].line).not.toContain('拾って持った');
    expect(g.nameAt(10, 64, 8)).toBe('furnace');
    expect(stationsOf(g.bot)).toHaveLength(1);
  }, 60_000);

  it('a crafting table is left standing by a far go and forgotten (make builds a new one from planks)', async () => {
    const g = open();
    g.give('crafting_table', 1);
    const put = await place(stepContext(g.bot), { block: 'crafting_table', at: [cell(10, 64, 8)] });
    expect(put.ok, put.text).toBe(true);
    expect(stationsOf(g.bot)).toHaveLength(1);
    const act = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'go', to: { x: 30, y: 64, z: 8 } }])));
    expect(act.lines[0].line).not.toContain('拾って持った');
    expect(g.nameAt(10, 64, 8)).toBe('crafting_table');
    expect(stationsOf(g.bot)).toHaveLength(0);
  }, 60_000);

  it('a furnace smelting stays through a far go; once it has no batch it is taken (with the pickaxe)', async () => {
    const g = open();
    g.give('furnace', 1); g.give('stone_pickaxe', 1);
    await place(stepContext(g.bot), { block: 'furnace', at: [cell(10, 64, 8)] });
    g.bot.activeFurnaces = [{ pos: new Vec3(10, 64, 8), item: 'raw_iron', count: 3, readyAt: Date.now() + 60_000 }];
    const stay = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'go', to: { x: 30, y: 64, z: 8 } }])));
    expect(stay.lines[0].line).toContain('焼き途中');
    expect(g.nameAt(10, 64, 8)).toBe('furnace');
    expect(stationsOf(g.bot)).toHaveLength(1);
    // Back near it, the batch taken: the next far hand takes it up.
    g.bot.entity.position = new Vec3(9.5, 64, 9.5);
    g.bot.activeFurnaces = [];
    const taken = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'go', to: { x: 30, y: 64, z: 8 } }])));
    expect(taken.lines[0].line).toContain('拾って持った');
    expect(g.nameAt(10, 64, 8)).toBe('air');
    expect(g.countOf('furnace')).toBe(1);
  }, 90_000);

  it('a station a later hand of the same act names is not taken', async () => {
    const g = open();
    g.give('furnace', 1); g.give('stone_pickaxe', 1);
    await place(stepContext(g.bot), { block: 'furnace', at: [cell(10, 64, 8)] });
    const act = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'go', to: { x: 30, y: 64, z: 8 } }, { do: 'furnace', at: [{ x: 10, y: 64, z: 8 }], op: 'look' }])));
    expect(act.lines[0].line).not.toContain('拾って持った');
    expect(g.nameAt(10, 64, 8)).toBe('furnace');
  }, 60_000);

  it('only the four station kinds are noted', () => {
    const g = open();
    noteStation(g.bot, 'chest', cell(1, 64, 1));
    noteStation(g.bot, 'white_bed', cell(2, 64, 1));
    expect(stationsOf(g.bot)).toHaveLength(0);
    noteStation(g.bot, 'blast_furnace', cell(3, 64, 1));
    expect(stationsOf(g.bot)).toHaveLength(1);
  });
});

describe('a table in reach is used, not put down again', () => {
  it('place crafting_table with a table in reach lays nothing and is already; the carried table stays in the pack', async () => {
    const g = open();
    g.set(10, 64, 8, 'crafting_table');
    g.give('crafting_table', 1);
    const outcome = await place(stepContext(g.bot), { block: 'crafting_table', at: [cell(10, 64, 10)] });
    expect(outcome.ok, outcome.text).toBe(true);
    expect(outcome).toMatchObject({ goal: 'already', code: 'already_placed' });
    expect(outcome.text).toContain('置かずにそれを使う');
    expect(g.placeLog).toHaveLength(0);
    expect(g.countOf('crafting_table')).toBe(1);
  });

  it('make walks to a table 7 m off before it would put the carried one down', async () => {
    const g = open();
    g.set(15, 64, 8, 'crafting_table');
    g.give('crafting_table', 1); g.give('oak_planks', 8);
    const outcome = await make(stepContext(g.bot, undefined, 40), { item: 'wooden_pickaxe' });
    expect(outcome.ok, outcome.text).toBe(true);
    expect(g.placeLog).toHaveLength(0);
    expect(g.countOf('crafting_table')).toBe(1);
    expect(g.countOf('wooden_pickaxe')).toBe(1);
    expect(outcome.text).not.toContain('作業台を');
  }, 40_000);

  it('make with no table within 8 m still puts the carried one down', async () => {
    const g = open();
    g.give('crafting_table', 1); g.give('oak_planks', 8);
    const outcome = await make(stepContext(g.bot), { item: 'wooden_pickaxe' });
    expect(outcome.ok, outcome.text).toBe(true);
    expect(g.placeLog).toHaveLength(1);
  }, 30_000);
});

describe('review fixes: time sized by the dig, a furnace with a batch and no burn notice stays', () => {
  it('the time one station gets is its dig time plus the collect and pickup, between 6 and 10 s', () => {
    const g = open();
    g.set(10, 64, 8, 'crafting_table');
    noteStation(g.bot, 'crafting_table', cell(10, 64, 8));
    const station = stationsOf(g.bot)[0];
    g.bot.digTime = () => 3750;
    expect(stationMs(g.bot, station)).toBe(7250);
    g.bot.digTime = () => 200;
    expect(stationMs(g.bot, station)).toBe(STATION_MIN_MS);
    g.bot.digTime = () => 60_000;
    expect(stationMs(g.bot, station)).toBe(STATION_MAX_MS);
  });

  it('a furnace seen holding an input (no activeFurnaces entry: the burn was never confirmed) stays through a far go; emptied, it is taken', async () => {
    const g = open();
    g.give('furnace', 1); g.give('stone_pickaxe', 1);
    await place(stepContext(g.bot), { block: 'furnace', at: [cell(10, 64, 8)] });
    noteStationContents(g.bot, cell(10, 64, 8), true);
    const stay = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'go', to: { x: 30, y: 64, z: 8 } }])));
    expect(stay.lines[0].line).toContain('焼き途中');
    expect(g.nameAt(10, 64, 8)).toBe('furnace');
    g.bot.entity.position = new Vec3(9.5, 64, 9.5);
    noteStationContents(g.bot, cell(10, 64, 8), false);
    const taken = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'go', to: { x: 30, y: 64, z: 8 } }])));
    expect(taken.lines[0].line).toContain('拾って持った');
  }, 90_000);

  it('the pickup note comes first in the line, so a clip keeps it', async () => {
    const g = open();
    g.give('crafting_table', 1);
    await place(stepContext(g.bot), { block: 'crafting_table', at: [cell(10, 64, 8)] });
    const act = parse(await runAct(g.bot, ACT_HANDS.parse([{ do: 'go', to: { x: 30, y: 64, z: 8 } }])));
    expect(act.lines[0].line.indexOf('拾って持った')).toBeLessThan(40);
  }, 60_000);
});
