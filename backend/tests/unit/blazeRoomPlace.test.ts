import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { Vec3 } from 'vec3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim } from '../helpers/physicsBody.js';
import { place } from '../../src/services/minebot/utils/primitives/place.js';

type Cell = { x: number; y: number; z: number };
// liveプローブはimportだけで接続する。純粋な計画関数だけを実ファイルから取り出して実行し、接続・envの読取りはしない。
const source = readFileSync(new URL('../../scripts/minecraft-hunt-probe.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('hunt-probe.ts', source, ts.ScriptTarget.Latest, true);
const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && ['blazeRoomCells', 'roomPlaceOrder'].includes(node.name?.text ?? '')).map(node => node.getText(parsed)).join('\n');
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const { blazeRoomCells, roomPlaceOrder } = runInNewContext(`${compiled}\n({ blazeRoomCells, roomPlaceOrder })`) as {
  blazeRoomCells(x: number, y: number, z: number, spawner: number[]): number[][];
  roomPlaceOrder(cells: Cell[], solidAt: (x: number, y: number, z: number) => boolean): Cell[];
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('blaze_roomの壁・支え・天井を同じ立ち位置から置く', () => {
  it.each([[1, 0], [-1, 0], [0, 1], [0, -1]])('湧き場から(%s,%s)側: 全8マスが面で繋がり、支えの後に天井を置く', async (dx, dz) => {
    const spawner = [140, 77, 75], x = spawner[0] + dx, y = spawner[1], z = spawner[2] + dz;
    const cells = blazeRoomCells(x, y, z, spawner).map(([x, y, z]) => ({ x, y, z }));
    const support = { x: x + dx, y: y + 2, z: z + dz }, roof = { x, y: y + 2, z };
    expect(cells).toHaveLength(8);
    expect(cells).toContainEqual(support);
    expect(cells).not.toContainEqual({ x: spawner[0], y: y + 1, z: spawner[2] });
    const sim = makeSim((_x, by) => by < y ? 'nether_bricks' : 'air', { start: [x + 0.5, y, z + 0.5], items: [{ name: 'cobblestone', count: 8 }] });
    const solidAt = (x: number, y: number, z: number) => sim.bot.blockAt(new Vec3(x, y, z))?.boundingBox === 'block';
    // 再建時にも入力順へ依存しない（天井を先に渡しても支えの後にする）。
    const ordered = roomPlaceOrder([...cells].reverse(), solidAt);
    expect(ordered.indexOf(ordered.find(c => c.x === support.x && c.y === support.y && c.z === support.z)!))
      .toBeLessThan(ordered.indexOf(ordered.find(c => c.x === roof.x && c.y === roof.y && c.z === roof.z)!));
    const ctx = { bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 40_000, facing: 'north' as const, base: { x, y, z } };
    const running = place(ctx, { at: ordered, block: 'cobblestone' });
    await vi.runAllTimersAsync();
    const result = await running;
    expect(result.ok, result.text).toBe(true);
    expect(result.progress).toMatchObject({ done: 8, left: 0 });
    expect(cells.every(c => solidAt(c.x, c.y, c.z))).toBe(true);
    expect(sim.bot.placedBlocks).toHaveLength(8);
    // 体の手は別の場所へ動かさない。
    expect(sim.bot.entity.position).toEqual(new Vec3(x + 0.5, y, z + 0.5));
    // 支えだけが既にある再建でも、足場から面が繋がる順を求められる。
    sim.world.set(roof.x, roof.y, roof.z, 'air');
    expect(roomPlaceOrder([roof], solidAt)).toEqual([roof]);
  });

  it('繋がる面が無い計画は、別のマスや移動を選ばず理由を返す', () => {
    expect(() => roomPlaceOrder([{ x: 0, y: 2, z: 0 }], () => false)).toThrow('部屋の支えが繋がらない');
  });
});
