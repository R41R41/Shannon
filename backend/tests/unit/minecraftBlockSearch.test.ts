import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
vi.mock('../../src/config/env.js', () => ({ config: {} }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { SKILL_TIMEOUT_MS: 120000 } }));
import FindBlocks from '../../src/services/minebot/instantSkills/findBlocks.js';
const fixture = () => ({ version: '1.21.11', entity: { position: new Vec3(0, 100, 0) },
  blockAt: () => ({ name: 'oak_log' }), interruptExecution: false, findBlocks: vi.fn(() => []) });
describe('responsive complete block search', () => {
  it('stops expanding once enough nearest results are found', async () => {
    const bot = fixture(); bot.findBlocks.mockReturnValue([new Vec3(1, 100, 0)] as any);
    const result = await new FindBlocks(bot as any).runImpl('oak_log', 128, 1);
    expect(result.success).toBe(true); expect(bot.findBlocks).toHaveBeenCalledTimes(1);
    expect(bot.findBlocks.mock.calls[0][0].maxDistance).toBe(16);
  });
  it('does not silently omit the final search shell at radius 24', async () => {
    const bot = fixture(); bot.findBlocks.mockImplementation((options: any) => options.maxDistance === 24 ? [new Vec3(23, 100, 0)] as any : []);
    const result = await new FindBlocks(bot as any).runImpl('oak_log', 24, 10);
    expect(result.success).toBe(true); expect(bot.findBlocks.mock.calls.map(([options]) => options.maxDistance)).toEqual([16, 24]);
    expect(result.result).toContain('23');
  });
  it('yields for network/cancel events between native scans', async () => {
    const bot = fixture(); bot.findBlocks.mockImplementation(() => { setImmediate(() => { bot.interruptExecution = true; }); return []; });
    const result = await new FindBlocks(bot as any).runImpl('oak_log', 128, 10);
    expect(result.success).toBe(false); expect(bot.findBlocks).toHaveBeenCalledTimes(1);
  });
  it('expands geometrically to avoid repeating expensive large-volume scans', async () => {
    const bot = fixture();
    const result = await new FindBlocks(bot as any).runImpl('oak_log', 128, 10);
    expect(result.success).toBe(true);
    expect(bot.findBlocks.mock.calls.map(([options]) => options.maxDistance)).toEqual([16, 32, 64, 128]);
    expect(result.result).toContain('ロード済みチャンク');
    expect(result.result).toContain('未ロード領域は未探索');
    expect(result.result).toContain('新しい地点へ移動');
  });
  it('flags candidates far underground without hiding them from legitimate cave searches', async () => {
    const bot = fixture(); bot.findBlocks.mockReturnValue([new Vec3(5, -47, 0)] as any);
    const result = await new FindBlocks(bot as any).runImpl('oak_log', 128, 1);
    expect(result.success).toBe(true);
    expect(result.result).toContain('高低差-147m');
    expect(result.result).toContain('全候補が現在地より32m以上地下');
    expect(result.result).toContain('(5, -47, 0)');
  });
  it('shows a shallow ore before a geometrically nearer deep ore without hiding the cave option', async () => {
    const deep = new Vec3(6, 48, -10);
    const shallow = new Vec3(12, 59, -14);
    const bot: any = fixture();
    bot.entity.position = new Vec3(0, 61, 0);
    bot.findBlocks.mockImplementation((options: any) => options.maxDistance === 32 ? [deep, shallow] : []);
    bot.blockAt = (position: Vec3) => [deep, shallow].some(ore => ore.equals(position))
      ? { name: 'iron_ore' } : { name: 'air' };
    const result = await new FindBlocks(bot).runImpl('iron_ore', 32, 2);
    expect(result.success).toBe(true);
    expect(result.result.indexOf('(12, 59, -14)')).toBeLessThan(result.result.indexOf('(6, 48, -10)'));
    expect(result.result).toContain('到達概算');
    expect(result.result).toContain('実経路の保証ではありません');
  });
});
