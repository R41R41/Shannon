import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

// The block scan is stood in for here, for nearbyNeeds only (nearestOres inside the module keeps the real one).
const scanned: { hits: Array<{ name: string; position: Vec3; distance: number }> } = { hits: [] };
vi.mock('../../src/services/minebot/utils/loadedBlockScan.js', async (original) => ({
  ...(await original() as object),
  scanLoadedBlocks: vi.fn((_bot: unknown, names: Iterable<string>) => {
    const wanted = new Set(names);
    return { hits: scanned.hits.filter(hit => wanted.has(hit.name)), columns: 1, reachMetres: 24, sectionsScanned: 1 };
  }),
}));

const { default: CraftOne } = await import('../../src/services/minebot/instantSkills/craftOne.js');
const { default: WithdrawFromFurnace } = await import('../../src/services/minebot/instantSkills/withdrawFromFurnace.js');
const { default: ExploreForStructure } = await import('../../src/services/minebot/instantSkills/exploreForStructure.js');
const { placeableSpots } = await import('../../src/services/minebot/instantSkills/findPlaceableSpot.js');
const { lastLogNote, spareToolNote, toolKitNotice } = await import('../../src/services/minebot/utils/toolWear.js');
const { nearbyNeeds } = await import('../../src/services/minebot/utils/nearbyNeeds.js');
const { noteUnreachable, wasUnreachable } = await import('../../src/services/minebot/utils/unreachableTargets.js');
const { createMotorPort } = await import('../../src/services/minebot/execution/ActionExecution.js');

const registry = minecraftData('1.21.11');
const pick = (name: string, left: number, max: number) => ({ name, count: 1, maxDurability: max, durabilityUsed: max - left });
const pack = (items: any[]) => ({ inventory: { items: () => items, slots: new Array(46).fill(null) } });

describe('craft-one says the table is back in the pack only when it is (run 18, D27: "拾い直しました" with no table)', () => {
  const crafter = (pickedUp: 'dig' | 'pickup' | 'never') => {
    const items: any[] = [{ name: 'acacia_planks', count: 1 }];
    const bot: any = { version: '1.21.11', ...pack(items) };
    bot.inventory.items = () => items;
    const skill: any = new CraftOne(bot);
    const calls: string[] = [];
    skill.callSkill = async (name: string) => {
      calls.push(name);
      if ((name === 'dig-block-at' && pickedUp === 'dig') || (name === 'pickup-nearest-item' && pickedUp === 'pickup')) items.push({ name: 'crafting_table', count: 1 });
      return { success: true, result: 'ok' };
    };
    return { skill, calls };
  };
  it('says so when the pack has it after the dig', async () => {
    const { skill, calls } = crafter('dig');
    expect(await skill.takeTableBack(new Vec3(71, 27, -15))).toBe('置いた作業台(71, 27, -15)は拾い直しました');
    expect(calls).toEqual(['dig-block-at']);
  });
  it('looks for the drop by name once, and says what the pack holds after', async () => {
    const picked = crafter('pickup');
    expect(await picked.skill.takeTableBack(new Vec3(71, 27, -15))).toBe('置いた作業台(71, 27, -15)は拾い直しました');
    expect(picked.calls).toEqual(['dig-block-at', 'pickup-nearest-item']);
    const lost = crafter('never');
    expect(await lost.skill.takeTableBack(new Vec3(71, 27, -15))).toContain('掘りましたが、拾えていません');
  });
  it('says when the last log went into a craft, and what is left to make a table of', () => {
    expect(lastLogNote(pack([{ name: 'acacia_planks', count: 1 }]))).toBe('原木はこれで最後です（板材1枚、作業台なし）。次に作業台が要る時のために、原木を集めるか板4枚を残しておく');
    expect(lastLogNote(pack([{ name: 'acacia_planks', count: 4 }]))).toBe('原木はこれで最後です（板材4枚、作業台なし）。');
  });
});

describe('the tool kit is said before it runs out (run 18, D44: three pickaxes broke in one mine-block, nothing said before)', () => {
  it('says the best pickaxe is low with no sound spare: D44 had iron 84/250, stone 2, wooden 2', () => {
    const d44 = [pick('iron_pickaxe', 84, 250), pick('stone_pickaxe', 2, 131), pick('wooden_pickaxe', 2, 59), { name: 'acacia_planks', count: 1 }];
    expect(toolKitNotice(pack(d44))).toContain('つるはしはiron_pickaxeだけで残り84/250');
    expect(spareToolNote(pack(d44))).toContain('予備のツルハシ');
    // D24 (iron 250/250): nothing to say of the pickaxe.
    expect(toolKitNotice(pack([pick('iron_pickaxe', 250, 250), { name: 'crafting_table', count: 1 }]))).toBeUndefined();
    // A sound stone pickaxe is the spare.
    expect(toolKitNotice(pack([pick('iron_pickaxe', 84, 250), pick('stone_pickaxe', 131, 131), { name: 'oak_log', count: 1 }]))).toBeUndefined();
    expect(toolKitNotice(pack([{ name: 'oak_log', count: 1 }]))).toBe('つるはしが無い');
    // A new wooden pickaxe (59) is not low from the start; one at 30 is.
    expect(toolKitNotice(pack([pick('wooden_pickaxe', 59, 59), { name: 'oak_log', count: 1 }]))).toBeUndefined();
    expect(toolKitNotice(pack([pick('wooden_pickaxe', 30, 59), { name: 'oak_log', count: 1 }]))).toContain('wooden_pickaxeだけで残り30/59');
  });
  it('says no table can be had where the body is: no table, fewer than four planks, no log (D28 to D43)', () => {
    const note = toolKitNotice(pack([pick('iron_pickaxe', 250, 250), { name: 'acacia_planks', count: 1 }]));
    expect(note).toContain('作業台も板4枚も原木も無い');
    expect(toolKitNotice(pack([pick('iron_pickaxe', 250, 250), { name: 'acacia_planks', count: 4 }]))).toBeUndefined();
  });
});

describe('what mine-block could not reach is remembered on the body, not on the handle of one call (run 18: the same iron three times)', () => {
  it('a later call, with a handle of its own, still sees it', () => {
    const bot = {};
    noteUnreachable(createMotorPort(bot), { x: 58, y: 57, z: 16 });
    expect(wasUnreachable(createMotorPort(bot), { x: 58, y: 57, z: 16 })).toBe(true);
    expect(wasUnreachable(createMotorPort({}), { x: 58, y: 57, z: 16 })).toBe(false);
    expect(wasUnreachable(bot, { x: 58, y: 57, z: 16 }, Date.now() + 11 * 60_000)).toBe(false);
  });
});

describe('withdraw-from-furnace waitForCompletion=true is refused like wait-time when the wait is long and there is work (run 18, D15: 53 s)', () => {
  const body = (remainingMs: number, extra: Record<string, unknown> = {}) => ({
    version: '1.21.11', registry, entity: { position: new Vec3(56, 58, 0) }, entities: {}, game: { dimension: 'overworld' }, time: { timeOfDay: 6000 },
    ...pack([pick('stone_pickaxe', 23, 131), { name: 'iron_ingot', count: 8 }]),
    activeFurnaces: [{ pos: { x: 57, y: 58, z: -1 }, item: 'raw_iron', count: 6, readyAt: Date.now() + remainingMs, startedAt: Date.now(), dimension: 'overworld' }],
    ...extra,
  }) as any;
  it('refuses with what is left and what to do meanwhile', () => {
    const refused = (new WithdrawFromFurnace(body(54_000)) as any).preflight(57, 58, -1, 'all', true);
    expect(refused).toMatchObject({ success: false, failureType: 'wait_refused', recoverable: true });
    expect(refused.result).toContain('raw_iron×6 は残り約54秒');
    expect(refused.result).toContain('iron_chestplate');
  });
  it('lets a short wait, no waitForCompletion, another furnace and a healing body go by', () => {
    expect((new WithdrawFromFurnace(body(15_000)) as any).preflight(57, 58, -1, 'all', true)).toBeNull();
    expect((new WithdrawFromFurnace(body(54_000)) as any).preflight(57, 58, -1, 'all', undefined)).toBeNull();
    expect((new WithdrawFromFurnace(body(54_000)) as any).preflight(56, 58, 0, 'all', true)).toBeNull();
    expect((new WithdrawFromFurnace(body(54_000, { health: 6, food: 19 })) as any).preflight(57, 58, -1, 'all', true)).toBeNull();
    // Taking the input or the fuel out never waits for the batch.
    expect((new WithdrawFromFurnace(body(54_000)) as any).preflight(57, 58, -1, 'input', true)).toBeNull();
    expect((new WithdrawFromFurnace(body(54_000)) as any).preflight(57, 58, -1, 'output', true)).not.toBeNull();
  });
});

describe('place-block-at chooses only a cell with a full block to place against (run 18, D2: a cell beside grass, "in the air")', () => {
  const world = (under: { name: string; boundingBox: string }) => ({
    entity: { position: new Vec3(0.5, 64, 0.5) },
    blockAt: (p: Vec3) => p.x === 2 && p.y === 63 && p.z === 0 ? under : { name: 'air', boundingBox: 'empty' },
  });
  it('a cell over short grass is no spot; over stone it is', () => {
    expect(placeableSpots(world({ name: 'short_grass', boundingBox: 'empty' }), 3, 32)).toEqual([]);
    expect(placeableSpots(world({ name: 'stone', boundingBox: 'block' }), 3, 32)).toEqual(expect.arrayContaining([expect.objectContaining({ x: 2, y: 64, z: 0, ref: '下' })]));
  });
});

describe('the observation says what an unmet need wants nearby (the owner: run 18 never saw the iron ore near it in 49 decisions)', () => {
  const woolMeta = (color: number) => { const meta: unknown[] = []; meta[17] = color; return meta; };
  const body = (items: any[], extra: Record<string, unknown> = {}) => ({
    registry, entity: { position: new Vec3(0.5, 64, 0.5) }, world: { getColumns: () => [] },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }), ...pack(items),
    entities: {
      2: { name: 'sheep', position: new Vec3(10.5, 64, 0.5), metadata: woolMeta(12), height: 1.3 },   // brown
      3: { name: 'sheep', position: new Vec3(6.5, 64, 0.5), metadata: woolMeta(0), height: 1.3 },     // white
      4: { name: 'cow', position: new Vec3(30.5, 64, 0.5), height: 1.4 },                                // beyond 24 m
      5: { name: 'pig', position: new Vec3(0.5, 64, 8.5), height: 0.9 },
    },
    ...extra,
  }) as any;
  it('the sheep of the wool carried for the bed, the animals for food, the ore for iron, logs for wood', () => {
    scanned.hits = [{ name: 'iron_ore', position: new Vec3(3, 60, 3), distance: 5.8 }, { name: 'acacia_log', position: new Vec3(-5, 64, 2), distance: 5.6 }];
    const needs = nearbyNeeds(body([{ name: 'brown_wool', count: 1 }, { name: 'acacia_planks', count: 1 }]), 1_000);
    expect(needs.filter(need => need.need === 'bed_wool')).toEqual([expect.objectContaining({ name: 'sheep', color: 'brown', distance: 10, canReach: true })]);
    expect(needs.filter(need => need.need === 'food').map(need => need.name)).toEqual(['sheep', 'pig']);
    expect(needs.find(need => need.need === 'iron')).toMatchObject({ name: 'iron_ore', position: { x: 3, y: 60, z: 3 }, canReach: true });
    expect(needs.find(need => need.need === 'iron')).not.toHaveProperty('exposed');
    expect(needs.find(need => need.need === 'wood')).toMatchObject({ need: 'wood' });
    expect(needs.some(need => need.name === 'cow')).toBe(false);
  });
  it('says nothing of a need already met: a bed, six cooked, iron armour and ingots, planks', () => {
    scanned.hits = [{ name: 'iron_ore', position: new Vec3(3, 60, 3), distance: 5.8 }];
    const met = body([{ name: 'white_bed', count: 1 }, { name: 'cooked_beef', count: 6 }, { name: 'iron_chestplate', count: 1 },
      { name: 'iron_leggings', count: 1 }, { name: 'iron_ingot', count: 9 }, { name: 'oak_planks', count: 12 }]);
    expect(nearbyNeeds(met, 1_000)).toEqual([]);
  });
  it('an ore mine-block failed to reach is said, and why', () => {
    scanned.hits = [{ name: 'iron_ore', position: new Vec3(58, 57, 16), distance: 6 }];
    const bot = body([{ name: 'white_bed', count: 1 }, { name: 'cooked_beef', count: 6 }, { name: 'oak_planks', count: 12 }]);
    noteUnreachable(bot, { x: 58, y: 57, z: 16 });
    expect(nearbyNeeds(bot, Date.now())).toEqual([expect.objectContaining({ need: 'iron', canReach: false, why: 'failed_recently' })]);
  });
  it('a buried ore can still be reached (by digging) but is out of sight; so is an animal behind a wall', () => {
    scanned.hits = [{ name: 'iron_ore', position: new Vec3(3, 60, 3), distance: 5.8 }];
    // Rock everywhere but the body's two cells and a strip of air from x 0 to 4; the pig at z 8 is behind the rock.
    const solid = (p: Vec3) => !(p.z === 0 && p.y >= 64 && p.y <= 65 && p.x >= 0 && p.x <= 4);
    const bot = body([{ name: 'white_bed', count: 1 }, { name: 'oak_planks', count: 12 }],
      { blockAt: (p: Vec3) => solid(p) ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' } });
    const needs = nearbyNeeds(bot, 1_000);
    expect(needs.find(need => need.need === 'iron')).toMatchObject({ canReach: true, exposed: false });
    expect(needs.filter(need => need.need === 'food').every(need => need.exposed === false && need.canReach)).toBe(true);
  });

  it('is read again only every few seconds, or when the body has moved', () => {
    scanned.hits = [];
    const bot = body([{ name: 'white_bed', count: 1 }, { name: 'cooked_beef', count: 6 }, { name: 'oak_planks', count: 12 }]);
    expect(nearbyNeeds(bot, 1_000)).toEqual([]);
    scanned.hits = [{ name: 'iron_ore', position: new Vec3(3, 60, 3), distance: 5.8 }];
    expect(nearbyNeeds(bot, 2_000)).toEqual([]);
    expect(nearbyNeeds(bot, 4_500)).toHaveLength(1);
  });
});

describe('explore-for-structure looks for animals too (run 18: one sheep in thirty minutes, no bed)', () => {
  const explorer = (entities: Record<string, any>) => {
    const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 }, entities, registry };
    const skill: any = new ExploreForStructure(bot);
    skill.callSkill = vi.fn(async () => ({ success: false, result: 'blocked' }));
    return skill;
  };
  const brown = () => { const meta: unknown[] = []; meta[17] = 12; return meta; };
  it('finds a sheep of the colour in sight and says how to hunt it', async () => {
    const result = await explorer({ 2: { name: 'sheep', position: new Vec3(20.5, 64, 0.5), metadata: brown() } }).runImpl('sheep', 'north', 96, 'brown');
    expect(result).toMatchObject({ success: true });
    expect(result.result).toContain('sheep（brown）を発見');
    expect(result.result).toContain('attack-continuously sheep color=brown');
  });
  it('a sheep of another colour is not it: it goes looking, and says what it covered', async () => {
    const skill = explorer({ 2: { name: 'sheep', position: new Vec3(20.5, 64, 0.5), metadata: brown() } });
    const result = await skill.runImpl('sheep', 'north', 96, 'white');
    expect(result).toMatchObject({ success: false, failureType: 'target_not_found' });
    expect(skill.callSkill).toHaveBeenCalled();
  });
  it('refuses a colour that is none', async () => {
    expect(await explorer({}).runImpl('sheep', 'north', 96, 'mauve')).toMatchObject({ failureType: 'invalid_input' });
  });
});
