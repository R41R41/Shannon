import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { describe, expect, it, vi } from 'vitest';
import { bodySkillCatalog, OFFERED_TOOLS, type BodySkill } from '../../src/services/minebot/integration/commonFca/skillCatalog.js';
import { floorEatChoice } from '../../src/services/minebot/utils/floorReflexes.js';
import { captureWorldObservation } from '../../src/services/minebot/cognition/worldFrame.js';
import { pickaxeUsesCheck } from '../../src/services/minebot/utils/toolStock.js';

// The body of design mb-llm-centric 2.4: the planner is offered act, view, probe and the readers, and the body's own choices are not made.
const modules = import.meta.glob('../../src/services/minebot/instantSkills/*.ts');

describe('the LLM-centric body', () => {
  it('offers act, view and the readers, act\'s schema crossing the wire', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('OFFLINE_TEST_NETWORK_FORBIDDEN'); });
    try {
      const skills: BodySkill[] = [];
      const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', registry: minecraftData('1.21.11'),
        entity: { position: new Vec3(0, 65, 0) }, entities: {}, inventory: { items: () => [], slots: [] },
        instantSkills: { getSkills: () => skills, getSkill: (name: string) => skills.find(s => s.skillName === name) },
        constantSkills: { getSkills: () => [], getSkill: () => undefined }, selfState: {}, environmentState: {} });
      for (const load of Object.values(modules)) {
        const module = await load() as { default?: new (bot: any) => BodySkill };
        skills.push(new module.default!(bot));
      }
      const on = bodySkillCatalog(skills, bot);
      expect(on.definitions.map(skill => skill.name)).toEqual(OFFERED_TOOLS.filter(name => on.runnable.some(skill => skill.name === name)));
      expect(on.definitions.length).toBeGreaterThanOrEqual(15);
      expect(on.definitions.length).toBeLessThanOrEqual(25);
      expect(on.definitions.some(skill => skill.name === 'move-to' || skill.name === 'mine-block')).toBe(false);
      const act = on.definitions.find(skill => skill.name === 'act')!;
      expect(JSON.stringify(act.inputSchema).length).toBeLessThan(16_000);
      expect((act.inputSchema as any).properties.hands.maxItems).toBe(12);
      expect(Object.keys((act.inputSchema as any).properties.hands.items.properties).length).toBeLessThanOrEqual(32);
      // The planner's call (the head's ActInput) reaches the skill as parsed hands.
      const resolved = on.resolve('act', { hands: [{ do: 'dig', at: [{ x: 1, y: 2, z: 3 }, { front: 1 }], exposeOk: ['blaze'] }], stopIf: { hpBelow: 8 }, why: '棒を取る' });
      expect(resolved.args[0]).toEqual([{ do: 'dig', at: [{ x: 1, y: 2, z: 3 }, { front: 1 }], exposeOk: ['blaze'] }]);
      expect(resolved.args[1]).toEqual({ hpBelow: 8 });
      expect(() => on.resolve('act', { hands: [{ do: 'fly' }] })).toThrow();
      expect(on.resolve('view', { mode: 'slice', axis: 'ew', only: ['iron_ore', 'L'], center: { x: 1, y: 2, z: 3 }, radius: 8 }).args[6]).toEqual(['iron_ore', 'L']);
      // r4: probe, read only, right after view; the head's inputs reach it.
      expect(on.definitions.map(skill => skill.name).slice(0, 3)).toEqual(['act', 'view', 'probe']);
      expect(on.definitions.find(skill => skill.name === 'probe')!.readOnly).toBe(true);
      expect(on.resolve('probe', { kind: 'sight', target: '#12' }).args.slice(0, 4)).toEqual(['sight', undefined, undefined, '#12']);
      expect(on.resolve('probe', { kind: 'sight', target: { x: 1, y: 2, z: 3 } }).args[3]).toEqual({ x: 1, y: 2, z: 3 });
      expect(on.resolve('probe', { kind: 'column', x: 4, z: -2, yFrom: 40, yTo: 70 }).args.slice(4, 8)).toEqual([4, -2, 40, 70]);
      expect(on.resolve('probe', { kind: 'history', at: { x: 1, y: 64, z: 2 }, radius: 4 }).args.slice(8, 10)).toEqual([4, { x: 1, y: 64, z: 2 }]);
      expect(() => on.resolve('probe', { kind: 'look' })).toThrow();
      if (process.env.FCA_API_WIRE_ROOT) {
        const validation = await import(`${process.env.FCA_API_WIRE_ROOT}/src/surfaces/minecraft/minecraftControlValidation.ts`);
        expect(validation.validSkills(on.definitions)).toBe(true);
      }
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it('the floor eats only starving or nearly dead', () => {
    const fed = (food: number, health: number): any => ({ food, health, entity: { position: new Vec3(0, 64, 0) }, entities: {},
      inventory: { items: () => [{ name: 'bread', count: 3 }] }, setControlState: () => undefined, on: () => undefined });
    expect(floorEatChoice(fed(12, 20))).toBeNull();
    expect(floorEatChoice(fed(3, 20))?.name).toBe('bread');
    expect(floorEatChoice(fed(10, 6))?.name).toBe('bread');
  });

  it('the observation of a live body has the map, the marks and food points', () => {
    const world = (): any => Object.assign(new EventEmitter(), { entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 }, health: 20, food: 18,
      entities: { 3: { id: 3, name: 'enderman', type: 'mob', position: new Vec3(4, 64, 0), metadata: [] } },
      inventory: { items: () => [{ name: 'bread', count: 2 }] }, game: { dimension: 'overworld' },
      blockAt: (p: Vec3) => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }) });
    const on = captureWorldObservation(world());
    expect(on.localMap).toContain('地図 v1 足=(0,64,0)');
    expect(on.localMap).toContain('方式=surface');
    expect(on.foodPoints?.carried).toBe(22);
    expect(on.nearbyEntities[0]).toMatchObject({ id: 3, angry: false });
  });

  it('says a pickaxe short of a job, and makes no spare', () => {
    const worn: any = { inventory: { items: () => [{ name: 'stone_pickaxe', count: 1, maxDurability: 131, durabilityUsed: 120 }], slots: [] } };
    const uses = pickaxeUsesCheck(worn, [{ name: 'stone' } as any], 50);
    expect(uses.enough).toBe(false);
    expect(uses.note).toContain('足りません');
  });
});
