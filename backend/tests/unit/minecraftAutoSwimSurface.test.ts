import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { nearestOpenSurface } from '../../src/services/minebot/constantSkills/autoSwim.js';

// Paid run L5: water up to y=62 with one solid block at the waterline straight
// above the bot (x=96); open air one block to either side.
function world(ceilingAt: Set<string>) {
  return {
    blockAt(p: Vec3) {
      const key = `${p.x},${p.y},${p.z}`;
      if (ceilingAt.has(key)) return { name: 'cobblestone', boundingBox: 'block' };
      if (p.y <= 54) return { name: 'stone', boundingBox: 'block' };
      if (p.y <= 62) return { name: 'water', boundingBox: 'empty' };
      return { name: 'air', boundingBox: 'empty' };
    },
  };
}

describe('auto-swim finds open water when a block caps the column above the head', () => {
  it('points to the nearest column whose water reaches air', () => {
    const head = new Vec3(96, 61, 10);
    const capped = world(new Set(['96,62,10']));
    const surface = nearestOpenSurface(capped, head)!;
    expect(surface.y).toBe(63);
    expect(Math.hypot(surface.x - 96, surface.z - 10)).toBe(1);
    // Straight up is open: no detour needed.
    expect(nearestOpenSurface(world(new Set()), head)).toEqual(new Vec3(96, 63, 10));
  });

  it('returns nothing under a wide roof', () => {
    const roof = new Set<string>();
    for (let x = 90; x <= 102; x++) for (let z = 4; z <= 16; z++) roof.add(`${x},62,${z}`);
    expect(nearestOpenSurface(world(roof), new Vec3(96, 61, 10))).toBeNull();
  });
});
