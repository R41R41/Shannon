import { describe, expect, it, vi } from 'vitest';

const frames = vi.hoisted(() => ({ list: [] as Array<{ x: number; y: number; z: number; horizontal: number; eye: boolean | null }> }));
vi.mock('../../src/services/minebot/utils/huntFrameSearch.js', async (original) => ({
  ...(await original<typeof import('../../src/services/minebot/utils/huntFrameSearch.js')>()),
  framesAround: vi.fn(() => ({ frames: frames.list, reach: 160, columns: 400 })),
}));
import { framesInSight } from '../../src/services/minebot/utils/primitives/go.js';

const body = (items: Array<{ name: string; count: number }>, dimension = 'minecraft:overworld') => ({
  entity: { position: { x: -804.5, y: 66, z: 1263.5 } }, game: { dimension }, inventory: { items: () => items },
  placeMemory: { remember: vi.fn() },
});

describe('a go that arrives says the portal room\'s frames in the loaded chunks (end1109s11: 110 m away, unsaid, 166 s lost)', () => {
  it('names the nearest frame, its way and its height while the body carries ender eyes', () => {
    frames.list = [{ x: -833, y: -10, z: 1370, horizontal: 110, eye: false }];
    const bot = body([{ name: 'ender_eye', count: 9 }]);
    expect(framesInSight(bot)).toBe('エンドポータルの枠が見えている（1 個）: いちばん近い (-833,-10,1370) は 110m 南・高さ -76。要塞はここ');
    expect(bot.placeMemory.remember).toHaveBeenCalledWith('stronghold', { x: -833, y: -10, z: 1370 }, { note: 'end_portal_frame' });
  });
  it('says nothing with no frame loaded, without eyes, or outside the overworld', () => {
    frames.list = [];
    expect(framesInSight(body([{ name: 'ender_eye', count: 9 }]))).toBe('');
    frames.list = [{ x: -833, y: -10, z: 1370, horizontal: 110, eye: false }];
    expect(framesInSight(body([]))).toBe('');
    expect(framesInSight(body([{ name: 'ender_eye', count: 9 }], 'minecraft:the_nether'))).toBe('');
  });
});
