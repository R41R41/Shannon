import { describe, expect, it } from 'vitest';
import { waterDigWords } from '../../src/services/minebot/utils/waterDigWords.js';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';

// Run 46 (hold 7): a dig under water that the swim reflex stopped, six times at the same place, with the line saying only "泳ぎ（呼吸）".
const body = (wet: { feet: boolean; head: boolean }, oxygen = 9) => ({
  entity: { position: new Vec3(122.3, -56, 237.7), isInWater: wet.feet || wet.head },
  oxygenLevel: oxygen,
  blockAt: (p: { x: number; y: number; z: number }) => ({ name: (p.y === -56 && wet.feet) || (p.y === -55 && wet.head) ? 'water' : 'air' }),
}) as never;

describe('a dig that the swim reflex stopped, in words the planner can act on', () => {
  it('says the body digs in water, how long the air is, and the three ways out, and counts the times at the same place', () => {
    const bot = body({ feet: true, head: true });
    const first = waterDigWords(bot, 'dig', '泳ぎ（呼吸）')!;
    expect(first).toContain('水の中で掘っている（頭が水）');
    expect(first).toContain('息 9/20');
    expect(first).toContain('水源を汲むか、ブロックで水を塞ぐか、水の外の立ち位置から掘る');
    expect(first).not.toContain('回目');
    expect(waterDigWords(bot, 'obsidian', '泳ぎ（呼吸）')).toContain('（同じ所で 2 回目）');
    expect(waterDigWords(bot, 'dig', '泳ぎ（呼吸）')).toContain('（同じ所で 3 回目）');
  });
  it('says feet in water when the head is out, and nothing for a dry body, another stop or another hand', () => {
    expect(waterDigWords(body({ feet: true, head: false }, 14), 'mine', '呼吸')).toContain('（足元が水）');
    expect(waterDigWords(body({ feet: false, head: false }), 'dig', '泳ぎ（呼吸）')).toBeNull();
    expect(waterDigWords(body({ feet: true, head: true }), 'dig', '近くに敵')).toBeNull();
    expect(waterDigWords(body({ feet: true, head: true }), 'walk', '泳ぎ（呼吸）')).toBeNull();
    expect(waterDigWords(body({ feet: true, head: true }), 'dig', undefined)).toBeNull();
  });
});

describe('the observation says the free slots of the pack (world.freeSlots), as the body counts them', () => {
  it('counts the empty places of slots 9 to 44, the way pickup does, whatever the rows of the pack list say', () => {
    const slots: any[] = new Array(46).fill(null);
    for (let slot = 9; slot <= 44; slot++) slots[slot] = { name: slot % 2 ? 'cobblestone' : 'dirt', count: 64 };
    slots[0] = { name: 'x', count: 1 }; slots[5] = { name: 'iron_helmet', count: 1 };   // not the pack
    const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0, onGround: true }, username: 'fs', health: 20, food: 20,
      game: { dimension: 'overworld' }, entities: {}, inventory: { items: () => slots.filter(Boolean), slots }, controlState: {}, executingSkill: false, interruptExecution: false, instantSkills: { getSkills: () => [] } });
    const b = new NativeCommonFcaBody(bot, { serverId: 'home', capture: async () => ({ dataUrl: 'data:image/jpeg;base64,YQ==', capturedAt: new Date().toISOString() }) });
    expect((b.observe().state as any).world.freeSlots).toBe(0);
    slots[20] = null; slots[30] = null;
    expect((b.observe().state as any).world.freeSlots).toBe(2);
    return b.dispose();
  });
});
