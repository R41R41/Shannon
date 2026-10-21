import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { probeAround, probeColumn, probeHistory, probePath, probeSight, eyeOf } from '../../src/services/minebot/utils/probeTools.js';
import { handsNear, handHistory, HISTORY_MAX, noteHand } from '../../src/services/minebot/utils/handHistory.js';
import { runProbe } from '../../src/services/minebot/instantSkills/probe.js';
import { runAct, ACT_HANDS } from '../../src/services/minebot/instantSkills/act.js';
import type { BlockReader, MapBlock } from '../../src/services/minebot/utils/localMap.js';

// r4 contract 1 (2026-10-22): the body's reading tools. Each answer says the dangerous fact as it is: arch-check 6's S1 read "切れ目：足元の土"
// as a foothold to dig and dropped seven blocks into a cave. Fixed blocks, no server.
vi.mock('../../src/services/minebot/utils/primitives/walk.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/primitives/walk.js')>();
  return { ...actual, walk: vi.fn(async () => ({ ok: true, text: '(1,64,0) に着いた（1m、0.0秒）', at: { x: 1, y: 64, z: 0 } })) };
});

const STONE: MapBlock = { name: 'stone', solid: true }, AIR: MapBlock = { name: 'air', solid: false };
const WATER: MapBlock = { name: 'water', solid: false, level: 0 }, LAVA: MapBlock = { name: 'lava', solid: false, level: 0 };
const GRAVEL: MapBlock = { name: 'gravel', solid: true };
/** A world from a rule: (x, y, z) to a block; null past 60 across (not loaded). */
const world = (rule: (x: number, y: number, z: number) => MapBlock): BlockReader => (x, y, z) => Math.abs(x) > 60 || Math.abs(z) > 60 ? null : rule(x, y, z);
const flat = (y: number) => y < 64 ? STONE : AIR;

describe('probe path: walked without digging or laying a block, the walk\'s rules', () => {
  it('a river is swum: the steps, the swim, the deepest water, and the way\'s points (the last the goal)', async () => {
    // Water x 3..6 from y 60 to 63 (four deep), the bed at 59.
    const read = world((x, y) => x >= 3 && x <= 6 && y >= 60 && y <= 63 ? WATER : x >= 3 && x <= 6 && y >= 64 ? AIR : flat(y));
    const answer = await probePath(read, { x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 });
    expect(answer.reachable).toBe(true);
    expect(answer.swim).toBeGreaterThanOrEqual(4);
    expect(answer.maxWaterDepth).toBe(4);
    expect(answer.text).toContain('掘らず置かずに歩いて行ける');
    expect(answer.text).toContain('水深 最大 4');
    expect(answer.points!.length).toBeLessThanOrEqual(16);
    expect(answer.points![answer.points!.length - 1]).toEqual({ x: 10, y: 64, z: 0 });
  });

  it('a cave edge (S1): the break says "下 7 段は空気（落差 7）", never a block to dig as a foothold', async () => {
    // Feet at y -7 on stone; x 1..8 is a hole down to y -15 (seven cells of air under the walking level), the far side at x 9.
    const read = world((x, y) => x >= 1 && x <= 8 ? (y <= -15 ? STONE : AIR) : (y < -7 ? STONE : AIR));
    const answer = await probePath(read, { x: 0, y: -7, z: 0 }, { x: 12, y: -7, z: 0 });
    expect(answer.reachable).toBe(false);
    expect(answer.breaks![0]).toMatchObject({ reason: 'drop', n: 7, at: { x: 1, y: -7, z: 0 } });
    expect(answer.text).toContain('下 7 段は空気（落差 7、底 y=-15 stone）');
    expect(answer.text).not.toMatch(/足元の|足がかり|掘れば|掘って/u);
    expect(answer.nearest).toMatchObject({ x: 0, y: -7 });
  });

  it('a narrow hole is a gap with its width, and its depth said the same way', async () => {
    const read = world((x, y) => x >= 1 && x <= 2 ? (y <= -15 ? STONE : AIR) : (y < -7 ? STONE : AIR));
    // A drop of seven in a hole two wide: the walk does not jump it (no parkour across 2), so it is a break.
    const answer = await probePath(read, { x: 0, y: -7, z: 0 }, { x: 6, y: -7, z: 0 });
    expect(answer.reachable).toBe(false);
    expect(answer.breaks![0]).toMatchObject({ reason: 'gap', n: 2, depth: 7 });
    expect(answer.breaks![0].text).toContain('幅 2 の穴。下 7 段は空気（落差 7');
  });

  it('a wall says its block and its height; a low opening its block over the head; lava at the bottom of a drop is lava', async () => {
    const wall = world((x, y) => x === 5 && y >= 64 && y <= 66 ? STONE : flat(y));
    const walled = await probePath(wall, { x: 0, y: 64, z: 0 }, { x: 9, y: 64, z: 0 });
    expect(walled.breaks![0]).toMatchObject({ reason: 'wall', n: 3, block: 'stone', at: { x: 5, y: 64, z: 0 } });
    expect(walled.breaks![0].text).toBe('(5,64,0) は stone の壁（高さ 3）');
    const low = world((x, y) => x === 5 && y === 65 ? STONE : flat(y));
    const lowAnswer = await probePath(low, { x: 0, y: 64, z: 0 }, { x: 9, y: 64, z: 0 });
    expect(lowAnswer.breaks![0]).toMatchObject({ reason: 'low', block: 'stone' });
    expect(lowAnswer.breaks![0].text).toContain('高さ 1 のすき間');
    const lava = world((x, y) => x >= 3 && x <= 8 ? (y === 60 ? LAVA : y < 60 ? STONE : AIR) : flat(y));
    const lavaAnswer = await probePath(lava, { x: 0, y: 64, z: 0 }, { x: 12, y: 64, z: 0 });
    expect(lavaAnswer.breaks![0]).toMatchObject({ reason: 'lava' });
    expect(lavaAnswer.breaks![0].text).toContain('その下は溶岩');
  });

  it('a target straight under her says what lies between (a hollow as air with its height); a bank too high from the water says it is seen from the water', async () => {
    const hollow = world((x, y) => x >= 10 && x <= 14 && y >= 45 && y <= 55 ? AIR : flat(y));
    const under = await probePath(hollow, { x: 12, y: 64, z: 0 }, { x: 12, y: 45, z: 0 });
    expect(under.breaks![0]).toMatchObject({ reason: 'drop', n: 19, at: { x: 12, y: 64, z: 0 } });
    expect(under.breaks![0].text).toBe('的は (12,64,0) の真下 19 段（間：y=63〜56 stone×8 / y=55〜45 空気×11）');
    // A river whose water is two below the bank's top (the walk does not climb out onto it).
    const river = world((_x, y, z) => z >= 3 && z <= 6 ? (y >= 59 && y <= 62 ? WATER : y >= 63 ? AIR : STONE) : flat(y));
    const across = await probePath(river, { x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 10 });
    expect(across.reachable).toBe(false);
    expect(across.breaks![0].text).toMatch(/^水の中 \(0,62,6\) から：\(0,62,7\) は stone の壁（高さ 2）$/u);
  });

  it('cells near the target to stand in and reach it from, with the way to each (null: not reached)', async () => {
    const wall = world((x, y) => x === 5 && y >= 64 && y <= 66 ? STONE : flat(y));
    const answer = await probePath(wall, { x: 0, y: 64, z: 0 }, { x: 7, y: 63, z: 0 });
    expect(answer.stands!.length).toBeGreaterThan(0);
    expect(answer.stands!.length).toBeLessThanOrEqual(3);
    for (const stand of answer.stands!) expect(stand.eye).toBeLessThanOrEqual(4.5);
    // The near side of the wall is reached (a number of steps); the far side is not (null).
    expect(answer.stands!.some(stand => stand.at.x > 5 && stand.steps === null)).toBe(true);
  });

  it('a search is bounded (cells and time) and says so; too far is not searched', async () => {
    const open = world((_x, y) => flat(y));
    const capped = await probePath(open, { x: 0, y: 64, z: 0 }, { x: 40, y: 80, z: 0 }, { limits: { cells: 500 } });
    expect(capped.reachable).toBe(false);
    expect(capped.limited).toBe(true);
    expect(capped.searched).toBeLessThanOrEqual(510);
    expect(capped.text).toContain('上限');
    const far = await probePath(open, { x: 0, y: 64, z: 0 }, { x: 400, y: 64, z: 0 });
    expect(far.text).toContain('遠すぎて調べない');
  });
});

describe('probe sight, column, around', () => {
  it('sight: a block behind a wall is not seen, the cells between named, the distance against 4.5', () => {
    const read = world((x, y) => x === 3 && y >= 64 && y <= 66 ? STONE : flat(y));
    const answer = probeSight(read, eyeOf({ x: 0, y: 64, z: 0 }, true), { block: { x: 5, y: 64, z: 0 } });
    expect(answer.visible).toBe(false);
    expect(answer.between.some(cell => cell.at.x === 3 && cell.name === 'stone')).toBe(true);
    expect(answer.reach).toBe(false);
    expect(answer.text).toContain('見えない。間に固いブロック');
    expect(answer.text).toContain('届かない、掘る・使う・置くは 4.5m まで');
    const near = probeSight(read, eyeOf({ x: 0, y: 64, z: 0 }, true), { block: { x: 1, y: 64, z: 0 } });
    expect(near).toMatchObject({ visible: true, reach: true, reachLimit: 4.5 });
  });

  it('sight: a creature in reach is told against the 3 m of a blow, to the nearest point of its box', () => {
    const answer = probeSight(world((_x, y) => flat(y)), eyeOf({ x: 0, y: 64, z: 0 }, true), { creature: { id: 7, name: 'zombie', position: { x: 2.5, y: 64, z: 0.5 } } });
    expect(answer).toMatchObject({ visible: true, reach: true, reachLimit: 3, distance: 1.7 });
    expect(answer.text).toContain('打てるのは 3m まで');
  });

  it('column: her drop first ("足の下 8 段は空気（落差 8）"), a hollow under rock, water and its depth, gravel, the runs', () => {
    const read = world((_x, y) => y >= 56 && y <= 63 ? AIR : y >= 40 && y <= 42 ? WATER : y === 67 ? GRAVEL : y >= 30 && y <= 37 ? AIR : y < 64 ? STONE : AIR);
    const answer = probeColumn(read, 0, 0, 20, 70, { x: 0, y: 64, z: 0 });
    expect(answer.dangers[0]).toBe('足の下 8 段は空気（落差 8、底 y=55 stone）');
    expect(answer.dangers).toContain('y=37〜30 空気×8（落差 8、底 y=29 stone）');
    expect(answer.dangers).toContain('y=42〜40 水×3（水深 3）');
    expect(answer.dangers.some(line => line.startsWith('y=67 gravel×1'))).toBe(true);
    expect(answer.text.startsWith('危ない：足の下 8 段は空気（落差 8')).toBe(true);
    expect(answer.text).toContain('y=37〜30 空気×8（落差 8）');
    expect(answer.runs[0]).toEqual({ top: 70, bottom: 68, name: '空気', n: 3 });
  });

  it('column: a short step down is no danger, nor open sky over the ground; a column is cut at 96', () => {
    const read = world((_x, y) => y >= 62 && y <= 63 ? AIR : flat(y));
    expect(probeColumn(read, 0, 0, 50, 70, { x: 0, y: 64, z: 0 }).dangers).toEqual([]);
    const sky = world((_x, y) => y === 66 || y === 65 ? GRAVEL : flat(y));
    const skyAnswer = probeColumn(sky, 2, 2, 55, 75, { x: 0, y: 64, z: 0 });
    expect(skyAnswer.dangers).toEqual(['y=66〜65 gravel×2（砂・砂利：下が空くと落ちる）']);
    expect(skyAnswer.text).not.toContain('落差');
    const long = probeColumn(world((_x, y) => flat(y)), 0, 0, -64, 200);
    expect(long.runs.reduce((sum, run) => sum + run.n, 0)).toBe(96);
  });

  it('around: a hostile facing her and closing, lava and the edge of a drop said first', () => {
    const read = world((x, y, z) => x === 0 && z === 5 && y === 63 ? LAVA : x === -2 && y < 64 && y >= 58 ? AIR : flat(y));
    const zombie = { id: 7, name: 'zombie', position: { x: 3.5, y: 64, z: 0.5 }, yaw: Math.PI / 2, hostile: true, closing: 1.2 };
    // Facing south, away from her.
    const cow = { id: 8, name: 'cow', position: { x: -1.5, y: 64, z: 6.5 }, yaw: Math.PI, hostile: false, closing: null };
    const answer = probeAround(read, { x: 0.5, y: 64, z: 0.5 }, [cow, zombie], 8);
    expect(answer.creatures[0]).toMatchObject({ id: 7, hostile: true, visible: true, facing: true, closing: 1.2, dy: 0 });
    expect(answer.creatures[1]).toMatchObject({ id: 8, hostile: false, facing: false });
    expect(answer.dangers.find(d => d.kind === 'lava')).toMatchObject({ at: { x: 0, y: 63, z: 5 }, n: 1 });
    expect(answer.dangers.find(d => d.kind === 'drop')).toMatchObject({ at: { x: -2, y: 64, z: 0 }, n: 6 });
    expect(answer.text.startsWith('危ない：')).toBe(true);
    expect(answer.text).toContain('は下 6 段が空気（落差 6）');
    expect(answer.text).toContain('zombie #7（敵）');
    expect(answer.text).toContain('こちらを向いて近づく 1.2m/s');
  });
});

describe('the act\'s hands kept for history', () => {
  function body() {
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true, height: 1.8 },
      health: 20, food: 20, game: { dimension: 'overworld' }, entities: {},
      inventory: { items: () => [], slots: new Array(46).fill(null) },
      blockAt: (p: Vec3) => Math.floor(p.y) < 64 ? { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5, position: p.floored() }
        : { name: 'air', boundingBox: 'empty', position: p.floored() },
      setControlState: () => undefined, clearControlStates: () => undefined,
    });
    return bot;
  }

  it('each hand an act ran is kept with where it was about and where she began it; the probe reads them by place, newest first', async () => {
    const bot = body();
    await runAct(bot, ACT_HANDS.parse([{ do: 'walk', to: { x: 1, y: 64, z: 0 } }, { do: 'dig', at: [{ x: 9, y: 63, z: 0 }] }, { do: 'wait', seconds: 1 }]));
    const kept = handHistory(bot);
    // The skipped wait did not run: not kept.
    expect(kept.map(record => [record.do, record.status])).toEqual([['walk', 'done'], ['dig', 'stopped']]);
    expect(kept[1]).toMatchObject({ at: { x: 9, y: 63, z: 0 }, from: { x: 0, y: 64, z: 0 } });
    expect(kept[1].line.startsWith('届かない: (9,63,0)')).toBe(true);
    const json = JSON.parse((await runProbe(bot, { kind: 'history', at: { x: 9, y: 63, z: 0 }, radius: 2 })).result);
    expect(Object.keys(json).slice(0, 3)).toEqual(['v', 'kind', 'text']);
    expect(json.entries).toHaveLength(1);
    expect(json.entries[0]).toMatchObject({ do: 'dig', status: 'stopped', at: { x: 9, y: 63, z: 0 } });
    expect(json.text).toContain('止まり・失敗 1');
    // From where she stood, both hands (the dig began there).
    expect(handsNear(bot, { x: 0, y: 64, z: 0 }, 2).map(record => record.do)).toEqual(['dig', 'walk']);
  });

  it('keeps the last 200; an empty place says so', () => {
    const bot = {} as object;
    for (let i = 0; i < HISTORY_MAX + 30; i++) noteHand(bot, { t: i, do: 'walk', status: 'done', line: `${i}`, at: { x: i, y: 64, z: 0 } });
    expect(handHistory(bot)).toHaveLength(HISTORY_MAX);
    expect(handHistory(bot)[0].line).toBe('30');
    expect(probeHistory([], { x: 0, y: 64, z: 0 }, 4).text).toBe('(0,64,0) の 4m 内に、この接続で記録した手は無い');
  });
});

describe('runProbe on a body', () => {
  const bot: any = {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 }, game: { dimension: 'overworld' },
    entities: { 7: { id: 7, name: 'zombie', type: 'hostile', position: new Vec3(2.5, 64, 0.5), yaw: Math.PI / 2 } },
    registry: { entitiesByName: { zombie: { type: 'hostile' } } },
    blockAt: (p: Vec3) => Math.floor(p.y) < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' },
  };
  it('answers each kind as the contract\'s JSON, the sentence first; refuses what it cannot read', async () => {
    const sight = JSON.parse((await runProbe(bot, { kind: 'sight', target: '#7' })).result);
    expect(sight).toMatchObject({ v: 1, kind: 'sight', visible: true, reach: true, target: { name: 'zombie #7' } });
    expect(JSON.parse((await runProbe(bot, { kind: 'sight', target: 'zombie' })).result).target.name).toBe('zombie #7');
    const column = JSON.parse((await runProbe(bot, { kind: 'column', yFrom: 60, yTo: 66 })).result);
    expect(column).toMatchObject({ kind: 'column', x: 0, z: 0 });
    const around = JSON.parse((await runProbe(bot, { kind: 'around' })).result);
    expect(around.creatures[0]).toMatchObject({ id: 7, hostile: true, facing: true });
    const path = JSON.parse((await runProbe(bot, { kind: 'path', to: { x: 4, y: 64, z: 0 } })).result);
    expect(path).toMatchObject({ kind: 'path', reachable: true, steps: 4 });
    expect((await runProbe(bot, { kind: 'path' })).failureType).toBe('invalid_input');
    expect((await runProbe(bot, { kind: 'look' })).failureType).toBe('invalid_input');
    expect((await runProbe(bot, { kind: 'sight', target: '#99' })).failureType).toBe('not_found');
    expect((await runProbe(bot, { kind: 'scan' })).failureType).toBe('unavailable');
  });
});
