import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { describe, expect, it, vi } from 'vitest';
import { bodySkillCatalog, type BodySkill } from '../../src/services/minebot/integration/commonFca/skillCatalog.js';
// Constructors and parameter metadata only. No Skill.run, bot login, world, database or paid call.
const modules = import.meta.glob('../../src/services/minebot/instantSkills/*.ts');
describe('actual installed instant-skill catalog', () => {
  it('constructs every native skill and encodes the entire eligible catalog', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('OFFLINE_TEST_NETWORK_FORBIDDEN'); });
    try {
      const skills: BodySkill[] = [];
      const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', registry: minecraftData('1.21.11'),
        entity: { position: new Vec3(0, 65, 0) }, entities: {}, inventory: { items: () => [], slots: [] },
        instantSkills: { getSkills: () => skills, getSkill: (name: string) => skills.find(s => s.skillName === name) },
        constantSkills: { getSkills: () => [], getSkill: () => undefined }, selfState: {}, environmentState: {} });
      for (const [name, load] of Object.entries(modules)) {
        const module = await load() as { default?: new (bot: any) => BodySkill };
        if (typeof module.default !== 'function') throw Error(`Missing skill constructor: ${name}`);
        skills.push(new module.default(bot));
      }
      const catalog = bodySkillCatalog(skills, bot);
      expect(skills.length).toBeGreaterThan(70);
      expect(catalog.definitions.length).toBeGreaterThan(50);
      expect(catalog.definitions.some(skill => skill.name === 'move-to')).toBe(true);
      expect(catalog.definitions.some(skill => skill.name === 'mine-block')).toBe(true);
      expect(catalog.definitions.some(skill => skill.name === 'switch-constant-skill' || skill.name === 'chat')).toBe(false);
      expect(catalog.definitions.every(skill => skill.inputSchema.type === 'object')).toBe(true);
      if (process.env.FCA_API_WIRE_ROOT) {
        const validation = await import(`${process.env.FCA_API_WIRE_ROOT}/src/surfaces/minecraft/minecraftControlValidation.ts`);
        expect(validation.validSkills(catalog.definitions)).toBe(true);
      }
      console.info(`COMMON_FCA_CATALOG native=${skills.length} admitted=${catalog.definitions.length}`);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});
