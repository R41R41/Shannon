import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { installCollisionTolerance, uninstallCollisionTolerance } from '../../src/services/minebot/utils/collisionTolerance.js';

const AABB = createRequire(import.meta.url)('prismarine-physics/lib/aabb.js');
const HALF = 0.3;
const body = (x: number, y: number, z: number) => new AABB(-HALF, 0, -HALF, HALF, 1.8, HALF).offset(x, y, z);
const block = (x: number, y: number, z: number) => new AABB(0, 0, 0, 1, 1, 1).offset(x, y, z);

afterEach(() => uninstallCollisionTolerance());

describe('a body flush against a block is touching it, not inside it (corrections at x=-2.3, z=32.3, z=-512.3 in every world)', () => {
  // Faces on these planes are where centre ± 0.3 lands one bit past the face.
  const eastOf = [-512, -32, -2];   // body west of the face at B, block occupying [B, B+1], pressing +
  const westOf = [2, 32, 512];      // body east of the face at B, block occupying [B-1, B], pressing -

  it('the library alone lets the body walk into the wall on exactly these planes', () => {
    for (const B of eastOf) expect(block(B, 64, 0).computeOffsetX(body(B - HALF, 64, 0.5), 0.1)).toBe(0.1);
    for (const B of westOf) expect(block(B - 1, 64, 0).computeOffsetX(body(B + HALF, 64, 0.5), -0.1)).toBe(-0.1);
    // ...and stops it one block over, where the arithmetic happens to round the other way.
    expect(block(-3, 64, 0).computeOffsetX(body(-3 - HALF, 64, 0.5), 0.1)).toBeLessThanOrEqual(0);
  });

  it('with the tolerance the wall holds on every plane, in x and in z', () => {
    installCollisionTolerance();
    for (const B of [...eastOf, -3, -100, 7]) {
      expect(block(B, 64, 0).computeOffsetX(body(B - HALF, 64, 0.5), 0.1)).toBe(0);
      expect(block(0, 64, B).computeOffsetZ(body(0.5, 64, B - HALF), 0.1)).toBe(0);
    }
    for (const B of [...westOf, 3, 100, -7]) {
      expect(block(B - 1, 64, 0).computeOffsetX(body(B + HALF, 64, 0.5), -0.1)).toBe(0);
      expect(block(0, 64, B - 1).computeOffsetZ(body(0.5, 64, B + HALF), -0.1)).toBe(0);
    }
  });

  it('leaves ordinary movement as it was: free space, a real gap, standing and landing', () => {
    installCollisionTolerance();
    expect(block(5, 64, 0).computeOffsetX(body(3.5, 64, 0.5), 0.1)).toBe(0.1);                    // well clear
    expect(block(5, 64, 0).computeOffsetX(body(4.65, 64, 0.5), 0.1)).toBeCloseTo(0.05, 10);       // closes the gap, no further
    expect(block(5, 64, 3).computeOffsetX(body(4.7, 64, 0.5), 0.1)).toBe(0.1);                    // a block off to the side does not stop it
    expect(block(0, 63, 0).computeOffsetY(body(0.5, 64, 0.5), -0.0784)).toBe(0);                  // standing on a block
    expect(block(0, 62, 0).computeOffsetY(body(0.5, 64, 0.5), -0.5)).toBeCloseTo(-0.5, 10);       // falling with room below
    expect(block(0, 66, 0).computeOffsetY(body(0.5, 64, 0.5), 0.42)).toBeCloseTo(0.2, 10);        // a ceiling stops a jump
  });

  it('does not catch a body sliding along such a wall on the next block of it', () => {
    // The wall runs along x=2 (blocks at x in [1,2]); the body east of it, flush, moving north along it,
    // its north face level with the south face of the wall's next block.
    const sliding = body(2 + HALF, 64, 5 + HALF);
    expect(sliding.minZ).toBe(5);
    expect(block(1, 64, 4).computeOffsetZ(sliding, -0.2)).toBe(0); // the library: one bit of overlap sideways, and the next wall block stops the slide
    installCollisionTolerance();
    expect(block(1, 64, 4).computeOffsetZ(sliding, -0.2)).toBe(-0.2);
    // And a body that only touches a floor block's edge is not standing on it.
    expect(block(1, 63, 5).computeOffsetY(body(2 + HALF, 64, 5.5), -0.0784)).toBe(-0.0784);
  });
});

describe('no blind escape hop beside lava (L45 hopped off its footing into a lava lake)', () => {
  it('sees lava or fire within a hop of the body, and nothing in ordinary ground', async () => {
    const { lethalGroundNearby } = await import('../../src/services/minebot/utils/gotoSafe.js');
    const { Vec3 } = await import('vec3');
    const at = (lava: (x: number, y: number, z: number) => boolean): any => ({ entity: { position: new Vec3(0.5, 37, 0.5) },
      blockAt: (p: any) => ({ name: lava(p.x, p.y, p.z) ? 'lava' : p.y < 37 ? 'stone' : 'air' }) });
    expect(lethalGroundNearby(at(() => false))).toBe(false);
    expect(lethalGroundNearby(at((x, y, z) => x === 2 && y === 36 && z === 0))).toBe(true);   // a lake one step away, one block down
    expect(lethalGroundNearby(at((x, y, z) => x === 0 && y === 34 && z === 2))).toBe(true);   // three below
    expect(lethalGroundNearby(at((x, y, z) => x === 5 && y === 36 && z === 0))).toBe(false);  // out of a hop's reach
    expect(lethalGroundNearby({ entity: undefined, blockAt: () => null } as any)).toBe(false);
  });
});
