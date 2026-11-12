import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { allSolidsBetween, firstSolidBetween, liquidAimPoints } from '../../src/services/minebot/utils/liquidAim.js';

// Run 9 (2026-11-12): eleven bucket refusals in a tunnel, each at a source one block aside on both horizontal axes. The line from the middle of the eye's cell to the
// middle of that source runs exactly along the shared edge of the two cells beside it.
const world = (solid: string[]) => ({ entity: { position: new Vec3(193.5, 35, -197.5) }, blockAt: (at: Vec3) => ({ name: 'x', boundingBox: solid.includes(`${at.x},${at.y},${at.z}`) ? 'block' : 'empty' }) });
const eye = new Vec3(193.5, 36.62, -197.5), water = new Vec3(194, 36, -197);

describe('a bucket aimed past the corner of two blocks', () => {
  it('counts both cells beside a line that crosses two borders at once', () => {
    const bot = world(['194,36,-198', '193,36,-197']);
    expect(firstSolidBetween(bot, eye, water.offset(0.5, 0.5, 0.5), water)).not.toBeNull();
    expect(allSolidsBetween(bot, eye, water.offset(0.5, 0.5, 0.5), water)).toHaveLength(2);
    expect(liquidAimPoints(bot, water).points).toHaveLength(0);
  });
  it('is blocked by one solid side too (the server may enter either), and still has points through the open side', () => {
    const bot = world(['193,36,-197']);
    expect(firstSolidBetween(bot, eye, water.offset(0.5, 0.5, 0.5), water)).not.toBeNull();
    expect(liquidAimPoints(bot, water).points.length).toBeGreaterThan(0);
  });
  it('is clear when both sides are open', () => {
    const bot = world([]);
    expect(firstSolidBetween(bot, eye, water.offset(0.5, 0.5, 0.5), water)).toBeNull();
  });
});
