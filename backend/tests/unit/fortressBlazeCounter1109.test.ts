import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelAction, createMotorPort, executeAction, handoverOf, inheritedIdleShield, physicalRoots } from '../../src/services/minebot/execution/ActionExecution.js';
import { installFloorReflexes, lastStandChoice, meleeChoice, meleeThreatsNear, runLastStand, runMelee, type MeleeHand } from '../../src/services/minebot/utils/floorReflexes.js';
import { installShieldBlock } from '../../src/services/minebot/utils/shieldBlock.js';
import { floorConfig } from '../../src/services/minebot/utils/floorConfig.js';

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

describe('end1109f21: blazes touching her are struck back, not refused as a group', () => {
  it('three blazes within reach: a blow, while three zombies stay refused', () => {
    const blazes = fixture([mob(7, 'blaze', 1.2), mob(8, 'blaze', 1.4, 1.4), mob(9, 'blaze', 1.6, -0.6)], { items: [SWORD] }).bot;
    expect(choose(blazes)?.kind).toBe('hit');
    const zombies = fixture([mob(7, 'zombie', 1.2), mob(8, 'zombie', 1.4, 1.4), mob(9, 'zombie', 1.6, -0.6)], { items: [SWORD] }).bot;
    expect(choose(zombies)?.kind).not.toBe('hit');
  });
});
