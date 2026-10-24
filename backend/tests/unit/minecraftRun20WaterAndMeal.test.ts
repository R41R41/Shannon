import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: vi.fn(async () => ({ success: true })) }));

const { default: UseItemOnBlock } = await import('../../src/services/minebot/instantSkills/useItemOnBlock.js');
const { default: UseItem } = await import('../../src/services/minebot/instantSkills/useItem.js');
const { gotoSafe } = await import('../../src/services/minebot/utils/gotoSafe.js');

// ── a small world: stone below y 64, air above, water cells listed by hand ──────────────────────────────────────────────────────────────
interface Pond { cells: Array<[number, number, number]>; level?: number }
function world(options: { ponds?: Pond[]; roofs?: Array<(p: Vec3) => boolean>; extra?: (p: Vec3) => string | null } = {}) {
  const water = new Map<string, number>();
  for (const pond of options.ponds ?? []) for (const [x, y, z] of pond.cells) water.set(`${x},${y},${z}`, pond.level ?? 0);
  const overrides = new Map<string, string>();
  const nameAt = (p: Vec3): string => {
    const key = `${p.x},${p.y},${p.z}`;
    if (overrides.has(key)) return overrides.get(key)!;
    if (water.has(key)) return 'water';
    const extra = options.extra?.(p);
    if (extra) return extra;
    if (options.roofs?.some(roof => roof(p))) return 'stone';
    return p.y <= 63 ? 'stone' : 'air';
  };
  const blockAt = (p: Vec3) => {
    const at = p.floored();
    const name = nameAt(at);
    return { name, position: at, boundingBox: name === 'air' || name === 'water' || name === 'short_grass' ? 'empty' : 'block', stateId: 1, type: 1,
      getProperties: () => ({ level: water.get(`${at.x},${at.y},${at.z}`) ?? 0 }) };
  };
  return { blockAt, water, overrides,
    findBlocks: ({ maxDistance, count, point, useExtraInfo }: any, from: Vec3) => [...water.keys()].map(key => new Vec3(...(key.split(',').map(Number) as [number, number, number])))
      .filter(at => nameAt(at) === 'water' && at.distanceTo(point ?? from) <= maxDistance && (!useExtraInfo || useExtraInfo(blockAt(at))))
      .sort((a, b) => a.distanceTo(from) - b.distanceTo(from)).slice(0, count) };
}

function bodyIn(w: ReturnType<typeof world>, items: Array<{ name: string; count: number }>, at = new Vec3(0.5, 64, 0.5), extra: object = {}) {
  const bot: any = {
    version: '1.21.4', game: { dimension: 'overworld' }, registry: { blocksByName: { water: { id: 99 } } },
    entity: { position: at, yaw: 0, pitch: 0 }, heldItem: null, interruptExecution: false,
    inventory: { items: () => items.filter(item => item.count > 0) },
    blockAt: w.blockAt,
    findBlocks: (opts: any) => w.findBlocks(opts, bot.entity.position),
    equip: vi.fn(async (item: any) => { bot.heldItem = item; }),
    lookAt: vi.fn(async (point: Vec3) => { bot.lookTarget = point; }),
    _client: { write: () => {} },
    dig: vi.fn(async (block: any) => { w.overrides.set(`${block.position.x},${block.position.y},${block.position.z}`, 'water'); w.water.set(`${block.position.x},${block.position.y},${block.position.z}`, 0); }),
    activateItem: vi.fn(() => {
      const point: Vec3 | undefined = bot.lookTarget;
      if (!point || bot.heldItem?.name !== 'bucket') return;
      const eyes = bot.entity.position.offset(0, 1.62, 0);
      const cell = point.floored();
      // The server's ray is cast against outlines: anything but air and water on the way (grass included) stops it.
      const eyeCell = eyes.floored();
      let stopped = false;
      for (let t = 0.02; t < 1; t += 0.02) {
        const at = eyes.plus(point.minus(eyes).scaled(t)).floored();
        if (at.equals(cell) || at.equals(eyeCell)) continue;
        if (!['air', 'water'].includes(w.blockAt(at).name)) { stopped = true; break; }
      }
      if (!stopped && w.blockAt(cell).name === 'water' && w.water.get(`${cell.x},${cell.y},${cell.z}`) === 0 && eyes.distanceTo(point) <= 4.5) {
        const bucket = items.find(item => item.name === 'bucket')!;
        bucket.count--;
        const filled = { name: 'water_bucket', count: 1 };
        items.push(filled); bot.heldItem = filled;
        w.water.delete(`${cell.x},${cell.y},${cell.z}`);
      }
    }),
    ...extra,
  };
  // Walking: the body is carried to the goal cell.
  vi.mocked(gotoSafe).mockImplementation(async (_bot: any, goal: any) => { bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); return { success: true }; });
  return bot;
}
const bucketPack = () => [{ name: 'bucket', count: 1 }, { name: 'iron_pickaxe', count: 1 }];
// The first test world: a pond of 5 x 5 at y 63, x 12..16.
const pond = (x0 = 12, z0 = -2, size = 5, y = 63): Pond => ({ cells: Array.from({ length: size * size }, (_, i) => [x0 + (i % size), y, z0 + Math.floor(i / size)] as [number, number, number]) });

describe('an empty bucket finds, reaches and scoops water by itself (run 20: the bucket was made and no water was taken on the surface)', () => {
  it('with no coordinates: the nearest open source, a walk to its bank, water_bucket in the hand, and the result says to carry it down', async () => {
    const w = world({ ponds: [pond()] });
    const bot = bodyIn(w, bucketPack());
    bot.heldItem = bot.inventory.items()[0];
    const result: any = await new UseItemOnBlock(bot).runImpl(undefined, undefined, undefined, 'bucket');
    expect(result.success).toBe(true);
    expect(result.result).toContain('water_bucket');
    expect(result.result).toContain('地下では水を探さず');
    expect(bot.heldItem.name).toBe('water_bucket');
    expect(vi.mocked(gotoSafe)).toHaveBeenCalled();
    // It stood on the bank, not in the pond.
    expect(bot.entity.position.x).toBeLessThan(12);
  });

  it('the same with null coordinates (how the planner\'s schema sends an omitted value), and from a bank it already stands on without a walk', async () => {
    const w = world({ ponds: [pond(3, -2)] });
    const bot = bodyIn(w, bucketPack(), new Vec3(2.5, 64, 0.5));
    bot.heldItem = bot.inventory.items()[0];
    vi.mocked(gotoSafe).mockClear();
    const result: any = await new UseItemOnBlock(bot).runImpl(null, null, null, 'bucket', 0, 48);
    expect(result).toMatchObject({ success: true, result: expect.stringContaining('water_bucket') });
    expect(vi.mocked(gotoSafe)).not.toHaveBeenCalled();
  });

  it('with a coordinate: a cell one above the surface, one below it, and a flowing cell each lead to a source, and the note says so', async () => {
    const make = () => { const w = world({ ponds: [pond(), { cells: [[11, 63, 0]], level: 3 }] }); const bot = bodyIn(w, bucketPack()); bot.heldItem = bot.inventory.items()[0]; return bot; };
    const above: any = await new UseItemOnBlock(make()).runImpl(14, 64, 0, 'bucket');
    expect(above).toMatchObject({ success: true, result: expect.stringContaining('1つ上') });
    const flowing: any = await new UseItemOnBlock(make()).runImpl(11, 63, 0, 'bucket');
    expect(flowing).toMatchObject({ success: true, result: expect.stringContaining('水流') });
    // The old refusal ("this is flowing water, search for a source") is gone: the body does the search.
    expect(flowing.result).not.toContain('find-blocksで水源ブロックを探してください');
    const exact: any = await new UseItemOnBlock(make()).runImpl(14, 63, 0, 'bucket');
    expect(exact.success).toBe(true);
  });

  it('a far named cell (40 m) is walked to; a wrong coordinate far from any water still finds the nearest water', async () => {
    const w = world({ ponds: [pond(40, -2)] });
    const bot = bodyIn(w, bucketPack());
    bot.heldItem = bot.inventory.items()[0];
    const result: any = await new UseItemOnBlock(bot).runImpl(42, 63, 0, 'bucket');
    expect(result.success).toBe(true);
    expect(bot.entity.position.x).toBeGreaterThan(30);
    const w2 = world({ ponds: [pond(20, -2)] });
    const bot2 = bodyIn(w2, bucketPack());
    bot2.heldItem = bot2.inventory.items()[0];
    const elsewhere: any = await new UseItemOnBlock(bot2).runImpl(-30, 64, 5, 'bucket');
    expect(elsewhere.success).toBe(true);
    expect(elsewhere.result).toContain('water_bucket');
  });

  it('open water is chosen over nearer water in a cave, and a source with no bank in reach is reached from the water (a pond with no dry cell around it)', async () => {
    // A cave pond 6 m away under a roof; an open pond 16 m away.
    const roof = (p: Vec3) => p.y >= 65 && p.y <= 70 && p.x >= 3 && p.x <= 10 && p.z >= -4 && p.z <= 4;
    const w = world({ ponds: [{ cells: [[7, 63, 0]] }, pond(16, -2)], roofs: [roof] });
    const bot = bodyIn(w, bucketPack());
    bot.heldItem = bot.inventory.items()[0];
    const result: any = await new UseItemOnBlock(bot).runImpl(undefined, undefined, undefined, 'bucket');
    expect(result.success).toBe(true);
    expect(result.result).toMatch(/\((1[2-9]|2\d),63,/u);
  });

  it('water under ice: the ice is broken and the water taken', async () => {
    const w = world({ ponds: [pond()], extra: p => (p.y === 64 && p.x >= 12 && p.x <= 16 && p.z >= -2 && p.z <= 2 ? 'ice' : null) });
    const bot = bodyIn(w, bucketPack());
    bot.heldItem = bot.inventory.items()[0];
    const result: any = await new UseItemOnBlock(bot).runImpl(undefined, undefined, undefined, 'bucket');
    expect(bot.dig).toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, result: expect.stringContaining('氷を割って') });
  });

  it('no water in reach: a reason, a next step, and the remembered water is tried before giving up', async () => {
    const empty = world({});
    const none = bodyIn(empty, bucketPack());
    none.heldItem = none.inventory.items()[0];
    const failed: any = await new UseItemOnBlock(none).runImpl(undefined, undefined, undefined, 'bucket');
    expect(failed).toMatchObject({ success: false, failureType: 'target_not_found', recoverable: true });
    expect(failed.result).toContain('方角');
    expect(failed.result).toContain('地上');

    // Water 100 m away is in the body's memory only; the walk toward it brings it into the loaded range.
    const far = world({ ponds: [pond(100, -2)] });
    const bot = bodyIn(far, bucketPack(), new Vec3(0.5, 64, 0.5), {
      placeMemory: { recall: () => [{ position: { x: 100, y: 63, z: 0 }, distance: 100, direction: '東' }] } });
    bot.heldItem = bot.inventory.items()[0];
    const remembered: any = await new UseItemOnBlock(bot).runImpl(undefined, undefined, undefined, 'bucket');
    expect(remembered.success).toBe(true);
    expect(bot.entity.position.x).toBeGreaterThan(90);
  });

  it('without a bucket it says what makes one; with water already carried it says so and asks for nothing', async () => {
    const w = world({ ponds: [pond()] });
    const none = bodyIn(w, [{ name: 'iron_ingot', count: 5 }]);
    const missing: any = await new UseItemOnBlock(none).runImpl(undefined, undefined, undefined, 'bucket');
    expect(missing).toMatchObject({ success: false, failureType: 'material_missing' });
    expect(missing.result).toContain('バケツを持っていません（鉄 3 個で craft-one bucket');
    const named: any = await new UseItemOnBlock(none).runImpl(14, 63, 0, 'bucket');
    expect(named.result).toContain('craft-one bucket');

    const full = bodyIn(w, [{ name: 'water_bucket', count: 1 }]);
    const already: any = await new UseItemOnBlock(full).runImpl(undefined, undefined, undefined, 'bucket');
    expect(already).toMatchObject({ success: true, result: expect.stringContaining('すでに水入りのバケツ') });
  });

  it('grass and flowers on the bank stop the server\'s ray though a body walks through them: the aim is not taken through them (lab: three uses did nothing, the fourth point worked)', async () => {
    // A hedge of short grass two blocks thick along the whole bank, between the body and the pond.
    const w = world({ ponds: [pond()], extra: p => (p.y === 64 && p.x >= 9 && p.x <= 10 ? 'short_grass' : null) });
    const bot = bodyIn(w, bucketPack(), new Vec3(8.5, 64, 0.5));
    bot.heldItem = bot.inventory.items()[0];
    const result: any = await new UseItemOnBlock(bot).runImpl(undefined, undefined, undefined, 'bucket');
    expect(result.success).toBe(true);
    // The fake server would have refused any aim through the hedge: the body went past it.
    expect(bot.entity.position.x).toBeGreaterThanOrEqual(9);
  });

  it('water in sight but no way to its bank: movement_incomplete with the nearest source, not "no water found"', async () => {
    const w = world({ ponds: [pond(30, -2)] });
    const bot = bodyIn(w, bucketPack());
    bot.heldItem = bot.inventory.items()[0];
    vi.mocked(gotoSafe).mockImplementation(async () => ({ success: false }));
    const result: any = await new UseItemOnBlock(bot).runImpl(undefined, undefined, undefined, 'bucket');
    expect(result).toMatchObject({ success: false, failureType: 'movement_incomplete', recoverable: true });
    expect(result.result).toContain('水源は見えています');
    expect(result.result).toContain('move-to');
  });

  it('a bucket that does nothing from one cell is tried from another stand after two sources, and the late word of the server is not poured back', async () => {
    const { SCOOP_WAIT } = await import('../../src/services/minebot/utils/scoopWater.js');
    SCOOP_WAIT.first = 20; SCOOP_WAIT.next = 20;
    const w = world({ ponds: [pond()] });
    const bot = bodyIn(w, bucketPack(), new Vec3(9.5, 64, 0.5));
    bot.heldItem = bot.inventory.items()[0];
    // The server takes no use from x < 10 (a position it does not agree with), and works from the next stand.
    const real = bot.activateItem;
    bot.activateItem = vi.fn(() => { if (bot.entity.position.x >= 10) real(); });
    const result: any = await new UseItemOnBlock(bot).runImpl(undefined, undefined, undefined, 'bucket');
    expect(result.success).toBe(true);
    expect(bot.entity.position.x).toBeGreaterThanOrEqual(10);
    // The water arrived after the wait ran out: the next point does not use the water bucket on the water again.
    const late = bodyIn(world({ ponds: [pond()] }), bucketPack(), new Vec3(10.5, 64, 0.5));
    late.heldItem = late.inventory.items()[0];
    const first = late.activateItem;
    let calls = 0, usedWithWater = 0;
    late.activateItem = vi.fn(() => { calls++; if (late.heldItem?.name === 'water_bucket') usedWithWater++; if (calls === 1) setTimeout(() => first(), 70); });
    const outcome: any = await new UseItemOnBlock(late).runImpl(undefined, undefined, undefined, 'bucket');
    expect(outcome.success).toBe(true);
    expect(late.heldItem.name).toBe('water_bucket');
    expect(usedWithWater).toBe(0);
    SCOOP_WAIT.first = 1500; SCOOP_WAIT.next = 1000;
  });

  it('coordinates may be left out only for a bucket', async () => {
    const w = world({});
    const bot = bodyIn(w, [{ name: 'water_bucket', count: 1 }]);
    bot.heldItem = bot.inventory.items()[0];
    const result: any = await new UseItemOnBlock(bot).runImpl(undefined, undefined, undefined, 'water_bucket');
    expect(result).toMatchObject({ success: false, failureType: 'invalid_input' });
    const partial: any = await new UseItemOnBlock(bot).runImpl(1, undefined, 3, 'bucket');
    expect(partial.success).toBe(false);
  });

  it('the schema offers x, y, z as optional and a maxDistance', () => {
    const skill: any = new UseItemOnBlock({ version: '1.21.4', inventory: { items: () => [] } } as any);
    const required = skill.params.filter((param: any) => param.required).map((param: any) => param.name);
    expect(required).toEqual([]);
    expect(skill.params.map((param: any) => param.name)).toEqual(['x', 'y', 'z', 'itemName', 'count', 'maxDistance']);
  });

  it('the planner\'s catalog takes {itemName: "bucket"} alone, with x, y, z left out, and still takes the old call with coordinates', async () => {
    const { bodySkillCatalog } = await import('../../src/services/minebot/integration/commonFca/skillCatalog.js');
    const skill: any = new UseItemOnBlock({ version: '1.21.4', inventory: { items: () => [] } } as any);
    const catalog = bodySkillCatalog([skill], {});
    const schema: any = catalog.runnable.find(skill => skill.name === 'use-item-on-block')!.inputSchema;
    expect(schema.required).toEqual([]);
    expect(Object.keys(schema.properties)).toEqual(['x', 'y', 'z', 'itemName', 'count', 'maxDistance']);
    expect(catalog.resolve('use-item-on-block', { itemName: 'bucket' }).args).toEqual([undefined, undefined, undefined, 'bucket', 0, 48]);
    expect(catalog.resolve('use-item-on-block', { x: 1, y: 2, z: 3, itemName: 'water_bucket', count: 10 }).args).toEqual([1, 2, 3, 'water_bucket', 10, 48]);
    expect(catalog.resolve('use-item-on-block', { x: null, y: null, z: null, itemName: 'bucket' }).args).toEqual([undefined, undefined, undefined, 'bucket', 0, 48]);
  });
});

// ── eating ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('use-item on food judges by the pack and the bar, waits for a meal already under way, and says why it did not eat (run 20: food 12, "could not eat")', () => {
  const eater = (food: number, options: { consume?: (bot: any) => Promise<void>; using?: boolean; item?: string; count?: number } = {}) => {
    const stack = { name: options.item ?? 'beef', count: options.count ?? 3, type: 1 };
    const sword = { name: 'stone_sword', count: 1, type: 2 };
    const bot: any = { version: '1.21.4', food, heldItem: sword, usingHeldItem: options.using ?? false, interruptExecution: false,
      inventory: { items: () => [...(stack.count > 0 ? [stack] : []), sword] },
      equip: vi.fn(async (item: any) => { bot.heldItem = item; }), stack, sword };
    bot.consume = vi.fn(() => (options.consume ?? (async () => { stack.count--; bot.food = Math.min(20, bot.food + 3); }))(bot));
    return bot;
  };
  const skillOf = (bot: any) => { const skill: any = new UseItem(bot); skill.settleMs = 300; return skill; };

  it('a meal the body\'s reflex is chewing is waited for, and a second consume() is not started on top of it', async () => {
    const bot = eater(12, { using: true });
    setTimeout(() => { bot.stack.count--; bot.food = 19; bot.usingHeldItem = false; }, 350);
    const result: any = await skillOf(bot).runImpl('beef');
    expect(result.success).toBe(true);
    expect(result.result).toContain('先に食べ終えた');
    expect(bot.consume).not.toHaveBeenCalled();
  });

  it('a meal the reflex was chewing that leaves the bar low is followed by our own meal', async () => {
    const bot = eater(8, { using: true });
    setTimeout(() => { bot.food = 11; bot.usingHeldItem = false; }, 150);
    const result: any = await skillOf(bot).runImpl('beef');
    expect(result.success).toBe(true);
    expect(bot.consume).toHaveBeenCalledTimes(1);
    expect(result.result).toContain('11→');
  });

  it('our wait cancelled by the reflex\'s own consume() is no failure when the server finishes the meal a moment later', async () => {
    const bot = eater(12, { consume: async b => { setTimeout(() => { b.stack.count--; b.food = 15; }, 200); throw new Error('Consuming cancelled due to calling bot.consume() again'); } });
    const result: any = await skillOf(bot).runImpl('beef');
    expect(result).toMatchObject({ success: true, result: expect.stringContaining('12→15') });
    expect(bot.consume).toHaveBeenCalledTimes(1);
  });

  it('a slow report of the pack (the item gone, the bar late) is waited for, not read as 19→19', async () => {
    const bot = eater(12, { consume: async b => { b.stack.count--; setTimeout(() => { b.food = 18; }, 250); } });
    const result: any = await skillOf(bot).runImpl('beef');
    expect(result.result).toContain('12→18');
    expect(result.success).toBe(true);
  });

  it('a full bar needs no meal: a success that says so, the hand untouched, and golden apples are still eaten', async () => {
    const full = eater(20);
    const result: any = await skillOf(full).runImpl('beef');
    expect(result).toMatchObject({ success: true, result: expect.stringContaining('満腹度 20/20のため') });
    expect(result.failureType).toBeUndefined();
    expect(full.consume).not.toHaveBeenCalled();
    expect(full.equip).not.toHaveBeenCalled();
    const gold = eater(20, { item: 'golden_apple', consume: async b => { b.stack.count--; } });
    expect(await skillOf(gold).runImpl('golden_apple')).toMatchObject({ success: true, result: expect.stringContaining('食べました') });
  });

  it('taken out of the hand during the meal: interrupted_by_reflex with the reason', async () => {
    const bot = eater(12, { consume: async b => { b.heldItem = b.sword; throw new Error('Promise timed out.'); } });
    const result: any = await skillOf(bot).runImpl('beef');
    expect(result).toMatchObject({ success: false, failureType: 'interrupted_by_reflex', recoverable: true });
    expect(result.result).toContain('stone_sword');
    expect(result.result).toContain('反射');
  });

  it('cut by another consume() with nothing eaten: interrupted_by_reflex', async () => {
    const bot = eater(12, { consume: async () => { throw new Error('Consuming cancelled due to calling bot.consume() again'); } });
    const result: any = await skillOf(bot).runImpl('beef');
    expect(result).toMatchObject({ success: false, failureType: 'interrupted_by_reflex' });
  });

  it('a first consume() that did nothing is tried once more; a real stall says the reason, the bar, the hand and the tries', async () => {
    let calls = 0;
    const second = eater(10, { consume: async b => { if (++calls === 2) { b.stack.count--; b.food = 13; } } });
    expect(await skillOf(second).runImpl('beef')).toMatchObject({ success: true });
    expect(second.consume).toHaveBeenCalledTimes(2);
    const stuck = eater(8, { consume: async () => { throw new Error('Promise timed out.'); } });
    const result: any = await skillOf(stuck).runImpl('beef');
    expect(result).toMatchObject({ success: false, failureType: 'not_consumed', recoverable: true });
    expect(result.result).toContain('Promise timed out');
    expect(result.result).toContain('満腹度 8/20');
    expect(result.result).toContain('2回試しました');
  });

  it('cancelled by the executor: interrupted', async () => {
    const bot = eater(10, { consume: async b => { b.interruptExecution = true; throw new Error('Action interrupted'); } });
    expect(await skillOf(bot).runImpl('beef')).toMatchObject({ success: false, failureType: 'interrupted' });
  });
});
