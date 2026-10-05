import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: vi.fn(async () => {}) }));
vi.mock('../../src/services/minebot/execution/observedWait.js', () => ({ actionDelay: vi.fn(async () => {}) }));

const { default: AttackContinuously } = await import('../../src/services/minebot/instantSkills/attackContinuously.js');

describe('attack-continuously strikes the blows it was asked for (lab: a call for forty went back after ten, two blazes a block away)', () => {
  it('counts blows, not times round: closing the distance and waiting for a target out of reach are not blows', async () => {
    const target: any = { id: 2, name: 'blaze', position: new Vec3(0, 70, 0), height: 1.8, isValid: true };
    let rounds = 0, blows = 0;
    const bot: any = { entity: { id: 1, position: new Vec3(0, 64, 0) }, health: 20, minebotControlState: 'idle',
      entities: { 2: target }, inventory: { items: () => [{ name: 'stone_sword', count: 1 }], slots: [] }, heldItem: { name: 'stone_sword' },
      equip: async () => {}, setControlState: () => {}, pathfinder: { stop: () => {} },
      nearestEntity: (match: (entity: any) => boolean) => (match(target) ? target : null),
      // Out of reach above for the first forty rounds (a blaze hovering), then down within a blow.
      lookAt: async () => {}, attack: async () => { blows++; if (blows >= 8) target.isValid = false; } };
    const skill: any = new AttackContinuously(bot);
    skill.shouldInterrupt = () => { if (++rounds === 40) target.position = new Vec3(0, 66, 0); return rounds > 400; };
    skill.collectNearbyDrops = async () => [];
    const result = await skill.runImpl('blaze', 30, 24, 1);
    expect(blows).toBe(8);                                               // all of them, after forty rounds without one
    expect(result.success).toBe(true);
    expect(result.result).toContain('1体撃破');
    expect(result.result).toContain('計8回攻撃');
  });

  it('stops at the number of blows asked for', async () => {
    const target: any = { id: 2, name: 'zombie', position: new Vec3(2, 64, 0), height: 1.95, isValid: true };
    let blows = 0;
    const bot: any = { entity: { id: 1, position: new Vec3(0, 64, 0) }, health: 20, minebotControlState: 'idle',
      entities: { 2: target }, inventory: { items: () => [], slots: [] }, heldItem: null,
      equip: async () => {}, setControlState: () => {}, pathfinder: { stop: () => {} },
      nearestEntity: (match: (entity: any) => boolean) => (match(target) ? target : null),
      lookAt: async () => {}, attack: async () => { blows++; } };
    const skill: any = new AttackContinuously(bot);
    skill.shouldInterrupt = () => false;
    skill.collectNearbyDrops = async () => [];
    const result = await skill.runImpl('zombie', 5, 24, 0);
    expect(blows).toBe(5);
    expect(result.result).toContain('未撃破');
  });
});
