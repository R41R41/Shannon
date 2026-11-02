import fs from 'node:fs';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { endObservation } from '../../src/services/minebot/utils/dragonState.js';

/**
 * The End fields of the observation (state.world: dragon, crystals, perch, dragonBreath, dragonFireballs) as the isolated lab made them: for each situation the inputs (the entities that matter,
 * the body's own state, the registry's metadata keys, the blocks the code read) and the fields the body gave. The body is built again from the inputs and has to give the same fields. The
 * head's tests read `observation.expected.json` (the same fields). Regenerate with backend/scripts/lab/split-end-observation.mjs after the probe's scenes enter,observe.
 */
const readFixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`../fixtures/end/${name}`, import.meta.url), 'utf8'));
const inputs = readFixture('observation.inputs.json') as { situations: Array<{ label: string; input: any }> };
const wanted = readFixture('observation.expected.json') as { situations: Array<{ label: string; note: string; expected: any }> };

/** A body that holds what the lab body held: the cells it read come from the recorded table, any other cell is not loaded. */
function botFrom(input: any): any {
  const entities: Record<number, any> = {};
  for (const e of input.entities) {
    entities[e.id] = { id: e.id, name: e.name, position: new Vec3(e.position.x, e.position.y, e.position.z), yaw: e.yaw, pitch: e.pitch, ...(e.health !== undefined ? { health: e.health } : {}),
      metadata: e.metadata.map((value: unknown) => value ?? undefined) };
  }
  const slots: Array<{ name: string } | undefined> = [];
  (input.bot.armor as Array<string | null>).forEach((name, index) => { if (name) slots[5 + index] = { name }; });
  return {
    entity: { id: 1, position: new Vec3(input.bot.position.x, input.bot.position.y, input.bot.position.z), yaw: input.bot.yaw, pitch: input.bot.pitch, onGround: true, velocity: new Vec3(0, 0, 0) },
    entities, health: input.bot.health, food: input.bot.food, game: input.bot.game, inventory: { slots },
    registry: { entitiesByName: Object.fromEntries(Object.entries(input.registryKeys as Record<string, string[] | null>).filter(([, keys]) => keys).map(([name, metadataKeys]) => [name, { metadataKeys }])) },
    toldVelocities: new Map(Object.entries(input.toldVelocities as Record<string, { x: number; y: number; z: number }>).map(([id, v]) => [Number(id), new Vec3(v.x, v.y, v.z)])),
    blockAt: (position: Vec3) => {
      const index = input.cells[`${position.x},${position.y},${position.z}`];
      return index === undefined || index === null ? null : { ...input.types[index], position };
    },
  };
}

describe('the End fields of the observation, as the isolated lab made them', () => {
  it('has the situations the head reads', () => {
    const labels = wanted.situations.map(situation => situation.label);
    for (const label of ['arrival', 'dragon_flying', 'dragon_perched_out_of_reach', 'dragon_perched_in_reach', 'crystals_near_caged_and_open', 'breath_cloud_just_seen', 'breath_cloud_growing', 'fireball_in_flight']) expect(labels).toContain(label);
    expect(inputs.situations.map(situation => situation.label)).toEqual(labels);
  });
  for (const { label, input } of inputs.situations) {
    it(`gives the lab's fields again for "${label}"`, () => {
      const expected = wanted.situations.find(situation => situation.label === label)!.expected;
      const bot = botFrom(input);
      endObservation(bot, input.now); // the phase clock starts with the first look
      const again = endObservation(bot, input.now + Math.round((expected.dragon?.phaseFor ?? 0) * 1000));
      expect(JSON.parse(JSON.stringify(again))).toEqual(expected);
    });
  }
  it('tells what each situation is, by the fields', () => {
    const of = (label: string) => wanted.situations.find(situation => situation.label === label)!.expected;
    expect(of('arrival')).toMatchObject({ crystals: { remaining: 10, gone: 0 }, dragonBreath: [], dragonFireballs: 0 });
    expect(of('arrival').dragon).toBeUndefined();
    expect(of('dragon_flying').dragon).toMatchObject({ perched: false });
    expect(of('dragon_flying').dragon.headPosition).toBeUndefined();
    expect(of('dragon_perched_out_of_reach').dragon).toMatchObject({ perched: true, strike: false });
    expect(of('dragon_perched_out_of_reach').dragon.headPosition).toBeDefined();
    expect(of('dragon_perched_in_reach').dragon).toMatchObject({ perched: true, strike: true });
    expect(of('crystals_near_caged_and_open').crystals.list.some((crystal: any) => crystal.caged === true && typeof crystal.blast === 'number')).toBe(true);
    expect(of('crystals_near_caged_and_open').crystals.list.some((crystal: any) => crystal.caged === false && typeof crystal.blast === 'number')).toBe(true);
    expect(of('breath_cloud_just_seen').dragonBreath[0]).toMatchObject({ radius: 7, dangerRadius: 7 });
    expect(of('breath_cloud_growing').dragonBreath[0].radius).toBeLessThan(4);
    expect(of('fireball_in_flight').dragonFireballs).toBe(1);
  });
});
