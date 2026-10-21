import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodySkillCatalog, LLM_CENTRIC_ONLY, LLM_CENTRIC_TOOLS, OFFERED_ELSEWHERE, type BodySkill } from '../../src/services/minebot/integration/commonFca/skillCatalog.js';
import { floorEatChoice } from '../../src/services/minebot/utils/floorReflexes.js';
import { captureWorldObservation } from '../../src/services/minebot/cognition/worldFrame.js';
import { descentFloor } from '../../src/services/minebot/utils/nightGate.js';
import { makeRoom, tidyIfCluttered, tidyPackNow } from '../../src/services/minebot/utils/inventoryRoom.js';
import { ensureToolUses, keepCheapTool } from '../../src/services/minebot/utils/toolStock.js';
import { shouldRefuseAggressiveCombat } from '../../src/services/minebot/utils/minebotToolPolicy.js';
import { isLlmCentric, llmCentricFromEnv } from '../../src/services/minebot/utils/llmCentric.js';

// The switch MINEBOT_LLM_CENTRIC (design mb-llm-centric 2.4): off (the default), the body is the one it was; on, the planner is offered
// act and view and the body's own choices are not made. Both sides of each place the switch touches.
afterEach(() => { delete process.env.MINEBOT_LLM_CENTRIC; });
const modules = import.meta.glob('../../src/services/minebot/instantSkills/*.ts');

describe('the switch', () => {
  it('is off unless on', () => {
    expect(llmCentricFromEnv({})).toBe(false);
    expect(llmCentricFromEnv({ MINEBOT_LLM_CENTRIC: 'on' })).toBe(true);
    expect(llmCentricFromEnv({ MINEBOT_LLM_CENTRIC: 'yes please' })).toBe(false);
    expect(isLlmCentric({ llmCentric: true })).toBe(true);
    process.env.MINEBOT_LLM_CENTRIC = 'on';
    expect(isLlmCentric({})).toBe(true);
    expect(isLlmCentric({ llmCentric: false })).toBe(false);
  });

  it('off offers the catalog it always did (act and view never); on offers act, view and the readers, act\'s schema crossing the wire', async () => {
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
      const off = bodySkillCatalog(skills, bot);
      const expected = off.runnable.map(skill => skill.name).filter(name => !OFFERED_ELSEWHERE.has(name) && !LLM_CENTRIC_ONLY.has(name));
      expect(off.definitions.map(skill => skill.name)).toEqual(expected);
      expect(off.definitions.some(skill => skill.name === 'act' || skill.name === 'view')).toBe(false);
      expect(off.definitions.some(skill => skill.name === 'move-to')).toBe(true);
      const on = bodySkillCatalog(skills, bot, { llmCentric: true });
      expect(on.definitions.map(skill => skill.name)).toEqual(LLM_CENTRIC_TOOLS.filter(name => off.runnable.some(skill => skill.name === name)));
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
      // r4: probe, read only, offered in the mode only, right after view; the head's inputs reach it.
      expect(off.definitions.some(skill => skill.name === 'probe')).toBe(false);
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

  it('the floor eats a top-up off, and only starving or nearly dead on', () => {
    const fed = (food: number, health: number, llmCentric?: boolean): any => ({ food, health, llmCentric, entity: { position: new Vec3(0, 64, 0) }, entities: {},
      inventory: { items: () => [{ name: 'bread', count: 3 }] }, setControlState: () => undefined, on: () => undefined });
    expect(floorEatChoice(fed(12, 20))?.name).toBe('bread');
    expect(floorEatChoice(fed(12, 20, true))).toBeNull();
    expect(floorEatChoice(fed(3, 20, true))?.name).toBe('bread');
    expect(floorEatChoice(fed(10, 6, true))?.name).toBe('bread');
  });

  it('the observation adds the map, the marks and food points only on', () => {
    const world = (llmCentric: boolean): any => Object.assign(new EventEmitter(), { llmCentric, entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 }, health: 20, food: 18,
      entities: { 3: { id: 3, name: 'enderman', type: 'mob', position: new Vec3(4, 64, 0), metadata: [] } },
      inventory: { items: () => [{ name: 'bread', count: 2 }] }, game: { dimension: 'overworld' },
      blockAt: (p: Vec3) => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }) });
    const off = captureWorldObservation(world(false));
    expect(off.localMap).toBeUndefined();
    expect(off.foodPoints).toBeUndefined();
    expect('id' in off.nearbyEntities[0]).toBe(false);
    const on = captureWorldObservation(world(true));
    expect(on.localMap).toContain('地図 v1 足=(0,64,0)');
    expect(on.localMap).toContain('方式=surface');
    expect(on.foodPoints?.carried).toBe(22);
    expect(on.nearbyEntities[0]).toMatchObject({ id: 3, angry: false });
  });

  it('the body\'s own choices are not made on: tidy, spare tools, the night gate, the refused fight', async () => {
    const call = vi.fn(async () => ({ success: true }));
    const full: any = { llmCentric: true, inventory: { items: () => new Array(36).fill({ name: 'dirt', count: 64 }), slots: [] } };
    expect(await makeRoom(full, call as any, { slots: 4 })).toEqual({ note: '', freed: 0, refused: [] });
    expect(await tidyPackNow(full, call as any, {})).toBe('');
    expect(await tidyIfCluttered(full, call as any, {})).toBe('');
    expect(await keepCheapTool(full, [{ name: 'stone' } as any], call as any)).toBeNull();
    const uses = await ensureToolUses(full, [{ name: 'stone' } as any], 50, call as any);
    expect(uses.enough).toBe(false);
    expect(call).not.toHaveBeenCalled();
    const night: any = { llmCentric: true, time: { timeOfDay: 18000, day: 1 }, game: { dimension: 'overworld' }, entity: { position: new Vec3(0, 10, 0) },
      inventory: { items: () => [], slots: [] } };
    expect(descentFloor(night)).toBeNull();
    expect(descentFloor({ ...night, llmCentric: false })).not.toBeNull();
    expect(shouldRefuseAggressiveCombat({ llmCentric: true, minebotControlState: 'emergency' } as any, 'cow')).toBeNull();
  });
});
