import { describe, expect, it } from 'vitest';
import { DEN_DIRECTIONS, denDigCells, denOffset, endermanDenCandidates, endermanDenProblem, inspectEndermanDen, type DenWorld } from '../../src/services/minebot/utils/huntEndermanDen.js';
import { huntDenField } from './fixtures/huntDenField.js';

const options = { radius: 1, verticalRange: 0, limit: 8 };
describe('横穴の候補観測（純関数）', () => {
  it.each(DEN_DIRECTIONS)('掘れる壁: %s 向きの2高×1幅×2奥、指定4マスと外の床・射線を返す', direction => {
    const field = huntDenField(direction), before = { ...field.bot.entity.position };
    const candidates = endermanDenCandidates(field.bot, options);
    const candidate = candidates.find(c => c.direction === direction && c.entrance.x === 0 && c.entrance.z === 0);
    expect(candidate).toBeDefined();
    expect(candidate).toMatchObject({ entrance: field.den.entrance, direction, wait: denOffset(field.den, 1), outsideFloor: denOffset(field.den, -1, -1), remaining: 4 });
    expect(candidate?.dig).toEqual(denDigCells(field.den));
    expect(candidate?.sightDistance).toBeGreaterThanOrEqual(6);
    expect(candidate?.penalties).toContain('未掘削 4/4');
    expect(field.bot.entity.position).toMatchObject(before);
    expect(field.blocks.size).toBe(0); // no excavation or remembered selection
    expect(endermanDenCandidates(field.bot, options)).toEqual(candidates);
  });
  it.each(['netherrack', 'warped_nylium', 'warped_wart_block', 'basalt', 'blackstone'])('%s を名前で掘れる', name => {
    const field = huntDenField();
    denDigCells(field.den).forEach(p => field.set(p, name));
    expect(endermanDenCandidates(field.bot, options)).toHaveLength(1);
  });
  it.each(['lava', 'water'])('掘るマスの隣が %s なら候補なし', liquid => {
    const field = huntDenField(); field.set({ x: 1, y: 64, z: 1 }, liquid);
    expect(endermanDenCandidates(field.bot, options)).toEqual([]);
    expect(inspectEndermanDen(field.bot, field.den).code).toBe('den_hazard');
  });
  it.each([{ x: 2, y: 64, z: 0 }, { x: 1, y: 65, z: 1 }])('奥・横の空洞に開くなら候補なし (%j)', at => {
    const field = huntDenField(); field.set(at, 'air');
    expect(endermanDenCandidates(field.bot, options)).toEqual([]);
    expect(inspectEndermanDen(field.bot, field.den).code).toBe('den_open_shell');
  });
  it.each([0, 1])('入口・奥の天井が空気なら候補なし (depth=%i)', depth => {
    const field = huntDenField(); field.set(denOffset(field.den, depth, 2), 'air');
    expect(endermanDenCandidates(field.bot, options)).toEqual([]);
  });
  it('入口の外が崖なら候補なし（縦穴にもならない）', () => {
    const field = huntDenField(); field.set(denOffset(field.den, -1, -1), 'air');
    expect(endermanDenCandidates(field.bot, options)).toEqual([]);
    expect(inspectEndermanDen(field.bot, field.den).code).toBe('den_outside_unsafe');
  });
  it('入口から開けた地面までの目の線が幹で塞がるなら候補なし', () => {
    const field = huntDenField(); field.set({ x: -5, y: 66, z: 0 }, 'warped_stem');
    expect(inspectEndermanDen(field.bot, field.den).ok).toBe(true); // shell and runway still stand
    expect(endermanDenCandidates(field.bot, options)).toEqual([]);
  });
  it('既に掘った同じ穴は再利用候補になる（掘る必要は0）', () => {
    const field = huntDenField(); denDigCells(field.den).forEach(p => field.set(p, 'air'));
    expect(endermanDenCandidates(field.bot, options)[0]).toMatchObject({ remaining: 0, wait: denOffset(field.den, 1) });
    expect(inspectEndermanDen(field.bot, field.den, true).ok).toBe(true);
  });
  it('未ロード、落下する天井、許していない名前・保護物は候補にしない', () => {
    for (const name of [null, 'gravel', 'chest', 'diamond_ore']) {
      const field = huntDenField(); field.set({ x: 1, y: 66, z: 0 }, name);
      if (name === 'chest' || name === 'diamond_ore') field.set(denOffset(field.den, 1), name);
      expect(endermanDenCandidates(field.bot, options)).toEqual([]);
    }
    const field = huntDenField();
    expect(endermanDenCandidates(field.bot, { ...options, canDig: ['basalt'] })).toEqual([]);
  });
  it('観測の古いキャッシュを使わず、次の観測は新しく現れた溶岩を拒否する', () => {
    const field = huntDenField(); expect(endermanDenCandidates(field.bot, options)).toHaveLength(1);
    field.set({ x: 1, y: 64, z: 1 }, 'lava');
    expect(endermanDenCandidates(field.bot, options)).toEqual([]);
  });
  it('固体に見える水つきブロック、半ブロックの天井も使わない', () => {
    const field = huntDenField();
    for (const waterlogged of [true, false]) {
      const bot: DenWorld = { entity: field.bot.entity, blockAt(at) {
        const b = field.bot.blockAt(at);
        if (!b || at.x !== 1 || at.y !== 66 || at.z !== 0) return b;
        return waterlogged ? { ...b, getProperties: () => ({ waterlogged: true }) } : { ...b, shapes: [[0, 0.5, 0, 1, 1, 1]] };
      } };
      expect(endermanDenCandidates(bot, options)).toEqual([]);
    }
  });
  it('入口外の無害な根は掘らずに通れるので候補を妨げない', () => {
    const field = huntDenField();
    const bot: DenWorld = { entity: field.bot.entity, blockAt(at) {
      return at.x === -1 && at.y === 64 && at.z === 0 ? { name: 'warped_roots', boundingBox: 'empty' } : field.bot.blockAt(at);
    } };
    expect(endermanDenCandidates(bot, options)).toHaveLength(1);
    expect(field.blocks.size).toBe(0);
  });
  it('距離と品質のscore順で有限数を返す。入力は絶対整数・東西南北だけ', () => {
    const field = huntDenField(), candidates = endermanDenCandidates(field.bot, { radius: 4, verticalRange: 0, limit: 3 });
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.length).toBeLessThanOrEqual(3);
    expect(candidates.map(c => c.score)).toEqual(candidates.map(c => c.score).sort((a, b) => a - b));
    expect(endermanDenProblem(field.den)).toBeNull();
    expect(endermanDenProblem({ ...field.den, direction: 'up' })).not.toBeNull();
    expect(endermanDenProblem({ ...field.den, entrance: { x: 0.1, y: 64, z: 0 } })).not.toBeNull();
    expect(endermanDenProblem({ ...field.den, entrance: { x: Infinity, y: 64, z: 0 } })).not.toBeNull();
  });
});
