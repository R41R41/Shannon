import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attack } from '../../src/services/minebot/utils/primitives/attack.js';
import { meleeChoice, meleeThreatsNear } from '../../src/services/minebot/utils/floorReflexes.js';

// end1108h21 (11/8): 13 blazes killed by sword, 3 rods; and the death: a blaze 0.8 m off struck her five times in 5 s on a bridge while the
// head decided, and no blow came back (a shooter was never a melee enemy for the floor).

const SWORD = { name: 'iron_sword', type: 20, count: 1 };
const SHIELD = { name: 'shield', type: 21, count: 1 };
const COBBLE = { name: 'cobblestone', type: 1, count: 32 };
const blaze = (id: number, x: number, y: number, z: number) => ({ id, name: 'blaze', type: 'hostile', health: 20, height: 1.8, width: 0.6, position: new Vec3(x, y, z), metadata: [] as unknown[] });

function body(enemies: any[], options: { voidBelow?: boolean; shield?: boolean } = {}) {
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, name: 'player', position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, onGround: true, metadata: [0], height: 1.8 },
    health: 18, food: 20, game: { dimension: 'the_nether' }, entities: Object.fromEntries(enemies.map(e => [e.id, e])),
    inventory: { items: () => [SWORD, COBBLE], slots: new Array(46).fill(null) },
    heldItem: SWORD, controlState: {}, usingHeldItem: false,
    registry: { entitiesByName: { blaze: { type: 'hostile' } }, blocksByName: { cobblestone: { id: 1 } }, itemsByName: {}, items: {} },
    setControlState: () => undefined, clearControlStates: () => undefined, lookAt: async () => undefined, look: () => undefined,
    equip: async (item: any, destination?: string) => { if (destination === 'off-hand') bot.inventory.slots[45] = item; else bot.heldItem = item; },
    activateItem: () => { bot.usingHeldItem = true; }, deactivateItem: () => { bot.usingHeldItem = false; },
    blockAt: (p: Vec3) => {
      const at = p.floored();
      // The floor: one row at y 63 under x 0..1 (a bridge); with voidBelow, nothing else down to y 0.
      const floor = at.y === 63 && (!options.voidBelow || (at.x >= -1 && at.x <= 1 && at.z === 0));
      const name = floor || (!options.voidBelow && at.y < 63) ? 'nether_bricks' : 'air';
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', diggable: true, hardness: 2, position: at };
    },
  });
  if (options.shield !== false) bot.inventory.slots[45] = SHIELD;
  return bot;
}
const ctx = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 120_000, facing: 'north' as const, base: { x: 0, y: 64, z: 0 } });

describe('a blaze at contact is a melee enemy for the floor', () => {
  it('a blaze 1.5 m off is one; one 4 m off is still only a shooter', () => {
    expect(meleeThreatsNear(body([blaze(9, 2.0, 64, 0.5)])).map(t => t.entity.id)).toEqual([9]);
    expect(meleeThreatsNear(body([blaze(9, 4.5, 64, 0.5)]))).toEqual([]);
  });

  it('the hand against it is two blows with the blade, at a bridge\'s rim too', () => {
    for (const voidBelow of [false, true]) {
      const bot = body([blaze(9, 2.0, 64, 0.5)], { voidBelow });
      const hand = meleeChoice(bot, meleeThreatsNear(bot), { beingHit: true }).hand;
      expect(hand?.kind).toBe('hit');
      expect((hand as any).weapon.name).toBe('iron_sword');
      expect(hand?.detail).toContain('blaze');
    }
  });

  it('no blow at low health or without a shield (the counter rule as for every melee enemy)', () => {
    const low = body([blaze(9, 2.0, 64, 0.5)]); low.health = 5;
    expect(meleeChoice(low, meleeThreatsNear(low), { beingHit: true }).hand?.kind).not.toBe('hit');
    const bare = body([blaze(9, 2.0, 64, 0.5)], { shield: false });
    expect(meleeChoice(bare, meleeThreatsNear(bare), { beingHit: true }).hand?.kind).not.toBe('hit');
  });
});

describe('a blaze killed by attack: whether a rod dropped and where it falls', () => {
  afterEach(() => { vi.useRealTimers(); });

  async function kill(voidBelow: boolean, drops: boolean) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bot = body([blaze(5, 1.5, 64, 0.5)], { voidBelow });
    bot.attack = () => {
      const at = bot.entities[5].position.clone();
      delete bot.entities[5];
      bot.emit('entityDead', { id: 5, position: at });
      if (drops) bot.entities[77] = { id: 77, name: 'item', position: at.offset(0, 0.2, 0), getDroppedItem: () => ({ name: 'blaze_rod', count: 1 }) };
    };
    const running = attack(ctx(bot), { target: 5, chase: false, maxSeconds: 5 });
    await vi.advanceTimersByTimeAsync(3_000);
    return running;
  }

  it('over a floor: the rod and its cell, to be picked up', async () => {
    const out = await kill(false, true);
    expect(out.ok).toBe(true);
    expect(out.text).toContain('ロッドが落ちた (1,64,0)');
    expect(out.text).toContain('pickup target=blaze_rod');
  });

  it('no rod: said so, with the half chance', async () => {
    const out = await kill(false, false);
    expect(out.text).toContain('ロッドは落ちなかった');
  });

  it('a kill off the bridge: the rod falls into the void', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bot = body([blaze(5, 2.5, 64, 0.5)], { voidBelow: true });
    bot.attack = () => {
      const at = bot.entities[5].position.clone();
      delete bot.entities[5];
      bot.emit('entityDead', { id: 5, position: at });
      bot.entities[77] = { id: 77, name: 'item', position: at.offset(0, 0.2, 0), getDroppedItem: () => ({ name: 'blaze_rod', count: 1 }) };
    };
    const running = attack(ctx(bot), { target: 5, chase: false, maxSeconds: 5 });
    await vi.advanceTimersByTimeAsync(3_000);
    const out = await running;
    expect(out.text).toContain('48 段以上空所で、拾えない');
  });

  // end1108h29: three endermen killed by attack, and the head never heard whether a pearl dropped.
  async function killEnderman(drops: boolean) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bot = body([blaze(5, 1.5, 64, 0.5)], { voidBelow: false });
    bot.entities[5].name = 'enderman'; bot.entities[5].height = 2.9;
    bot.attack = () => {
      const at = bot.entities[5].position.clone();
      delete bot.entities[5];
      bot.emit('entityDead', { id: 5, position: at });
      if (drops) bot.entities[78] = { id: 78, name: 'item', position: at.offset(0, 0.2, 0), getDroppedItem: () => ({ name: 'ender_pearl', count: 1 }) };
    };
    const running = attack(ctx(bot), { target: 5, chase: false, maxSeconds: 5 });
    await vi.advanceTimersByTimeAsync(3_000);
    return running;
  }

  it('an enderman: the pearl and its cell, to be picked up', async () => {
    const out = await killEnderman(true);
    expect(out.ok).toBe(true);
    expect(out.text).toContain('パールが落ちた (1,64,0)');
    expect(out.text).toContain('pickup target=ender_pearl');
  });

  it('an enderman with no pearl: said so, with the half chance', async () => {
    const out = await killEnderman(false);
    expect(out.text).toContain('パールは落ちなかった（エンダーマンが落とすのは半分）');
  });
});
