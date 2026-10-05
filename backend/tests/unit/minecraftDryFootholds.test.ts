import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

vi.mock('../../src/config/env.js', () => ({ config: {} }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { SKILL_TIMEOUT_MS: 120_000 } }));

import FindDryFootholds, { scanDryFootholds } from '../../src/services/minebot/instantSkills/findDryFootholds.js';
import { skillCategory } from '../../src/services/minebot/execution/SkillExecutor.js';

function block(name: string) { return { name, boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block' }; }

function waterGully() {
  const entity = { position: new Vec3(-0.55, 53.82, 59.39) };
  const blockAt = vi.fn((position: Vec3) => {
    const { x, y, z } = position;
    if (x === -1 && z === 59) return block(y <= 48 ? 'stone' : y <= 55 ? 'water' : y <= 62 ? 'air' : y <= 65 ? 'sandstone' : 'air');
    if (x === -1 && z === 58) return block(y <= 49 ? 'stone' : y <= 51 ? 'sand' : y <= 55 ? 'water' : 'air');
    if (x === -1 && z === 57) return block(y <= 52 ? 'sandstone' : y <= 55 ? 'sand' : 'air');
    return null;
  });
  return { entity, blockAt, interruptExecution: false };
}

describe('find-dry-footholds read-only geometry', () => {
  it('finds the nearby dry bank rather than the higher rooftop above the water column', () => {
    const bot = waterGully();
    const result = scanDryFootholds(bot as any, { radius: 3, maxVertical: 14 });
    expect(result.candidates[0]).toMatchObject({ x: -0.5, y: 56, z: 57.5, groundBlock: 'sand' });
    expect(result.candidates[0].horizontalDistance).toBeLessThan(2);
    expect(result.candidates.some(site => site.x === -0.5 && site.z === 59.5 && site.y === 56)).toBe(false);
    expect(result.unloadedColumns).toBeGreaterThan(0);
  });

  it('sees a shore forty blocks across open water, and does not pay for the far ring when footing is near', () => {
    // Open water everywhere; a shore of sand from x=40 on (paid run L21: no land within the old 16-block limit).
    const sea = (shoreAt: number) => {
      const blockAt = vi.fn((position: Vec3) => position.x >= shoreAt
        ? block(position.y <= 62 ? 'sand' : 'air') : block(position.y <= 50 ? 'stone' : position.y <= 62 ? 'water' : 'air'));
      return { entity: { position: new Vec3(0.5, 62, 0.5) }, blockAt };
    };
    const far = sea(40);
    expect(scanDryFootholds(far as any, { radius: 16, maxVertical: 4 }).candidates).toHaveLength(0);
    const wide = scanDryFootholds(far as any, { radius: 64, maxVertical: 4, maxCandidates: 4 });
    expect(wide.candidates[0]).toMatchObject({ y: 63, groundBlock: 'sand' });
    expect(wide.candidates[0].x).toBeGreaterThanOrEqual(40);
    expect(wide.candidates[0].horizontalDistance).toBeLessThan(42);
    const near = sea(5);
    const calls = () => near.blockAt.mock.calls.length;
    scanDryFootholds(near as any, { radius: 16, maxVertical: 4, maxCandidates: 4 });
    const nearOnly = calls();
    near.blockAt.mockClear();
    scanDryFootholds(near as any, { radius: 64, maxVertical: 4, maxCandidates: 4 });
    expect(calls()).toBe(nearOnly);
  });

  it('requires dry two-block headroom and excludes hazardous support', () => {
    const bot = { entity: { position: new Vec3(0.5, 60, 0.5) }, blockAt: (position: Vec3) => {
      if (position.x === 0 && position.z === 0) return block(position.y <= 59 ? 'magma_block' : 'air');
      if (position.x === 1 && position.z === 0) return block(position.y <= 59 ? 'stone' : position.y === 61 ? 'water' : 'air');
      if (position.x === -1 && position.z === 0) return block(position.y <= 59 ? 'stone' : 'air');
      return null;
    } };
    const result = scanDryFootholds(bot as any, { radius: 1, maxVertical: 1 });
    expect(result.candidates).toEqual([expect.objectContaining({ x: -0.5, y: 60, z: 0.5 })]);
  });

  it('does not treat unloaded chunks as open air or claim path reachability', async () => {
    const bot = waterGully();
    const skill = new FindDryFootholds(bot as any);
    const result = await skill.runImpl(3, 14, 4);
    expect(skillCategory('find-dry-footholds')).toBe('query');
    expect(result.success).toBe(true);
    expect(result.result).toContain('(-0.5, 56, 57.5)');
    expect(result.result).toContain('経路到達性');
    expect(result.result).toContain('未ロード区間');
    expect(bot.blockAt).toHaveBeenCalled();
    expect(await skill.runImpl(Number.NaN)).toMatchObject({ success: false, failureType: 'invalid_input' });
  });
});
