import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { findEntity } from '../../src/services/minebot/utils/primitives/use.js';

// A kind named by its name is not the corpse that is still shown for its death (S2 lab, 2026-11-02: "fight target=blaze" took the blaze it had just killed for the nearest one and
// answered "lost"); a creature named by its id is whatever is there.

const KEYS = ['shared_flags', 'air_supply', 'custom_name', 'custom_name_visible', 'silent', 'no_gravity', 'pose', 'ticks_frozen', 'living_entity_flags', 'health', 'effect_particles'];
const registry = { entitiesByName: { blaze: { metadataKeys: KEYS }, item: { metadataKeys: ['shared_flags', 'air_supply', 'custom_name', 'custom_name_visible', 'silent', 'no_gravity', 'pose', 'ticks_frozen', 'item'] } } };
const blaze = (id: number, x: number, health: number) => ({ id, name: 'blaze', position: new Vec3(x, 64, 0.5), metadata: KEYS.map((_, index) => (index === 9 ? health : 0)) });

describe('findEntity by name', () => {
  const bot = (entities: any[]) => ({ entity: { position: new Vec3(0.5, 64, 0.5) }, registry, entities: Object.fromEntries(entities.map(entity => [entity.id, entity])) });

  it('passes over a blaze at 0 health (its death is still shown) for the nearest one that lives', () => {
    const body = bot([blaze(1, 2.5, 0), blaze(2, 6.5, 20)]);
    expect(findEntity(body, 'blaze')?.id).toBe(2);
  });

  it('with only the dying one left, nothing is found; by its id it is still there', () => {
    const body = bot([blaze(1, 2.5, 0)]);
    expect(findEntity(body, 'blaze')).toBeNull();
    expect(findEntity(body, 1)?.id).toBe(1);
    expect(findEntity(body, '1')?.id).toBe(1);
  });

  it('a kind with no health datum, or a health that cannot be read, is not taken for dying', () => {
    const lying = { id: 5, name: 'item', position: new Vec3(1.5, 64, 0.5), metadata: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
    const unread = { id: 6, name: 'blaze', position: new Vec3(3.5, 64, 0.5) };
    const body = bot([lying, unread]);
    expect(findEntity(body, 'item')?.id).toBe(5);
    expect(findEntity(body, 'blaze')?.id).toBe(6);
  });
});
