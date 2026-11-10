import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lastStandChoice, meleeChoice, meleeThreatsNear, runMelee, type MeleeHand } from '../../src/services/minebot/utils/floorReflexes.js';

const SWORD = { name: 'iron_sword', type: 20, count: 1 };
const SHIELD = { name: 'shield', type: 21, count: 1 };
const COBBLE = { name: 'cobblestone', type: 1, count: 32 };
const mob = (id: number, name: string, x = 2.6, z = 0.5) => ({ id, name, type: 'hostile', health: 100,
  height: name === 'wither_skeleton' ? 2.4 : 1.95, width: 0.6, position: new Vec3(x, 64, z) });

function fixture(enemies = [mob(7, 'zombie')], options: { items?: any[]; shield?: boolean; roof?: number; rim?: boolean; corridor?: boolean } = {}) {
  const blocks = new Map<string, string>();
  const calls: Array<{ op: string; at: number; value?: unknown }> = [];
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, name: 'player', position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, onGround: true, metadata: [0] },
    health: 20, food: 20, game: { dimension: 'the_nether' }, entities: Object.fromEntries(enemies.map(entity => [entity.id, entity])),
    inventory: { items: () => options.items ?? [SWORD, COBBLE], slots: new Array(46).fill(null) },
    heldItem: SWORD, controlState: {}, usingHeldItem: false,
    registry: { entitiesByName: Object.fromEntries(enemies.map(entity => [entity.name, { type: 'hostile' }])), blocksByName: { cobblestone: { id: 1 } } },
    setControlState: vi.fn((key: string, value: boolean) => { bot.controlState[key] = value; calls.push({ op: key, at: Date.now(), value }); }),
    clearControlStates: vi.fn(() => { bot.controlState = {}; }), stopDigging: vi.fn(),
    look: vi.fn((yaw: number) => { bot.entity.yaw = yaw; }), lookAt: vi.fn(async () => undefined),
    equip: vi.fn(async (item: any, destination: string) => { if (destination === 'off-hand') bot.inventory.slots[45] = item; else bot.heldItem = item; }),
    activateItem: vi.fn((off: boolean) => { bot.usingHeldItem = true; calls.push({ op: 'shield', at: Date.now(), value: off }); }),
    deactivateItem: vi.fn(() => { bot.usingHeldItem = false; }),
    attack: vi.fn(() => { calls.push({ op: 'attack', at: Date.now() }); }),
    blockAt: (p: Vec3) => {
      const at = p.floored(), key = `${at.x},${at.y},${at.z}`;
      const floor = at.y < 64 && (!options.rim || (at.x === 0 && at.z === 0));
      const wall = options.corridor && at.y >= 64 && (Math.abs(at.z) >= 2 || at.x <= -6 || at.x >= 10 || at.y >= 67);
      const name = blocks.get(key) ?? (wall ? 'nether_bricks' : floor || at.y === options.roof ? 'stone' : 'air');
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', diggable: true, hardness: 1.5, position: at };
    },
    placeBlock: vi.fn(async (reference: any, face: Vec3) => { const at = reference.position.plus(face); blocks.set(`${at.x},${at.y},${at.z}`, bot.heldItem.name); }),
  });
  if (options.shield !== false) bot.inventory.slots[45] = SHIELD;
  return { bot, calls, blocks };
}

function choose(bot: any): MeleeHand | null { return meleeChoice(bot, meleeThreatsNear(bot), { beingHit: true }).hand; }

// end1109o12: cornered on a floor by one zombie, no shield, no block carried to put between, stone over the head: every melee hand said
// 「動ける手が無い」 and the low-health flee had no way; she stood while it struck four times (11.7 → 0) before the head's next decision.

/** Walls round the feet (0,64,0) at both heights, open only toward the enemy in (1,64,0); stone at y=66 over all. */
function cornered(enemies = [mob(7, 'zombie', 1.9)]) {
  const f = fixture(enemies, { items: [SWORD], shield: false });
  const plain = f.bot.blockAt;
  f.bot.blockAt = (p: Vec3) => {
    const at = p.floored();
    const wall = (at.y === 64 || at.y === 65) && !(at.x === 0 && at.z === 0) && !(at.x === 1 && at.z === 0);
    if (wall || at.y === 66) return { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5, position: at };
    return plain(p);
  };
  return f;
}

afterEach(() => { vi.useRealTimers(); });

describe('end1109o12: with no other melee hand, one ordinary enemy gets the blade without a shield', () => {
  it('at full health and at low health, the bare blow is the hand', () => {
    const { bot } = cornered();
    expect(choose(bot)).toMatchObject({ kind: 'hit', bare: true });
    bot.health = 5;
    expect(choose(bot)).toMatchObject({ kind: 'hit', bare: true });
    expect(lastStandChoice(bot)).toMatchObject({ kind: 'melee', hand: { kind: 'hit', bare: true } });
  });

  it('strikes with no shield raised and goes on at health 5', async () => {
    vi.useFakeTimers();
    const { bot } = cornered();
    bot.health = 5;
    const running = runMelee(bot, bot, choose(bot)!);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await running;
    expect(result.success).toBe(true);
    expect(bot.attack).toHaveBeenCalledTimes(2);
    expect(bot.activateItem).not.toHaveBeenCalled();
  });

  it('a step away comes first, a shield makes it the shielded blow; two enemies get the blow too (film 11/10), a heavy one none', () => {
    const open = fixture([mob(7, 'zombie', 1.9)], { items: [SWORD], shield: false }).bot;
    expect(choose(open)?.kind).toBe('step');
    const shielded = cornered().bot;
    shielded.inventory.slots[45] = SHIELD;
    expect(choose(shielded)).toMatchObject({ kind: 'hit' }); expect((choose(shielded) as any).bare).toBeUndefined();
    const two = cornered([mob(7, 'zombie', 1.9), mob(8, 'zombie', 1.9, 0.9)]).bot;
    expect(choose(two)).toMatchObject({ kind: 'hit', crowd: true });
    const heavy = cornered([mob(7, 'wither_skeleton', 1.9)]).bot;
    expect(choose(heavy)?.kind).not.toBe('hit');
  });

  // film 11/10 (15:40): two zombies and a spider, the iron sword carried; the barrier and the pillar failed in turn while she was struck 18 → 0.
  it('a group still on her after a safety hand of the episode gets the blade; the first hand of an episode is still a safety hand', () => {
    const group = () => fixture([mob(7, 'zombie', 1.9), mob(8, 'zombie', 1.9, 0.9)], { items: [SWORD], shield: false }).bot;
    expect(meleeChoice(group(), meleeThreatsNear(group()), { beingHit: true, hands: 0 }).hand?.kind).not.toBe('hit');
    const later = group();
    expect(meleeChoice(later, meleeThreatsNear(later), { beingHit: true, hands: 1 }).hand).toMatchObject({ kind: 'hit', crowd: true, bare: true });
    const heavy = fixture([mob(7, 'wither_skeleton', 1.9), mob(8, 'zombie', 1.9, 0.9)], { items: [SWORD], shield: false }).bot;
    expect(meleeChoice(heavy, meleeThreatsNear(heavy), { beingHit: true, hands: 1 }).hand?.kind).not.toBe('hit');
  });
});
