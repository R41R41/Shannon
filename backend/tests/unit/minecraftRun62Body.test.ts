import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

// Run 62 (2026-11-04): the body's fixes. The last pickaxe of a kind is not thrown (1,756 s: two spare stone pickaxes thrown for room, then the
// iron one broke and she dug bare-handed); a dig the planner asked for behind one or two ordinary blocks of a wall digs those first (282–667 s,
// the village's beds: not_visible six times).
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/digBlockVerified.js')>();
  return { ...actual, digBlockVerified: vi.fn(async (bot: any, block: any) => { bot.__dug.push(`${block.position.x},${block.position.y},${block.position.z}`); bot.__blocks.set(`${block.position.x},${block.position.y},${block.position.z}`, { name: 'air', boundingBox: 'empty' }); return { stateId: 0, blockName: 'air' }; }) };
});

const { dig } = await import('../../src/services/minebot/utils/primitives/dig.js');
const { drop } = await import('../../src/services/minebot/utils/primitives/body.js');
const { closedWord } = await import('../../src/services/minebot/utils/actReport.js');

/** A fake body: blocks from a map (stone under y 64, air from 64). */
function body() {
  const blocks = new Map<string, any>();
  const bot: any = Object.assign(new EventEmitter(), {
    __blocks: blocks, __dug: [] as string[],
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true },
    health: 20, food: 20, game: { dimension: 'overworld' }, entities: {} as Record<number, any>,
    registry: { blocksByName: { cobblestone: { id: 1 }, stone: { id: 2 } }, itemsByName: {}, items: {} },
    inventory: { items: () => [] as any[], slots: new Array(46).fill(null) },
    heldItem: null,
    blockAt: (p: Vec3) => {
      const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      const position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      if (blocks.has(key)) return { diggable: true, hardness: 1, ...blocks.get(key), position };
      return position.y < 64 ? { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5, position } : { name: 'air', boundingBox: 'empty', position };
    },
    setControlState: () => undefined, clearControlStates: () => undefined, stopDigging: () => undefined,
  });
  return bot;
}
const ctx = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 30_000, facing: 'north' as const, base: { x: 0, y: 64, z: 0 } }) as any;
const stone = { name: 'stone', boundingBox: 'block' };

describe('dig openSight: the wall in front of a cell asked for is dug first (run 62: beds behind a house wall, not_visible ×6)', () => {
  it('a bed behind the cobblestone of a house wall: the wall block in the way, then the bed; only the bed counts as dug', async () => {
    const bot = body();
    bot.__blocks.set('1,64,0', { name: 'cobblestone', boundingBox: 'block' });
    bot.__blocks.set('1,65,0', { name: 'cobblestone', boundingBox: 'block' });
    bot.__blocks.set('2,64,0', { name: 'red_bed', boundingBox: 'block' });
    const out = await dig(ctx(bot), { at: [{ x: 2, y: 64, z: 0 }], collect: false, take: true, openSight: true });
    expect(out.ok).toBe(true);
    expect(bot.__dug.at(-1)).toBe('2,64,0');
    expect(bot.__dug.slice(0, -1).every((key: string) => ['1,64,0', '1,65,0'].includes(key))).toBe(true);
    expect(bot.__dug.length).toBeGreaterThan(1);
    expect(out.progress).toMatchObject({ done: 1, left: 0 });
    expect(out.text).toMatch(/\(1,6[45],0\) cobblestone を掘った（\(2,64,0\) の red_bed を見るため、/u);
  });

  it('without openSight the same wall still stops not_visible (mine, go and the reflexes keep their ways)', async () => {
    const bot = body();
    bot.__blocks.set('1,64,0', { name: 'cobblestone', boundingBox: 'block' });
    bot.__blocks.set('1,65,0', { name: 'cobblestone', boundingBox: 'block' });
    bot.__blocks.set('2,64,0', { name: 'red_bed', boundingBox: 'block' });
    const out = await dig(ctx(bot), { at: [{ x: 2, y: 64, z: 0 }], collect: false, take: true });
    expect(out.reason).toBe('not_visible');
    expect(bot.__dug).toEqual([]);
  });

  it('a chest in the way still stops: it is not dug to see past it', async () => {
    const bot = body();
    bot.__blocks.set('1,64,0', { name: 'chest', boundingBox: 'block' });
    bot.__blocks.set('1,65,0', { name: 'chest', boundingBox: 'block' });
    bot.__blocks.set('2,64,0', stone);
    const out = await dig(ctx(bot), { at: [{ x: 2, y: 64, z: 0 }], collect: false, openSight: true });
    expect(out.ok).toBe(false);
    expect(bot.__dug).toEqual([]);
  });

  it('a cell deep in the rock (more than two blocks between) is not tunnelled to', async () => {
    const bot = body();
    for (const key of ['1,64,0', '1,65,0', '2,64,0', '2,65,0', '3,64,0', '3,65,0', '4,64,0']) bot.__blocks.set(key, stone);
    const out = await dig(ctx(bot), { at: [{ x: 4, y: 64, z: 0 }], collect: false, openSight: true });
    expect(out.reason).toBe('not_visible');
    expect(bot.__dug).toEqual([]);
  });
});

/** A pack of pickaxes and cobblestone, one slot each; toss and tossStack take from it. */
function packer(items: Array<{ name: string; count: number; durabilityUsed?: number; maxDurability?: number }>) {
  const pack = items.map((item, slot) => ({ type: slot + 1, slot, ...item }));
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true }, entities: {}, game: { dimension: 'overworld' },
    inventory: { items: () => pack.filter(item => item.count > 0) },
    blockAt: (p: Vec3) => {
      const y = Math.floor(p.y);
      return { name: y < 64 ? 'stone' : 'air', boundingBox: y < 64 ? 'block' : 'empty', position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)) };
    },
    lookAt: vi.fn(async () => undefined),
    toss: vi.fn(async (type: number, _meta: unknown, count: number) => {
      let left = count;
      for (const item of pack) if (item.type === type || pack.find(other => other.type === type)?.name === item.name) { const take = Math.min(left, item.count); item.count -= take; left -= take; }
    }),
    tossStack: vi.fn(async (item: any) => { pack.find(entry => entry.slot === item.slot)!.count = 0; }),
  });
  return { bot, pack };
}

describe('drop: the last pickaxe of a kind stays (run 62: 1,756 s two stone pickaxes thrown, the iron one broke, bare hands)', () => {
  it('asked for all the stone pickaxes: all but the best go, and the line says why one stays', async () => {
    const { bot, pack } = packer([
      { name: 'stone_pickaxe', count: 1, durabilityUsed: 129, maxDurability: 131 },
      { name: 'stone_pickaxe', count: 1, durabilityUsed: 20, maxDurability: 131 },
      { name: 'cobblestone', count: 40 },
    ]);
    const out = await drop(ctx(bot), { items: [{ item: 'stone_pickaxe' }] });
    expect(out.ok).toBe(true);
    expect(bot.tossStack).toHaveBeenCalledTimes(1);
    expect(pack.filter(item => item.name === 'stone_pickaxe' && item.count > 0).map(item => item.durabilityUsed)).toEqual([20]);
    expect(out.text).toContain('stone_pickaxe×1 を投げた（残り1）');
    expect(out.text).toContain('stone_pickaxe の最後の 1 本は投げない');
    expect(out.progress).toMatchObject({ done: 1, left: 0 });
  });

  it('asked for only the last one: nothing is thrown, a stop that says why (守られた物)', async () => {
    const { bot } = packer([{ name: 'iron_pickaxe', count: 1, durabilityUsed: 10, maxDurability: 250 }, { name: 'cobblestone', count: 40 }]);
    const out = await drop(ctx(bot), { items: [{ item: 'iron_pickaxe', count: 1 }] });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('last_pickaxe_kept');
    expect(closedWord(out.reason)).toBe('守られた物');
    expect(out.text).toContain('空きが要るなら丸石・土・砂利など別の物を投げる');
    expect(bot.toss).not.toHaveBeenCalled();
    expect(bot.tossStack).not.toHaveBeenCalled();
  });

  it('a pickaxe kept beside cobblestone thrown: the cobblestone goes, the drop is ok, the pickaxe is said kept', async () => {
    const { bot, pack } = packer([{ name: 'wooden_pickaxe', count: 1, durabilityUsed: 0, maxDurability: 59 }, { name: 'cobblestone', count: 40 }]);
    const out = await drop(ctx(bot), { items: [{ item: 'wooden_pickaxe' }, { item: 'cobblestone' }] });
    expect(out.ok).toBe(true);
    expect(pack.find(item => item.name === 'wooden_pickaxe')!.count).toBe(1);
    expect(pack.find(item => item.name === 'cobblestone')!.count).toBe(0);
    expect(out.text).toContain('cobblestone×40 を投げた');
    expect(out.text).toContain('wooden_pickaxe の最後の 1 本は投げない');
  });
});
