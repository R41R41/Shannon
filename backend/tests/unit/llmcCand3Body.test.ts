import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

// mb-llmc-cand 3 (2026-10-23, run 37): a stopped line puts the root of the stop first and cuts the explanation from the back (4 of 6 "4 秒進めず" lines
// were cut before the facts that said why); a drop throws level toward the freest way, says where the items lay, and does not take its own back.
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/digBlockVerified.js')>();
  return { ...actual, digBlockVerified: vi.fn(async () => ({ stateId: 0, blockName: 'air' })) };
});
vi.mock('../../src/services/minebot/utils/setMovements.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/setMovements.js')>();
  return { ...actual, buildMovements: (bot: any, ...rest: any[]) => bot.__fakeMovements ? { getBlock: () => null, getNeighbors: () => [], exclusionAreasBreak: [] } : (actual.buildMovements as any)(bot, ...rest) };
});

const { runAct, ACT_HANDS } = await import('../../src/services/minebot/instantSkills/act.js');
const { stoppedLine, LINE_MAX, LINE_MAX_WITH_CAUSE } = await import('../../src/services/minebot/utils/actReport.js');
const { drop } = await import('../../src/services/minebot/utils/primitives/body.js');

// ===== 1. the root first =====

describe('stoppedLine: the root of the stop comes first and is not cut; the explanation is cut from the back', () => {
  it('without a cause the line is what it was (160 at most, the cell at the back)', () => {
    const line = stoppedLine('wall', 'あ'.repeat(300), 'stone', undefined, '（同じ所・同じ理由で2回目）');
    expect(line.length).toBe(LINE_MAX);
    expect(line.startsWith('一歩ではない: ')).toBe(true);
    expect(line.endsWith('（同じ所・同じ理由で2回目）。そのマスは stone')).toBe(true);
  });
  it('with a cause: 一歩ではない（元: …）: text; 260 at most; the cause whole', () => {
    const line = stoppedLine('stuck', '4秒進めず止まった（今 (1,64,0)）。' + 'あ'.repeat(400), 'air', '経路探索は道を見つけたが体は進まなかった・水の中・今のマスが水の流れ 5', '（同じ所・同じ理由で3回目）');
    expect(line.startsWith('一歩ではない（元: 経路探索は道を見つけたが体は進まなかった・水の中・今のマスが水の流れ 5）: 4秒進めず止まった')).toBe(true);
    expect(line.length).toBe(LINE_MAX_WITH_CAUSE);
    expect(line.endsWith('（同じ所・同じ理由で3回目）。そのマスは air')).toBe(true);
  });
});

// ===== run 37's walks that did not move, read in the act's line =====

function stuckBody(shape: (x: number, y: number, z: number) => any, route: Vec3[], status = 'success') {
  const bot: any = Object.assign(new EventEmitter(), {
    __fakeMovements: true,
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true, isInWater: false, height: 1.8 }, health: 20, food: 20, game: { dimension: 'overworld' }, entities: {},
    registry: { blocksByName: {}, itemsByName: {}, items: {} }, inventory: { items: () => [], slots: new Array(46).fill(null) }, heldItem: null,
    blockAt: (p: Vec3) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      return { diggable: true, hardness: 1, ...(shape(x, y, z)), position: new Vec3(x, y, z) };
    },
    setControlState: () => undefined, clearControlStates: () => undefined, stopDigging: () => undefined,
  });
  let release: (() => void) | null = null;
  bot.pathfinder = { movements: null, setMovements(m: unknown) { this.movements = m; }, stop: () => release?.(), setGoal: () => undefined,
    goto: vi.fn(() => { bot.emit('path_update', { status, path: route }); return new Promise<void>(resolve => { release = resolve; }); }) };
  return bot;
}
const floor = (_x: number, y: number) => (y < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' });
const lineOf = async (bot: any) => {
  const result = await runAct(bot, ACT_HANDS.parse([{ do: 'walk', to: { x: 3, y: 64, z: 0 } }]));
  return JSON.parse(result.result).lines[0].line as string;
};

describe('run 37: the six walks that did not move, as the act\'s line now reads (the root is in the first 120 characters)', () => {
  const water = (level: number) => ({ name: 'water', boundingBox: 'empty', getProperties: () => ({ level }) });
  const door = (half: string) => ({ name: 'oak_door', boundingBox: 'block', getProperties: () => ({ open: false, half, facing: 'east' }) });

  it('in a flow of water (1,802): the search found a way, the body is in the water, the flow is 5', async () => {
    const bot = stuckBody((x, y, z) => (y === 64 && z === 0 && x >= 0 && x <= 3 ? water(x === 0 ? 5 : 3) : floor(x, y)), [new Vec3(1, 64, 0), new Vec3(2, 64, 0), new Vec3(3, 64, 0)]);
    bot.entity.isInWater = true;
    const line = await lineOf(bot);
    expect(line.startsWith('一歩ではない（元: 経路探索は道を見つけたが体は進まなかった・水の中・今のマスが水の流れ 5）: ')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(LINE_MAX_WITH_CAUSE);
  }, 20000);

  it('at a shut door of a house wall (146, 185, 215): the door that did not open is the root', async () => {
    const bot = stuckBody((x, y, z) => (x === 1 && z === 0 && y === 64 ? door('lower') : x === 1 && z === 0 && y === 65 ? door('upper') : floor(x, y)), [new Vec3(1, 64, 0), new Vec3(2, 64, 0), new Vec3(3, 64, 0)]);
    bot.activateBlock = vi.fn(async () => { throw new Error('no reach'); });
    const line = await lineOf(bot);
    expect(line.startsWith('一歩ではない（元: ')).toBe(true);
    expect(line.slice(0, 120)).toContain('次のマスが閉じた oak_door');
    expect(line.slice(0, 120)).toContain('扉を開けようとして失敗');
    expect(line.slice(0, 120)).toContain('経路探索は道を見つけたが体は進まなかった');
  }, 20000);

  it('the search found no way although the walk\'s rules say there is one: that is the root', async () => {
    const trapdoor = { name: 'oak_trapdoor', boundingBox: 'block', getProperties: () => ({ open: false, half: 'bottom', facing: 'east', waterlogged: false }) };
    const bot = stuckBody((x, y, z) => (x === 1 && y === 64 && z === 0 ? trapdoor : floor(x, y)), [], 'noPath');
    const line = await lineOf(bot);
    expect(line.startsWith('一歩ではない（元: 経路探索は道が見つからないと答えた・次のマスが閉じた oak_trapdoor）: ')).toBe(true);
  }, 20000);

  it('a block at the head of the next cell (the stairs of a house): named in the root', async () => {
    const bot = stuckBody((x, y, z) => (x === 1 && y === 65 && z === 0 ? { name: 'cobblestone', boundingBox: 'block' } : floor(x, y)), [new Vec3(1, 64, 0)]);
    const line = await lineOf(bot);
    expect(line.slice(0, 160)).toContain('次の頭が cobblestone');
  }, 20000);
});

// ===== 2. a drop does not take its own back =====

function dropper(options: { solidNorth?: boolean; landAt?: (from: Vec3) => Vec3 | null; yaw?: number } = {}) {
  const items = [{ name: 'cobblestone', type: 4, count: 64 }];
  const entities: Record<string, any> = {};
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: options.yaw ?? 0, onGround: true }, entities, game: { dimension: 'overworld' },
    inventory: { items: () => items.filter(item => item.count > 0) },
    blockAt: (p: Vec3) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      // Stone under y 64; a wall of stone to the north at z -2 (head height) when asked.
      const solid = y < 64 || (options.solidNorth && z === -2 && y >= 64 && y <= 66);
      return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', position: new Vec3(x, y, z) };
    },
    lookAt: vi.fn(async () => undefined),
    toss: vi.fn(async (_type: number, _meta: unknown, count: number) => {
      items[0].count -= count;
      const lands = (options.landAt ?? ((from: Vec3) => from.offset(5, 0, 0)))(bot.entity.position);
      if (lands) entities['77'] = { id: 77, name: 'item', position: lands };
    }),
  });
  const ctx = { bot, stop: new AbortController().signal, deadline: Date.now() + 30_000, facing: 'north' as const, base: { x: 0, y: 64, z: 0 } };
  return { bot, ctx: ctx as any };
}

describe('drop: level toward the freest way, where it lay, and whether it is far enough not to be picked up again (run 37: 8 full packs, ~150 s)', () => {
  it('a wall to the north (the way she faces): thrown east, level; the stones lay 5 m away; "拾い直さない" is said', async () => {
    const { bot, ctx } = dropper({ solidNorth: true });
    const out = await drop(ctx, { items: [{ item: 'cobblestone' }] });
    expect(out.ok).toBe(true);
    // Level: the look is at the height of the eyes (64 + 1.62), eight cells along the way thrown.
    const aimed = bot.lookAt.mock.calls[0][0] as Vec3;
    expect(aimed.x).toBeGreaterThan(5);
    expect(aimed.y).toBeCloseTo(65.62, 2);
    expect(aimed.z).toBeCloseTo(0.5, 2);
    expect(out.text).toContain('cobblestone×64 を投げた（残り0）');
    expect(out.text).toContain('東へ水平に投げた');
    expect(out.text).toContain('落ちた先 (5,64,0)（足から横 5.0m）');
    expect(out.text).toContain('3m 以上離れたので、そこへ歩いて戻らない限り拾い直さない');
  });

  it('the items lay close (a tunnel): the line says they will be picked up again by staying, and to move away first', async () => {
    const { ctx } = dropper({ landAt: from => from.offset(1, 0, 0.2) });
    const out = await drop(ctx, { items: [{ item: 'cobblestone', count: 10 }] });
    expect(out.text).toContain('cobblestone×10 を投げた（残り54）');
    expect(out.text).toContain('近い（3m 未満）: ここに立ち続ける・近くを歩くと拾い直す。離れてから続ける');
  });

  it('the way she faces is kept when it is as free as any', async () => {
    const { bot, ctx } = dropper({ yaw: -Math.PI / 2 });  // yaw -π/2: east
    const out = await drop(ctx, { items: [{ item: 'cobblestone' }] });
    expect(out.text).toContain('東へ水平に投げた');
    expect((bot.lookAt.mock.calls[0][0] as Vec3).x).toBeGreaterThan(5);
  });

  it('a cell given as the text "3,64,0" is a cell: looked at, not "16m 内にいない"', async () => {
    const { bot, ctx } = dropper();
    const out = await drop(ctx, { items: [{ item: 'cobblestone' }], toward: '3,64,0' });
    expect(out.ok).toBe(true);
    expect(bot.lookAt).toHaveBeenCalledTimes(1);
    expect((bot.lookAt.mock.calls[0][0] as Vec3).x).toBeCloseTo(3.5, 2);
  });
});
