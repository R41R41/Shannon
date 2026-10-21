import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { runAct, ACT_HANDS } from '../../src/services/minebot/instantSkills/act.js';
import { takeActReport } from '../../src/services/minebot/utils/actReport.js';

// How act stops (design mb-llm-centric 4: "act の止まり方"), and its result as the head's contract has it (ActResult JSON): a hand that
// fails, stopIf, a reflex, a watched cell, the dimension. A fake body: blocks from a map, no server, no pathfinder.
function body(overrides: Record<string, unknown> = {}) {
  const blocks = new Map<string, { name: string; boundingBox: string; diggable?: boolean; hardness?: number }>();
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true, height: 1.8 },
    health: 20, food: 20, game: { dimension: 'overworld' }, entities: {},
    inventory: { items: () => [], slots: new Array(46).fill(null) },
    blockAt: (p: Vec3) => {
      const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      if (blocks.has(key)) return { ...blocks.get(key)!, position: p.floored() };
      return Math.floor(p.y) < 64 ? { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5, position: p.floored() } : { name: 'air', boundingBox: 'empty', position: p.floored() };
    },
    setControlState: () => undefined, clearControlStates: () => undefined,
    ...overrides,
  });
  return { bot, blocks };
}
const hands = (value: unknown) => ACT_HANDS.parse(value);
const parse = (result: { result: string }) => JSON.parse(result.result);

describe('act: the hands and where they stop', () => {
  it('runs every hand and says so in the contract\'s JSON', async () => {
    const { bot } = body();
    const events: any[] = [];
    bot.on('minebotActStep', (event: any) => events.push(event));
    const result = await runAct(bot, hands([{ do: 'dig', at: [{ front: 1, up: 1 }] }, { do: 'dig', at: [{ x: 0, y: 1, z: 1 }], rel: true }, { do: 'wait', seconds: 0.5 }]), undefined, 'east');
    expect(result.success).toBe(true);
    const json = parse(result);
    expect(json).toMatchObject({ v: 1, ok: true, done: 3, of: 3, at: { x: 0, y: 64, z: 0 }, hp: 20, food: 20 });
    expect(json.lines[0]).toMatchObject({ i: 1, do: 'dig', status: 'done' });
    expect(json.lines[0].line).toContain('(1,65,0) は既に air（掘らずに次へ）');
    expect(json.lines[1].line).toContain('(0,65,1) は既に air');
    expect(json.map).toContain('地図 v1 足=(0,64,0)');
    expect(events.filter(event => event.status === 'completed').map(event => event.index)).toEqual([0, 1, 2]);
  });

  it('stops at the first hand that fails: the closed word, the place, what the cell holds; the rest skipped', async () => {
    const { bot } = body();
    const result = await runAct(bot, hands([{ do: 'dig', at: [{ x: 9, y: 63, z: 0 }] }, { do: 'wait', seconds: 1 }]));
    expect(result.success).toBe(false);
    expect(result.failureType).toBe('out_of_reach');
    const json = parse(result);
    expect(json).toMatchObject({ ok: false, done: 0, of: 2, partial: false, stoppedBy: 'failure' });
    expect(json.lines[0]).toMatchObject({ status: 'stopped', where: { x: 9, y: 63, z: 0 } });
    expect(json.lines[0].line.startsWith('届かない: (9,63,0)（自分から東9・下1）')).toBe(true);
    expect(json.lines[0].line.endsWith('そのマスは stone')).toBe(true);
    expect(json.lines[0].line.length).toBeLessThanOrEqual(160);
    expect(json.lines[1]).toEqual({ i: 2, do: 'wait', status: 'skipped', line: '未実行' });
    const again = parse(await runAct(bot, hands([{ do: 'dig', at: [{ x: 9, y: 63, z: 0 }] }])));
    expect(again.lines[0].line).toContain('同じ所・同じ理由で2回目');
  });

  it('stops a wait when stopIf health is crossed', async () => {
    const { bot } = body();
    setTimeout(() => { bot.health = 8; }, 60);
    const started = Date.now();
    const result = await runAct(bot, hands([{ do: 'wait', seconds: 5 }, { do: 'jump' }]), { hpBelow: 10 }, undefined, { tickMs: 20 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.failureType).toBe('stop_if_hp');
    const json = parse(result);
    expect(json).toMatchObject({ stoppedBy: 'stopIf', stoppedWhy: 'hpBelow:8' });
    expect(json.lines[0].line.startsWith('stopIf:')).toBe(true);
    expect(json.lines[1].status).toBe('skipped');
  });

  it('stops when a body reflex acts, and tells it', async () => {
    let entries: Array<{ kind: string; detail: string }> = [];
    const { bot } = body({ reflexLedger: { mark: () => 0, entriesSince: () => entries } });
    setTimeout(() => { entries = [{ kind: 'shield', detail: '盾を構えた' }]; }, 20);
    setTimeout(() => { entries = [{ kind: 'shield', detail: '盾を構えた' }, { kind: 'eat', detail: '食事（bread）' }]; }, 80);
    const result = await runAct(bot, hands([{ do: 'wait', seconds: 5 }]), undefined, undefined, { tickMs: 20 });
    const json = parse(result);
    expect(json.stoppedBy).toBe('reflex');
    expect(json.stoppedWhy).toContain('食事（bread）');
    expect(json.stoppedWhy).toContain('今 (0,64,0)');
    expect(json.lines[0].line.startsWith('反射:')).toBe(true);
    expect(takeActReport(bot, 0)?.stoppedBy).toBe('reflex');
  });

  it('stops when a watched cell changes, and when the dimension changes', async () => {
    const { bot, blocks } = body();
    setTimeout(() => blocks.set('3,64,0', { name: 'lava', boundingBox: 'empty' }), 40);
    const watched = parse(await runAct(bot, hands([{ do: 'wait', seconds: 5 }]), { blockChanged: [{ x: 3, y: 64, z: 0 }] }, undefined, { tickMs: 20 }));
    expect(watched.stoppedWhy).toBe('blockChanged:(3,64,0) air→lava');
    setTimeout(() => { bot.game.dimension = 'the_nether'; }, 40);
    const moved = await runAct(bot, hands([{ do: 'wait', seconds: 5 }]), undefined, undefined, { tickMs: 20 });
    expect(moved.failureType).toBe('dimension_changed');
  });

  it('does not count an accepted kind for stopIf hostileWithin, and lets the dig guard leave it be', async () => {
    const { bot } = body();
    bot.entities[8] = { id: 8, name: 'blaze', type: 'hostile', position: new Vec3(2, 64, 0) };
    let engaged: unknown = null;
    setTimeout(() => { engaged = bot.engagements?.map((entry: any) => entry.kinds); }, 30);
    const json = parse(await runAct(bot, hands([{ do: 'wait', seconds: 0.5 }]), { hostileWithin: 6 }, undefined, { tickMs: 20, accept: ['blaze'] }));
    expect(json.ok).toBe(true);
    expect(engaged).toEqual([['blaze']]);
    expect(bot.engagements ?? []).toEqual([]);
  });

  it('stops when a hostile comes within the distance', async () => {
    const { bot } = body();
    setTimeout(() => { bot.entities[7] = { id: 7, name: 'zombie', type: 'hostile', position: new Vec3(3, 64, 0) }; }, 40);
    const json = parse(await runAct(bot, hands([{ do: 'wait', seconds: 5 }]), { hostileWithin: 6 }, undefined, { tickMs: 20 }));
    expect(json.stoppedWhy).toMatch(/^hostileWithin:zombie #7 2\.\dm/u);
  });

  it('takes every field the head\'s schema takes, and refuses what it cannot read', async () => {
    const full = hands([{ do: 'attack', target: '#41', untilDead: false, seconds: 3, note: 'ブレイズ' },
      { do: 'furnace', at: [{ x: 1, y: 2, z: 3 }], op: 'put', item: 'raw_iron', count: 3, fuel: 'coal', fuelCount: 1 },
      { do: 'chest', at: [{ x: 1, y: 2, z: 3 }], op: 'take', items: [{ item: 'bread', count: 2 }] },
      { do: 'walk', to: { x: 1, y: 64, z: 1 }, sprint: true, range: 1 }, { do: 'equip', item: 'shield', slot: 'offhand' },
      { do: 'look', yaw: 90, pitch: -30 }, { do: 'shoot', target: 'blaze', item: 'bow', charge: 1, n: 2 },
      { do: 'dig', at: [{ x: 1, y: 2, z: 3 }], exposeOk: true, takeOk: true, tool: 'iron_pickaxe', collect: false },
      { do: 'place', at: [{ x: 1, y: 2, z: 3 }], block: 'cobblestone', face: 'down' }, { do: 'sneak', on: true },
      { do: 'attack', hold: true, target: 'blaze', seconds: 10 }, { do: 'pickup', range: 4 }]);
    expect(full).toHaveLength(12);
    expect(() => hands([{ do: 'dig', at: [{ x: 1, y: 2, z: 3 }], oops: true }])).toThrow();
    expect(() => hands(new Array(13).fill({ do: 'jump' }))).toThrow();
    const { bot } = body();
    expect((await runAct(bot, hands([{ do: 'attack' }]))).failureType).toBe('invalid_input');
    expect((await runAct(bot, hands([{ do: 'dig', at: [{ x: 1, z: 2 }] }]))).failureType).toBe('invalid_input');
  });
});
