import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

const { descentKitNotice } = await import('../../src/services/minebot/utils/nightGate.js');

const registry = minecraftData('1.21.11');
const NIGHT = 18_000;

function body(y: number, timeOfDay: number, items: Array<{ name: string; count?: number }> = [], worn: string[] = []) {
  const slots: Array<{ name: string } | null> = new Array(46).fill(null);
  worn.forEach((name, i) => { slots[5 + i] = { name }; });
  return { version: '1.21.11', registry, username: 'I_am_Shannon', entity: { position: new Vec3(0.5, y, 0.5), onGround: true },
    time: { timeOfDay, day: 3 }, game: { dimension: 'overworld' }, players: {}, entities: {},
    inventory: { items: () => items.map(item => ({ count: 1, ...item })), slots } } as any;
}
const IRON_SUIT = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];

describe('the night kit in the observation (run 19: the iron suit, no bed)', () => {
  it('names the food and the bed as missing, and counts only the missing armour as gated', () => {
    expect(descentKitNotice(body(70, NIGHT, [], IRON_SUIT))).toEqual({ missing: ['cooked_food', 'bed'], gated: false });
    expect(descentKitNotice(body(70, NIGHT))).toEqual({ missing: ['armor', 'cooked_food', 'bed'], gated: true });
  });
});
