import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

// Run 22 (2026-10-21 12:16 and 12:20): with a pack full of rock, a dig (making obsidian with use-item-on-block, the floor of a bed)
// held the process at 100% CPU for 200 s. dig-block-at's tidy threw through drop-item, drop-item dug its pit through dig-block-at,
// and that dig's tidy did not see the first one's hold: the hold was kept on the motor port, a new Proxy for every nested call (and
// one Proxy deeper each time). Round and round on microtasks only, so no timer (abort, time-out) could stop it.

vi.mock('../../src/services/minebot/execution/observedWait.js', async (original) => ({
  ...(await original() as object), actionDelay: vi.fn(async () => {}),
}));

const { createMotorPort, executeAction, nativeActionHost, MAX_NESTED_ACTIONS } = await import('../../src/services/minebot/execution/ActionExecution.js');
const { liquidNearPit } = await import('../../src/services/minebot/utils/dumpPit.js');
const { repairTierToolMaterials } = await import('../../src/services/minebot/utils/registryRepairs.js');
const { default: DropItem } = await import('../../src/services/minebot/instantSkills/dropItem.js');
const { default: DigBlockAt } = await import('../../src/services/minebot/instantSkills/digBlockAt.js');

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.21.11');
repairTierToolMaterials(registry);
const Block = require('prismarine-block')(registry);

const stacks = (name: string, n: number, size = 64) => Array.from({ length: n }, () => ({ name, count: size, type: registry.itemsByName[name].id }));
function room(items: any[]) { return { inventory: { items: () => items, emptySlotCount: () => 36 - items.length } } as any; }

/**
 * A 1x2 tunnel along x (x -8..8, y 64-65, z 0) in stone, the body at its middle with a full pack: 30 stacks of cobblestone and tuff,
 * a stone pickaxe, filler. Its own drop-item and dig-block-at are the real skills; the pickaxe never digs (the server is not there),
 * so a pit is never finished. `lava` puts lava cells into the rock.
 */
function tunnelBody(lava: Vec3[] = []) {
  const pack: any[] = [...stacks('cobblestone', 16), ...stacks('tuff', 14), { name: 'stone_pickaxe', count: 1, type: registry.itemsByName.stone_pickaxe.id,
    maxDurability: 131, durabilityUsed: 0 }, ...stacks('torch', 3)];
  const lavaAt = new Set(lava.map(at => `${at.x},${at.y},${at.z}`));
  const blockAt = (at: Vec3) => {
    const p = at.floored();
    const name = lavaAt.has(`${p.x},${p.y},${p.z}`) ? 'lava'
      : (p.z === 0 && (p.y === 64 || p.y === 65) && p.x >= -8 && p.x <= 8) ? 'air' : 'stone';
    const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0);
    block.position = p;
    return block;
  };
  const bot: any = Object.assign(new EventEmitter(), {
    registry, health: 20, food: 20, entities: {}, username: 'shannon',
    entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8, onGround: true, velocity: new Vec3(0, 0, 0) },
    inventory: { items: () => pack, emptySlotCount: () => 36 - pack.length, slots: [] },
    blockAt,
    toss: vi.fn(async (type: number, _meta: unknown, count: number) => {
      let left = count;
      for (const entry of [...pack]) if (entry.type === type && left > 0) { const take = Math.min(left, entry.count); entry.count -= take; left -= take; if (!entry.count) pack.splice(pack.indexOf(entry), 1); }
    }),
    equip: vi.fn(async () => {}), lookAt: vi.fn(async () => {}), look: vi.fn(async () => {}),
    dig: vi.fn(async () => { throw new Error('test: no server to dig on'); }), stopDigging: vi.fn(), clearControlStates: vi.fn(),
    pathfinder: { stop: vi.fn(), setGoal: vi.fn(), goto: vi.fn(async () => { throw new Error('test: no walking'); }) },
    heldItem: null,
  });
  const drop = new DropItem(bot);
  const dig = new DigBlockAt(bot);
  const other = { run: vi.fn(async () => ({ success: false, result: 'test: not here' })), runImpl: vi.fn(async () => ({ success: false, result: 'test: not here' })), maxDurationMs: 5000, rootBot: bot } as any;
  bot.instantSkills = { getSkill: (name: string) => (name === 'drop-item' ? drop : name === 'dig-block-at' ? dig : other) };
  bot.constantSkills = { getSkills: () => [] };
  // Every drop-item run and how many ran at once (never more than one).
  const drops = { calls: 0, atOnce: 0, most: 0 };
  const dropRun = drop.runImpl.bind(drop);
  drop.runImpl = (async (...args: any[]) => {
    drops.calls++; drops.atOnce++; drops.most = Math.max(drops.most, drops.atOnce);
    try { return await (dropRun as any)(...args); } finally { drops.atOnce--; }
  }) as any;
  const digs = { calls: 0 };
  const digRun = dig.runImpl.bind(dig);
  dig.runImpl = (async (...args: any[]) => { digs.calls++; return (digRun as any)(...args); }) as any;
  return { bot, pack, drop, dig, drops, digs };
}

describe('run 22: a tidy that called itself without end (dig-block-at -> drop-item -> its pit through dig-block-at -> tidy...)', () => {
  it('a motor port is one layer over the native bot, whatever it is made from', async () => {
    const native: any = Object.assign(new EventEmitter(), { dig: vi.fn(async () => 'dug') });
    let first: any;
    await executeAction(native, 'dig-block-at', 1000, async () => { first = createMotorPort(native); return { success: true, result: 'a' }; });
    // A port made later from the first (as a nested call did) is not fenced by the first's finished action: it is not wrapped round it.
    let second: any;
    const result = await executeAction(native, 'dig-block-at', 1000, async () => {
      second = createMotorPort(createMotorPort(first));
      return { success: true, result: await second.dig() };
    });
    expect(result.result).toBe('dug');
    expect(nativeActionHost(second)).toBe(native);
    expect(() => first.dig()).toThrow('Motor owner expired');
  });

  it('a skill called inside skills past the limit is refused, not run', async () => {
    const native: any = new EventEmitter();
    let deepest = 0;
    const nest = async (depth: number): Promise<any> => executeAction(native, `level-${depth}`, 0, async () => {
      deepest = Math.max(deepest, depth);
      return depth >= 40 ? { success: true, result: 'bottom' } : nest(depth + 1);
    });
    const result = await nest(0);
    expect(result.failureType).toBe('nesting_too_deep');
    expect(deepest).toBe(MAX_NESTED_ACTIONS);
  });
});
