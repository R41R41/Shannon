import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { shouldRefuseAggressiveCombat } from '../../src/services/minebot/utils/minebotToolPolicy.js';

const body = (overrides: Record<string, unknown> = {}) => ({ minebotControlState: 'emergency_llm', health: 7,
  entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: {}, ...overrides }) as any;

describe('what an emergency refuses is a fight, not a meal (paid run L61 was told to hunt and forbidden to)', () => {
  it('refuses going at a hostile, or at nothing in particular, during an emergency', () => {
    expect(shouldRefuseAggressiveCombat(body())).toContain('緊急対応中');
    expect(shouldRefuseAggressiveCombat(body(), '')).toContain('緊急対応中');
    expect(shouldRefuseAggressiveCombat(body(), 'zombie')).toContain('緊急対応中');
    expect(shouldRefuseAggressiveCombat(body({ minebotControlState: 'emergency_reflect' }), 'skeleton')).toContain('緊急対応中');
  });

  it('lets the body strike back at what is already within a blow of it, and still not go to a fight (lab continuation L77p: told to flee a wither skeleton a block away)', () => {
    const cornered = body({ entities: { 2: { id: 2, name: 'wither_skeleton', type: 'hostile', position: new Vec3(1.3, 64, 0) } } });
    expect(shouldRefuseAggressiveCombat(cornered, 'wither_skeleton')).toBeNull();
    expect(shouldRefuseAggressiveCombat(cornered)).toBeNull();
    const apart = body({ entities: { 2: { id: 2, name: 'wither_skeleton', type: 'hostile', position: new Vec3(9, 64, 0) } } });
    expect(shouldRefuseAggressiveCombat(apart, 'wither_skeleton')).toContain('緊急対応中');
    // An animal is still not hunted with a hostile on the body.
    expect(shouldRefuseAggressiveCombat(cornered, 'rabbit')).toContain('flee-from');
  });

  it('does not refuse a blow struck from where the body stands: that is how it fights from where the other cannot get at it (lab: three wither skeletons from a pillar three up, no blow taken)', () => {
    const apart = body({ entities: { 2: { id: 2, name: 'wither_skeleton', type: 'hostile', position: new Vec3(9, 64, 0) } } });
    expect(shouldRefuseAggressiveCombat(apart, 'wither_skeleton', true)).toBeNull();
    expect(shouldRefuseAggressiveCombat(body({ minebotControlState: 'normal', health: 4, entities: apart.entities }), 'wither_skeleton', true)).toBeNull();
    expect(shouldRefuseAggressiveCombat(apart, 'wither_skeleton', false)).toContain('緊急対応中');
  });

  it('lets a starving body kill an animal for food during an emergency', () => {
    expect(shouldRefuseAggressiveCombat(body(), 'rabbit')).toBeNull();
    expect(shouldRefuseAggressiveCombat(body(), 'Cow')).toBeNull();
  });

  it('still refuses any attack at low health with a hostile close by, and none in ordinary work', () => {
    const cornered = body({ entities: { 2: { id: 2, name: 'zombie', type: 'hostile', position: new Vec3(3, 64, 0) } } });
    expect(shouldRefuseAggressiveCombat(cornered, 'rabbit')).toContain('flee-from');
    expect(shouldRefuseAggressiveCombat(body({ minebotControlState: 'idle', health: 20 }), 'zombie')).toBeNull();
  });
});
