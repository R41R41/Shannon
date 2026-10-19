import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: vi.fn(async () => ({ success: true })) }));

const { bedWool, cookRawNotice, descentFloor, descentKit, descentKitNotice, nightGateFor, isPreparedFood, woolStatusLine } = await import('../../src/services/minebot/utils/nightGate.js');
const { bedFromWool } = await import('../../src/services/minebot/instantSkills/craftOne.js');
const { default: MoveTo } = await import('../../src/services/minebot/instantSkills/moveTo.js');
const { default: StairMine } = await import('../../src/services/minebot/instantSkills/stairMine.js');
const { default: DigBlockAt } = await import('../../src/services/minebot/instantSkills/digBlockAt.js');
const { default: MineBlock } = await import('../../src/services/minebot/instantSkills/mineBlock.js');
const { default: WaitTime } = await import('../../src/services/minebot/instantSkills/waitTime.js');
const { default: AttackContinuously, sheepWool } = await import('../../src/services/minebot/instantSkills/attackContinuously.js');
const { default: WithdrawFromFurnace } = await import('../../src/services/minebot/instantSkills/withdrawFromFurnace.js');
const { shelterChoice } = await import('../../src/services/minebot/utils/floorReflexes.js');
const { tunnelDigMs } = await import('../../src/services/minebot/utils/routeEstimate.js');

const registry = minecraftData('1.21.11');
const DUSK = 12_000;          // 50 s to dark: the gate is closed
const NOON = 6_000;
const NIGHT = 18_000;

/** A body for the gate: where it stands, the clock, and what it carries (worn armour in slots 5-8). */
function gateBody(y: number, timeOfDay: number, items: Array<{ name: string; count?: number }> = [], worn: string[] = []) {
  const slots: Array<{ name: string } | null> = new Array(46).fill(null);
  worn.forEach((name, i) => { slots[5 + i] = { name }; });
  return { version: '1.21.11', registry, entity: { position: new Vec3(0.5, y, 0.5) }, time: { timeOfDay }, game: { dimension: 'overworld' },
    inventory: { items: () => items.map(item => ({ count: 1, ...item })), slots, emptySlotCount: () => 30 } } as any;
}

describe('the night gate: no going below y 16 at dusk or night without armour, cooked food and a bed (run 16 died at y -7)', () => {
  it('reads the kit from what is worn and carried: a chestplate, or two iron-or-better pieces; two cooked portions; a bed', () => {
    expect(descentKit(gateBody(70, NOON)).missing).toEqual(['armor', 'cooked_food', 'bed']);
    expect(descentKit(gateBody(70, NOON, [{ name: 'leather_chestplate' }])).missing).not.toContain('armor');
    expect(descentKit(gateBody(70, NOON, [], ['iron_helmet', 'leather_chestplate'])).missing).not.toContain('armor');   // worn counts too
    expect(descentKit(gateBody(70, NOON, [{ name: 'iron_helmet' }, { name: 'iron_boots' }])).missing).not.toContain('armor');
    expect(descentKit(gateBody(70, NOON, [{ name: 'golden_helmet' }, { name: 'iron_boots' }])).missing).toContain('armor');
    expect(descentKit(gateBody(70, NOON, [{ name: 'cooked_mutton', count: 1 }, { name: 'bread', count: 1 }])).missing).not.toContain('cooked_food');
    expect(descentKit(gateBody(70, NOON, [{ name: 'mutton', count: 6 }, { name: 'cooked_beef', count: 1 }])).missing).toContain('cooked_food');
    expect(descentKit(gateBody(70, NOON, [{ name: 'white_bed' }])).missing).not.toContain('bed');
    const remembered = gateBody(70, NOON);
    remembered.placeMemory = { state: { places: [{ kind: 'bed', keep: 'respawn', dimension: 'overworld' }] } };
    expect(descentKit(remembered).missing).not.toContain('bed');
    expect(isPreparedFood('cooked_chicken')).toBe(true);
    expect(isPreparedFood('chicken')).toBe(false);
  });

  it('is closed only at night or within five minutes of dark (run 17 went down 260 s before it), in the overworld, while something is missing', () => {
    expect(descentFloor(gateBody(70, NOON))).toBeNull();             // 350 s to dark
    expect(descentFloor(gateBody(70, 6_900))).toBeNull();            // 305 s
    expect(descentFloor(gateBody(70, 7_100))?.floor).toBe(16);       // 295 s
    expect(descentFloor(gateBody(70, DUSK))?.floor).toBe(16);
    expect(descentFloor(gateBody(70, NIGHT))?.floor).toBe(16);
    expect(descentFloor(gateBody(70, 23_500))).toBeNull();           // dawn
    const nether = gateBody(70, NIGHT); nether.game.dimension = 'the_nether';
    expect(descentFloor(nether)).toBeNull();
    const kitted = gateBody(70, NIGHT, [{ name: 'iron_chestplate' }, { name: 'cooked_beef', count: 4 }, { name: 'red_bed' }]);
    expect(descentFloor(kitted)).toBeNull();
  });

  it('refuses a goal below y 16 from the surface, and only going deeper from underground (the way up is never shut)', () => {
    const surface = gateBody(70, NIGHT);
    expect(nightGateFor(surface, 20, 'move-to')).toBeNull();
    const refused = nightGateFor(surface, 11, 'move-to（目標 y11）')!;
    expect(refused).toMatchObject({ success: false, failureType: 'night_unprepared', recoverable: true });
    // The form agreed with the API: the first sentence, and the missing parts as words at the very end.
    expect(refused.result).toMatch(/^夜の深い所は備えがそろうまで断る（夜の門）。夜（明けるまで約\d+秒）/);
    expect(refused.result).toContain('備え: 防具（胸当てか、鉄以上の部位2つ）、焼いた食料（2個以上。いま0個）、ベッドが無い');
    expect(refused.result).toContain('次の手:');
    expect(refused.result).toMatch(/足りない: armor, cooked_food, bed$/);
    expect(nightGateFor(gateBody(70, NIGHT, [{ name: 'red_bed' }, { name: 'iron_chestplate' }]), 10, 'x')!.result).toMatch(/足りない: cooked_food$/);
    const cave = gateBody(-7, NIGHT);
    expect(nightGateFor(cave, -8, 'stair-mine')).toBeNull();          // a step down
    expect(nightGateFor(cave, 30, 'move-to')).toBeNull();             // up
    expect(nightGateFor(cave, -7, 'move-to')).toBeNull();             // along
    expect(nightGateFor(cave, -20, 'move-to')?.result).toContain('今の高さで横へ掘るか、上へ戻る');
    // Two blocks at a time do not add up: the floor is two under where the gate first closed on the body this night.
    cave.entity.position = new Vec3(0.5, -9, 0.5);
    expect(nightGateFor(cave, -11, 'stair-mine')).not.toBeNull();
    expect(nightGateFor(cave, -9, 'move-to')).toBeNull();               // along, where it stands now
    // Fallen lower than that: along and up from there, never further down.
    cave.entity.position = new Vec3(0.5, -30, 0.5);
    expect(nightGateFor(cave, -30, 'move-to')).toBeNull();
    expect(nightGateFor(cave, -32, 'move-to')).not.toBeNull();
    // The next night starts again from where the body stands.
    cave.time = { timeOfDay: NIGHT, day: 1 };
    expect(nightGateFor(cave, -32, 'move-to')).toBeNull();
  });

  it('is applied before the body is asked for by move-to (goal heights only), stair-mine and dig-block-at', () => {
    const body = gateBody(70, DUSK);
    const move: any = new MoveTo(body);
    expect(move.preflight(10, 11, 10, 2, 'near')).toMatchObject({ failureType: 'night_unprepared' });
    expect(move.preflight(10, 11, 10, 2, 'nearxz')).toBeNull();     // no goal height: not a descent
    expect(move.preflight(10, 11, 10, 2, 'NEAR')).toMatchObject({ failureType: 'night_unprepared' });   // an unknown name is GoalNear
    expect(move.preflight(10, 64, 10, 2, 'block')).toBeNull();
    const stair: any = new StairMine(body);
    expect(stair.preflight(12)).toMatchObject({ failureType: 'night_unprepared' });
    expect(stair.preflight(40)).toBeNull();
    const low = gateBody(18, NIGHT);
    const dig: any = new DigBlockAt(low);
    expect(dig.preflight(0, 14, 0)).toMatchObject({ failureType: 'night_unprepared' });
    expect(dig.preflight(0, 19, 0)).toBeNull();                       // above the feet: never a descent
  });

  it('mine-block leaves the targets below the floor and says so; refuses when they are all down there', async () => {
    const deep = new Vec3(4, 11, 0), shallow = new Vec3(6, 40, 0);
    const pick = { name: 'iron_pickaxe', type: registry.itemsByName.iron_pickaxe.id, count: 1, maxDurability: 250, durabilityUsed: 0 };
    const body = (ores: Vec3[]) => Object.assign(new EventEmitter(), gateBody(70, NIGHT, [pick]), {
      entities: {}, interruptExecution: false, findBlocks: () => ores,
      blockAt: (pos: Vec3) => ores.some(ore => ore.equals(pos.floored())) ? { name: 'diamond_ore', position: pos, diggable: true } : { name: 'air' },
    });
    const bot: any = body([deep, shallow]);
    const move = { run: vi.fn().mockResolvedValue({ success: false, failureType: 'path_not_found', recoverable: true, result: 'fixture' }) };
    bot.instantSkills = { getSkill: (name: string) => name === 'move-to' ? move : name === 'stair-mine' ? null : { run: vi.fn() } };
    await new MineBlock(bot).runImpl('diamond_ore', 1, 32);
    expect(move.run.mock.calls.length).toBeGreaterThan(0);
    expect(move.run.mock.calls.every(call => call[0] === 6 && call[1] === 40)).toBe(true);   // never the one at y 11
    const only: any = body([deep]);
    only.instantSkills = bot.instantSkills;
    const refused: any = await new MineBlock(only).runImpl('diamond_ore', 1, 32);
    expect(refused).toMatchObject({ success: false, failureType: 'night_unprepared' });
    expect(refused.result).toContain('どれも y16 より下');
  });

  it('the observation says the kit from five minutes before dark, and the wool towards a bed', () => {
    expect(descentKitNotice(gateBody(70, 0))).toBeUndefined();                                                            // 650 s
    expect(descentKitNotice(gateBody(70, NOON))).toEqual({ missing: ['armor', 'cooked_food', 'bed'], gated: false });   // 350 s
    expect(descentKitNotice(gateBody(70, 8_000))).toEqual({ missing: ['armor', 'cooked_food', 'bed'], gated: true });   // 250 s
    expect(descentKitNotice(gateBody(70, NIGHT))).toEqual({ missing: ['armor', 'cooked_food', 'bed'], gated: true });
    expect(bedWool(gateBody(70, NOON, [{ name: 'white_wool', count: 2 }, { name: 'light_gray_wool', count: 1 }]))).toEqual({ color: 'white', have: 2, need: 3 });
    expect(bedWool(gateBody(70, NOON, [{ name: 'white_wool', count: 2 }, { name: 'red_bed' }]))).toBeUndefined();
    expect(bedWool(gateBody(70, NOON))).toBeUndefined();
  });
});

describe('mine-block: names joined by commas, and the same target kept while the walk to it gets nearer', () => {
  it('takes "birch_log,oak_log" as two kinds (run 16 was told the block did not exist)', async () => {
    const birch = new Vec3(9, 64, 0), oak = new Vec3(12, 64, 0);
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', registry, entity: { position: new Vec3(0.5, 64, 0.5) }, entities: {}, interruptExecution: false,
      inventory: { items: () => [], emptySlotCount: () => 30 },
      findBlocks: ({ matching }: { matching: number }) => matching === registry.blocksByName.birch_log.id ? [birch] : matching === registry.blocksByName.oak_log.id ? [oak] : [],
      blockAt: (pos: Vec3) => pos.equals(birch) ? { name: 'birch_log', position: pos, diggable: true } : pos.equals(oak) ? { name: 'oak_log', position: pos, diggable: true } : { name: 'air' },
    });
    const move = { run: vi.fn().mockResolvedValue({ success: false, failureType: 'path_not_found', recoverable: true, result: 'fixture' }) };
    bot.instantSkills = { getSkill: (name: string) => name === 'move-to' ? move : { run: vi.fn().mockResolvedValue({ success: false, failureType: 'dig_failed', result: 'fixture' }) } };
    const result: any = await new MineBlock(bot).runImpl('birch_log, oak_log', 1, 16);
    expect(result.failureType).not.toBe('invalid_block');
    expect(new Set(move.run.mock.calls.map(call => call[0]))).toEqual(new Set([9, 12]));
    expect((await new MineBlock(bot).runImpl('birch_log,no_such_block', 1, 16) as any).failureType).not.toBe('invalid_block');
    expect((await new MineBlock(bot).runImpl('no_such_block', 1, 16) as any).failureType).toBe('invalid_block');
  });

  it('a failed walk that still got three blocks nearer goes on to the same target, not to the next of the vein (run 16: three stairs)', async () => {
    const a = new Vec3(20, 64, 0), b = new Vec3(20, 64, 1);
    const pick = { name: 'stone_pickaxe', type: registry.itemsByName.stone_pickaxe.id, count: 1, maxDurability: 131, durabilityUsed: 0 };
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', registry, entity: { position: new Vec3(0.5, 64, 0.5) }, entities: {}, interruptExecution: false,
      inventory: { items: () => [pick], emptySlotCount: () => 30 }, findBlocks: () => [a, b],
      blockAt: (pos: Vec3) => pos.equals(a) || pos.equals(b) ? { name: 'iron_ore', position: pos, diggable: true } : { name: 'air' },
    });
    const move = { run: vi.fn(async (x: number) => { bot.entity.position = bot.entity.position.offset(5, 0, 0); return { success: false, failureType: 'path_not_found', recoverable: true, result: `to ${x}` }; }) };
    bot.instantSkills = { getSkill: (name: string) => name === 'move-to' ? move : { run: vi.fn() } };
    await new MineBlock(bot).runImpl('iron_ore', 1, 32);
    const targets = move.run.mock.calls.map(call => `${call[0]},${call[2]}`);
    expect(targets[0]).toBe(targets[1]);
  });
});

describe('wait-time is refused while a furnace works and there is something else to do (run 16 waited 70 s)', () => {
  const body = (remainingMs: number, items: Array<{ name: string; count: number }>, extra: Record<string, unknown> = {}) => ({
    version: '1.21.11', registry, entity: { position: new Vec3(0, 64, 0) }, entities: {}, game: { dimension: 'overworld' }, time: { timeOfDay: NOON },
    inventory: { items: () => items, slots: new Array(46).fill(null) },
    activeFurnaces: [{ pos: { x: 28, y: 67, z: -1 }, item: 'raw_iron', count: 8, readyAt: Date.now() + remainingMs, startedAt: Date.now(), dimension: 'overworld' }],
    ...extra,
  }) as any;
  it('refuses a long wait with the time left and what to do instead', () => {
    const refused = (new WaitTime(body(60_000, [{ name: 'stone_pickaxe', count: 1 }])) as any).preflight(40_000);
    expect(refused).toMatchObject({ success: false, failureType: 'wait_refused', recoverable: true });
    expect(refused.result).toContain('raw_iron×8 残り約60秒');
    expect(refused.result).toContain('mine-block');
    expect(refused.result).toContain('withdraw-from-furnace で取り出す');
    // The way round this refusal is no longer offered: withdraw-from-furnace waitForCompletion=true is refused the same way (run 18, D15).
    expect(refused.result).not.toContain('waitForCompletion=true');
  });
  it('lets a short wait, a furnace nearly done, a hurt body healing, and no furnace at all (by day) go by', () => {
    const items = [{ name: 'stone_pickaxe', count: 1 }];
    expect((new WaitTime(body(60_000, items)) as any).preflight(3_000)).toBeNull();
    expect((new WaitTime(body(8_000, items)) as any).preflight(30_000)).toBeNull();
    // A hostile near is no longer a reason to stand still (run 17); a body at 6 health with food to regenerate on is.
    const zombie = { entities: { 2: { name: 'zombie', position: new Vec3(5, 64, 0) } } };
    expect((new WaitTime(body(60_000, items, zombie)) as any).preflight(30_000)).not.toBeNull();
    expect((new WaitTime(body(60_000, items, { health: 6, food: 19 })) as any).preflight(30_000)).toBeNull();
    expect((new WaitTime(body(60_000, items, { activeFurnaces: [] })) as any).preflight(30_000)).toBeNull();
  });
});

describe('attack-continuously: the best weapon back in hand, blows told by what was held, sheep by colour', () => {
  it('re-equips the sword when the hand holds something else, and says what each blow was struck with', async () => {
    const target: any = { id: 2, name: 'chicken', position: new Vec3(1.5, 64, 0.5), height: 0.7, width: 0.4, isValid: true };
    let blows = 0;
    const equip = vi.fn(async (item: { name: string }) => { bot.heldItem = { name: item.name }; });
    const bot: any = { entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, health: 20, minebotControlState: 'idle',
      entities: { 2: target }, inventory: { items: () => [{ name: 'stone_sword', count: 1 }, { name: 'mutton', count: 2 }], slots: [] }, heldItem: { name: 'mutton' },
      equip, setControlState: () => {}, pathfinder: { stop: () => {} },
      nearestEntity: (match: (entity: any) => boolean) => (match(target) ? target : null),
      // A meal between the blows puts mutton in hand.
      lookAt: async () => {}, attack: async () => { blows++; bot.heldItem = { name: 'mutton' }; if (blows >= 3) target.isValid = false; } };
    const skill: any = new AttackContinuously(bot);
    skill.shouldInterrupt = () => false;
    skill.collectNearbyDrops = async () => [];
    const result = await skill.runImpl('chicken', 10, 24, 1);
    expect(equip.mock.calls.length).toBeGreaterThanOrEqual(3);    // before every blow the hand had mutton again
    expect(result.result).toContain('stone_sword使用');
  });

  it('reads a sheep\'s colour and shearing from its metadata, and the color argument picks only those', async () => {
    const meta = (value: number) => { const m: unknown[] = []; m[17] = value; return m; };
    expect(sheepWool({ registry }, { metadata: meta(0) })).toEqual({ color: 'white', sheared: false });
    expect(sheepWool({ registry }, { metadata: meta(8) })).toEqual({ color: 'light_gray', sheared: false });
    expect(sheepWool({ registry }, { metadata: meta(0x10) })).toEqual({ color: 'white', sheared: true });
    const grey: any = { id: 2, name: 'sheep', position: new Vec3(1.5, 64, 0.5), height: 1.3, metadata: meta(8), isValid: true };
    const white: any = { id: 3, name: 'sheep', position: new Vec3(3.5, 64, 0.5), height: 1.3, metadata: meta(0), isValid: true };
    const struck: string[] = [];
    const bot: any = { registry, entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, health: 20, minebotControlState: 'idle',
      entities: { 2: grey, 3: white }, inventory: { items: () => [], slots: [] }, heldItem: null,
      equip: async () => {}, setControlState: () => {}, pathfinder: { stop: () => {} },
      nearestEntity: (match: (entity: any) => boolean) => [grey, white].filter(e => e.isValid && match(e))[0] ?? null,
      lookAt: async () => {}, attack: async (entity: any) => { struck.push(entity.metadata[17] === 0 ? 'white' : 'grey'); entity.isValid = false; } };
    const skill: any = new AttackContinuously(bot);
    skill.shouldInterrupt = () => false;
    skill.collectNearbyDrops = async () => [];
    await skill.runImpl('sheep', 10, 24, 1, false, 'white');
    expect(struck).toEqual(['white']);
    expect((await skill.runImpl('sheep', 10, 24, 1, false, 'purpleish')).failureType).toBe('invalid_input');
  });
});

describe('cooking what is raw: queued behind a smelt, started when the batch is taken out', () => {
  it('withdraw-from-furnace puts the queued raw food in once the furnace is empty', async () => {
    const inventory = Object.assign(new EventEmitter(), { items: () => [...counts].map(([name, count]) => ({ name, count })), emptySlotCount: () => 30 });
    const counts = new Map<string, number>([['mutton', 4], ['coal', 3]]);
    const furnace = Object.assign(new EventEmitter(), { fuel: 0, totalFuel: 10, inputItem: () => null, fuelItem: () => null,
      outputItem: () => (out ? { name: 'iron_ingot', count: 3 } : null), takeOutput: vi.fn(async () => { out = false; counts.set('iron_ingot', 3); inventory.emit('updateSlot'); }),
      takeInput: vi.fn(), takeFuel: vi.fn(), close: vi.fn() });
    let out = true;
    const bot: any = { version: '1.21.11', entity: { position: new Vec3(0, 64, 1) }, inventory, currentWindow: inventory, entities: {}, game: { dimension: 'overworld' },
      blockAt: () => ({ name: 'furnace' }), openFurnace: vi.fn(async () => furnace),
      activeFurnaces: [{ pos: { x: 0, y: 64, z: 0 }, item: 'raw_iron', count: 3, readyAt: Date.now(), startedAt: Date.now(), then: ['mutton'] }] };
    const skill: any = new WithdrawFromFurnace(bot);
    skill.callSkill = vi.fn(async (name: string, x: number, y: number, z: number, input: string, _fuel: string, count: number) => {
      bot.activeFurnaces.push({ pos: { x, y, z }, item: input, count, readyAt: Date.now() + count * 10_000, startedAt: Date.now() });
      return { success: true, result: 'started' };
    });
    const result: any = await skill.runImpl(0, 64, 0);
    expect(result.success).toBe(true);
    expect(skill.callSkill).toHaveBeenCalledWith('start-smelting', 0, 64, 0, 'mutton', 'coal', 4);
    expect(result.result).toContain('並べていたmutton×4を同じかまどで焼き始めました');
    // Without coal or charcoal the planks and logs are not burned unasked: said, not started.
    counts.delete('coal'); out = true; skill.callSkill.mockClear();
    bot.activeFurnaces = [{ pos: { x: 0, y: 64, z: 0 }, item: 'raw_iron', count: 3, readyAt: Date.now(), startedAt: Date.now(), then: ['mutton'] }];
    const noCoal: any = await skill.runImpl(0, 64, 0);
    expect(skill.callSkill).not.toHaveBeenCalled();
    expect(noCoal.result).toContain('石炭・木炭が無いため焼き始めていません');
  });
});

describe('the owner\'s second round (2026-10-20): wool to a bed, raw meat to a furnace, two furnaces, villages', () => {
  it('craft-one says the wool by colour and what is short when the colours make no bed; another colour that does is made', () => {
    const mixed = [{ name: 'white_wool', count: 2 }, { name: 'light_gray_wool', count: 1 }];
    const refused: any = bedFromWool(mixed, 'white_bed');
    expect(refused.refusal).toMatchObject({ success: false, failureType: 'bed_wool_mismatch', recoverable: true });
    expect(refused.refusal.result).toContain('今: white 2・light_gray 1');
    expect(refused.refusal.result).toMatch(/足りない: white_wool×1$/);
    expect((bedFromWool([], 'bed') as any).refusal.result).toMatch(/足りない: wool×3$/);
    expect(bedFromWool([{ name: 'red_wool', count: 3 }], 'white_bed')).toMatchObject({ itemName: 'red_bed' });
    expect(bedFromWool([{ name: 'white_wool', count: 3 }], 'white_bed')).toEqual({ itemName: 'white_bed', note: '' });
    expect(bedFromWool([{ name: 'white_wool', count: 4 }], 'bed')).toMatchObject({ itemName: 'white_bed' });
  });

  it('after sheep the hunt says whether the wool makes a bed now', () => {
    expect(woolStatusLine([{ name: 'white_wool', count: 3 }])).toContain('craft-one white_bed でベッドを作れる');
    expect(woolStatusLine([{ name: 'white_wool', count: 2 }, { name: 'light_gray_wool', count: 1 }])).toContain('同じ色があと1個（white');
    expect(woolStatusLine([{ name: 'white_wool', count: 3 }, { name: 'white_bed', count: 1 }])).toBe('');
  });

  it('the observation says where three pieces of raw meat can be cooked, or what stands in the way', () => {
    const now = 1_000_000;
    const body = (items: Array<{ name: string; count: number }>, furnaces: Array<{ x: number; y: number; z: number; distance: number }>, active: any[] = []) => ({
      inventory: { items: () => items }, activeFurnaces: active,
      placeMemory: { recall: (kind: string) => kind === 'furnace' ? furnaces.map(f => ({ position: { x: f.x, y: f.y, z: f.z }, distance: f.distance })) : [] },
    }) as any;
    const meat = [{ name: 'mutton', count: 4 }, { name: 'chicken', count: 2 }, { name: 'coal', count: 11 }, { name: 'cobblestone', count: 12 }];
    expect(cookRawNotice(body([{ name: 'mutton', count: 2 }], []), now)).toBeUndefined();
    expect(cookRawNotice(body(meat, [{ x: 28, y: 67, z: -1, distance: 6 }]), now)).toBe('生肉 mutton×4・chicken×2 → 空いているかまど(28,67,-1) 6m で焼ける（start-smelting、燃料 coal×11）');
    const busy = cookRawNotice(body(meat, [{ x: 28, y: 67, z: -1, distance: 6 }], [{ pos: { x: 28, y: 67, z: -1 }, item: 'raw_iron', readyAt: now + 40_000 }]), now)!;
    expect(busy).toContain('raw_iron を精錬中（残り約40秒）。2個目のかまどを置けば今すぐ焼ける（丸石8個、手持ち12個）');
    expect(cookRawNotice(body(meat, []), now)).toContain('かまどが無い');
    expect(cookRawNotice(body([{ name: 'mutton', count: 4 }], []), now)).toContain('燃料が無い');
    for (const line of [busy]) expect(line.length).toBeLessThanOrEqual(150);
  });

  it('start-smelting puts the batch into a free furnace within reach when the one asked for is busy, and says what to do meanwhile', async () => {
    const Chunk = (await import('prismarine-chunk')).default('1.21.11') as any;
    const chunk = new Chunk({ minY: -64, worldHeight: 384 });
    for (const [x, y, z, name] of [[1, 64, 0, 'furnace'], [2, 64, 0, 'furnace'], [8, 60, 3, 'iron_ore']] as const) chunk.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].defaultState);
    const counts = new Map<string, number>([['mutton', 4], ['coal', 5]]);
    const inventory = { items: () => [...counts].map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id })) };
    const furnace = (input: { name: string; count: number } | null) => ({ inputItem: () => input, fuelItem: () => null, outputItem: () => null,
      fuel: 0, progress: 0, close: vi.fn(), putInput: vi.fn(async () => {}), putFuel: vi.fn(async () => {}), takeOutput: vi.fn() });
    const busyFurnace = furnace({ name: 'raw_iron', count: 8 }), freeFurnace = furnace(null);
    const bot: any = { version: '1.21.11', registry, entity: { position: new Vec3(1.5, 64, 1.5) }, game: { dimension: 'overworld' }, inventory,
      world: { getColumns: () => [{ chunkX: 0, chunkZ: 0, column: chunk }] },
      blockAt: (p: Vec3) => ({ name: (p.x === 1 || p.x === 2) && p.y === 64 && p.z === 0 ? 'furnace' : 'air', position: p }),
      openFurnace: vi.fn(async (block: any) => block.position.x === 1 ? busyFurnace : freeFurnace),
      activeFurnaces: [{ pos: { x: 1, y: 64, z: 0 }, item: 'raw_iron', count: 8, readyAt: Date.now() + 80_000, startedAt: Date.now() }] };
    const { default: StartSmelting } = await import('../../src/services/minebot/instantSkills/startSmelting.js');
    const result: any = await new StartSmelting(bot).runImpl(1, 64, 0, 'mutton', 'coal', 4);
    expect(result.success).toBe(true);
    expect(result.result).toContain('かまど(1, 64, 0)は raw_iron×8 を精錬中のため、隣の空いているfurnace(2, 64, 0)を使いました');
    expect(freeFurnace.putInput).toHaveBeenCalled();
    expect(result.result).toContain('待たずにできること: 近くのiron_ore (8, 60, 3)');
  });

  it('a village is found in real 1.21.11 chunks (a bell; not a lone bed) by find-structure and the explore\'s check', async () => {
    const Chunk = (await import('prismarine-chunk')).default('1.21.11') as any;
    const { detectVillage } = await import('../../src/services/minebot/utils/landmarks.js');
    const { structureNearby } = await import('../../src/services/minebot/instantSkills/findStructure.js');
    const world = (chunk: any) => ({ entity: { position: new Vec3(0.5, 70, 0.5) }, registry, entities: {},
      world: { getColumns: () => [{ chunkX: 2, chunkZ: 1, column: chunk }] } }) as any;
    const village = new Chunk({ minY: -64, worldHeight: 384 });
    village.setBlockStateId(new Vec3(3, 70, 4), registry.blocksByName.bell.defaultState);
    const found = detectVillage(world(village));
    expect(found).toMatchObject({ kind: 'village', position: { x: 35, y: 70, z: 20 } });
    expect(structureNearby(world(village), 'village')?.position).toEqual({ x: 35, y: 70, z: 20 });
    const lone = new Chunk({ minY: -64, worldHeight: 384 });
    lone.setBlockStateId(new Vec3(3, 70, 4), registry.blocksByName.white_bed.defaultState);
    expect(detectVillage(world(lone))).toBeNull();
  });
});

describe('the flee with no way out falls back on a shelter where the body stands', () => {
  it('chooses the one-cell shelter with 10 blocks and 4 slabs and no enemy at arm\'s length, else a pillar with 3 blocks, else nothing', () => {
    const body = (count: number, slabs = 0) => ({ inventory: { items: () => [{ name: 'cobblestone', count }, ...(slabs ? [{ name: 'cobblestone_slab', count: slabs }] : [])] },
      instantSkills: { getSkill: () => ({}) } }) as any;
    expect(shelterChoice(body(20, 4), 4)).toEqual({ skill: 'build-around-self', args: ['slit_shelter'] });
    expect(shelterChoice(body(20, 4), 1.3)).toEqual({ skill: 'tower-up', args: [3] });   // the zombie's cell cannot take a block
    expect(shelterChoice(body(20), 4)).toEqual({ skill: 'build-around-self', args: ['slit_shelter'] });   // no slabs: whole blocks shut the slit
    expect(shelterChoice(body(12), 4)).toEqual({ skill: 'tower-up', args: [3] });        // no slabs, too few for that
    expect(shelterChoice(body(5))).toEqual({ skill: 'tower-up', args: [3] });
    expect(shelterChoice(body(2))).toBeNull();
  });
});

describe('a walk through rock is given the time its digging takes (run 16: a 37 m tunnel cut off at 30 s)', () => {
  it('adds the dig time of each solid cell on the straight line, at the tool the route would choose', () => {
    const stone = { name: 'stone', boundingBox: 'block', diggable: true, digTime: () => 600 };
    const ms = tunnelDigMs({ blockAt: () => stone, inventory: { items: () => [] } }, { x: 0, y: 10, z: 0 }, { x: 10, y: 10, z: 0 }, () => null);
    expect(ms).toBe(20 * (600 + 250));            // ten steps, two cells each
    expect(tunnelDigMs({ blockAt: () => ({ name: 'air', boundingBox: 'empty' }) }, { x: 0, y: 10, z: 0 }, { x: 10, y: 10, z: 0 }, () => null)).toBe(0);
  });
});
