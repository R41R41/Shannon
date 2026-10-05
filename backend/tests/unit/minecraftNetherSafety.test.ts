import { describe, expect, it, vi } from 'vitest';
import minecraftData from 'minecraft-data';
import { HARMFUL_TO_STAND_IN, setMovements } from '../../src/services/minebot/utils/setMovements.js';
import { Vec3 } from 'vec3';
import { LAVA_BESIDE_COST, lavaBeside, lavaBesideStepCost } from '../../src/services/minebot/utils/lavaClearance.js';
import { describeHarm } from '../../src/services/minebot/utils/harm.js';
import { CombatEventHandler } from '../../src/services/minebot/eventReaction/handlers/CombatEventHandler.js';

const LAVA = 96;
const world = (lavaCells: string[]) => ({ registry: { blocksByName: { lava: { minStateId: 96, maxStateId: 111 } } },
  world: { getBlockStateId: (p: Vec3) => lavaCells.includes(`${p.x},${p.y},${p.z}`) ? LAVA + 3 : 1 } });

describe('lava is given room by the route planner (paid run L77b: a route along a lava fall, a corner brushed it)', () => {
  it('costs a step with lava in any of the eight cells around it, at the feet or at the head', () => {
    expect(lavaBeside(world(['291,35,-294']), 291, 35, -293)).toBe(true);   // straight beside
    expect(lavaBeside(world(['291,35,-294']), 292, 35, -293)).toBe(true);   // across the corner
    expect(lavaBeside(world(['291,36,-294']), 291, 35, -293)).toBe(true);   // at head height
    expect(lavaBeside(world(['291,35,-294']), 293, 35, -293)).toBe(false);  // two cells off
    expect(lavaBeside(world(['291,34,-293']), 291, 35, -293)).toBe(false);  // under the floor it walks on: no contact
    const cost = lavaBesideStepCost(world(['291,35,-294']));
    expect(cost({ position: { x: 291, y: 35, z: -293 } })).toBe(LAVA_BESIDE_COST);
    expect(cost({ position: { x: 280, y: 35, z: -293 } })).toBe(0);
    expect(cost({})).toBe(0);
  });

  it('says nothing where the world cannot be read', () => {
    expect(lavaBeside({}, 0, 0, 0)).toBe(false);
  });
});

describe('damage with no attacker is described by what the body can tell is hurting it (paid run L77b burned to death told to "eat or wait")', () => {
  const burning = { metadata: [0x01], effects: {} };
  it('names fire, and says that in the Nether there is no water to put it out with', () => {
    const nether = describeHarm({ entity: burning, food: 18, game: { dimension: 'the_nether' } })!;
    expect(nether).toContain('燃えています');
    expect(nether).toContain('ネザー');
    const overworld = describeHarm({ entity: burning, food: 18, game: { dimension: 'overworld' } })!;
    expect(overworld).toContain('水に入るか');
  });

  it('names lava, hunger and poison, and stays silent when nothing it carries says what it was', () => {
    expect(describeHarm({ entity: { isInLava: true, metadata: [0x01] }, food: 20 })).toContain('溶岩の中');
    expect(describeHarm({ entity: { metadata: [0] }, food: 0 })).toContain('空腹');
    expect(describeHarm({ entity: { metadata: [0], effects: { 19: { id: 19 } } }, food: 20, registry: { effects: { 19: { name: 'Poison' } } } })).toContain('毒');
    expect(describeHarm({ entity: { metadata: [0] }, food: 20 })).toBeUndefined();
  });

  it('puts it in the emergency message with what is wanted, not a list of means', () => {
    const message = CombatEventHandler.buildEmergencyMessage({ eventType: 'damage', timestamp: 0, damage: 1, damagePercent: 5, currentHealth: 7.9,
      consecutiveCount: 5, harm: '身体が燃えています' } as any)!;
    expect(message).toContain('身体が燃えています');
    expect(message).toContain('【目的】体力を削っているものを止める');
    expect(message).not.toContain('チャット');
    const unknown = CombatEventHandler.buildEmergencyMessage({ eventType: 'damage', timestamp: 0, damage: 4, damagePercent: 20, currentHealth: 9,
      consecutiveCount: 1 } as any)!;
    expect(unknown).toContain('身体からは分かりません');
  });
});

import { ATTACK_MEMORY_MS, isHostileEntity, isLikelyHostileMobName, isThreatEntity, noteAttackedBy } from '../../src/services/minebot/utils/hostileMobHints.js';
import { estimateEncounter, seedCombatStats } from '../../src/modules/minecraftLearning/index.js';

describe('a kind of mob that has just hit the body is hostile to it, whatever it is called', () => {
  it('gives one answer to "is this a threat" for the watch, the end of an emergency and the count of who arrives first (lab: a shelter refused for a zombified piglin five blocks off)', () => {
    // The game's category calls these hostile; they leave the body alone until it gives them cause.
    expect(isThreatEntity({ name: 'zombified_piglin', type: 'hostile' }, 'hostile', 5_000_000)).toBe(false);
    expect(isThreatEntity({ name: 'piglin', type: 'hostile' }, 'hostile', 5_000_000)).toBe(false);
    // What the list names, and what the game's category names beyond the list, are threats as before.
    expect(isThreatEntity({ name: 'wither_skeleton', type: 'hostile' }, 'hostile')).toBe(true);
    expect(isThreatEntity({ name: 'ghast', type: 'mob' }, 'mob')).toBe(true);
    expect(isThreatEntity({ name: 'silverfish', type: 'hostile' }, undefined)).toBe(true);
    expect(isThreatEntity({ name: 'cow', type: 'animal' }, 'animal')).toBe(false);
    expect(isThreatEntity(null)).toBe(false);
    // One that has struck is a threat for a while, then left alone again.
    noteAttackedBy('zombified_piglin', 6_000_000);
    expect(isThreatEntity({ name: 'zombified_piglin', type: 'hostile' }, 'hostile', 6_000_001)).toBe(true);
    expect(isThreatEntity({ name: 'zombified_piglin', type: 'hostile' }, 'hostile', 6_000_000 + ATTACK_MEMORY_MS + 1)).toBe(false);
  });

  it('learns a piglin from the hit, and lets it go again after a while', () => {
    expect(isLikelyHostileMobName('piglin', 1_000)).toBe(false);
    expect(isLikelyHostileMobName('zombified_piglin', 1_000)).toBe(false);   // not a zombie
    noteAttackedBy('Piglin', 1_000);
    expect(isLikelyHostileMobName('piglin', 2_000)).toBe(true);
    expect(isLikelyHostileMobName('zombified_piglin', 2_000)).toBe(false);   // another kind
    expect(isLikelyHostileMobName('piglin', 1_000 + ATTACK_MEMORY_MS + 1)).toBe(false);
    // What is known beforehand stays known.
    expect(isLikelyHostileMobName('wither_skeleton', 0)).toBe(true);
  });
});

describe('a route does not walk through what burns the body (lab continuation L77n: nine minutes in a one-block pocket beside a soul fire)', () => {
  it('soul fire and the like are cells to strike out of the way, as ordinary fire always was, not cells to walk into', () => {
    const registry = minecraftData('1.21.11');
    const apply = vi.fn();
    const soulFire = registry.blocksByName.soul_fire;
    setMovements({ version: '1.21.11', registry, inventory: { items: () => [] }, pathfinder: { setMovements: apply },
      blockAt: () => ({ type: soulFire.id, name: 'soul_fire', boundingBox: 'empty', shapes: [], position: new Vec3(0, 0, 0) }) } as any);
    const movement = apply.mock.calls[0][0];
    for (const name of HARMFUL_TO_STAND_IN) expect(movement.blocksToAvoid.has(registry.blocksByName[name].id), name).toBe(true);
    expect(HARMFUL_TO_STAND_IN).toContain('soul_fire');
    // An avoided cell with no body to it is not "safe" to the planner, so it is broken through or gone round.
    expect(movement.getBlock({ x: 0, y: 0, z: 0 }, 0, 0, 0).safe).toBe(false);
  });
});

describe('an enderman is left alone until it is angry or has struck (paid run L85: one wandering six blocks off was an emergency, "2.1 s to kill", struck, and killed the body)', () => {
  const registry = { entitiesByName: { enderman: { metadataKeys: ['shared_flags', 'air_supply', 'custom_name', 'custom_name_visible', 'silent', 'no_gravity', 'pose', 'ticks_frozen',
    'living_entity_flags', 'health', 'effect_particles', 'effect_ambience', 'arrow_count', 'stinger_count', 'sleeping_pos', 'mob_flags', 'carry_state', 'creepy', 'stared_at'] } } };
  it('is no threat while calm, and one while the server shows it angry', () => {
    const calm: any = { name: 'enderman', type: 'hostile', metadata: [] };
    calm.metadata[17] = false;
    const angry: any = { name: 'enderman', type: 'hostile', metadata: [] };
    angry.metadata[17] = true;
    expect(isLikelyHostileMobName('enderman', 9_000_000)).toBe(false);
    expect(isHostileEntity(calm, { registry }, 9_000_000)).toBe(false);
    expect(isThreatEntity(calm, 'hostile', 9_000_000, { registry })).toBe(false);
    expect(isHostileEntity(angry, { registry }, 9_000_000)).toBe(true);
    expect(isThreatEntity(angry, 'hostile', 9_000_000, { registry })).toBe(true);
    // Without the data's names the flag cannot be read: calm, as for any neutral kind.
    expect(isHostileEntity(angry, null, 9_000_000)).toBe(false);
    // The hostile kinds are as before.
    expect(isHostileEntity({ name: 'zombie' }, { registry })).toBe(true);
  });

  it('the time to kill is for the health the mob has, not the twenty the weapon priors were made for', () => {
    const stats = seedCombatStats();
    const input = { health: 20, threats: [{ name: 'enderman', distance: 0 }], carried: ['iron_sword'], escapeFailing: true };
    const zombie = estimateEncounter(stats, { ...input, target: 'zombie', threats: [{ name: 'zombie', distance: 0 }] }).timeToKillMs;
    const enderman = estimateEncounter(stats, { ...input, target: 'enderman' }).timeToKillMs;
    expect(zombie).toBeCloseTo(2083, -1);
    expect(enderman).toBeCloseTo(2 * zombie, -1);                 // forty health, by the game's figure
    expect(estimateEncounter(stats, { ...input, target: 'enderman', targetHealth: 10 }).timeToKillMs).toBeCloseTo(zombie / 2, -1);   // the server's figure when read
  });
});

describe('a piglin goes for a body that wears no gold (paid run L88b: two of them killed it a minute after the portal, wearing iron)', () => {
  const slots = (feet?: string) => { const list: any[] = []; list[5] = { name: 'iron_helmet' }; if (feet) list[8] = { name: feet }; return list; };
  it('is a threat to a body without gold, and not to one with a piece of it on', () => {
    const piglin = { name: 'piglin', type: 'hostile' };
    expect(isHostileEntity(piglin, { inventory: { slots: slots() } })).toBe(true);
    expect(isThreatEntity(piglin, 'hostile', 9_000_000, { inventory: { slots: slots() } })).toBe(true);
    expect(isHostileEntity(piglin, { inventory: { slots: slots('golden_boots') } })).toBe(false);
    expect(isThreatEntity(piglin, 'hostile', 9_000_000, { inventory: { slots: slots('golden_boots') } })).toBe(false);
    // A zombified piglin is neutral either way; with no body to judge for, a piglin is left as it was.
    expect(isHostileEntity({ name: 'zombified_piglin' }, { inventory: { slots: slots() } })).toBe(false);
    expect(isThreatEntity(piglin, 'hostile', 9_000_000)).toBe(false);
  });
});

describe('magma under the feet is named as what hurts (paid run L94)', () => {
  it('says the body stands on magma and what stops it', () => {
    const blockAt = (p: any) => (p.y === 70 ? { name: 'magma_block' } : { name: 'air' });
    const said = describeHarm({ entity: { position: new Vec3(0.5, 71, 0.5) }, blockAt, food: 10, game: { dimension: 'the_nether' } } as any)!;
    expect(said).toContain('マグマブロック');
    expect(said).toContain('しゃがむ');
  });
});

