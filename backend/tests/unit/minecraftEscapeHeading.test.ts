import { describe, expect, it } from 'vitest';
import { escapeHeading, escapeMayWork } from '../../src/services/minebot/utils/escapeHeading.js';

const origin = { x: 0, z: 0 };
const angle = (heading: { x: number; z: number }) => Math.round(Math.atan2(heading.z, heading.x) * 180 / Math.PI);

describe('running from several pursuers at once (paid run L65 ran three blocks one way and three back among three mobs)', () => {
  it('runs straight away from a single pursuer', () => {
    expect(angle(escapeHeading(origin, [{ x: 6, z: 0 }]))).toBe(180);
    expect(angle(escapeHeading(origin, [{ x: 0, z: -5 }]))).toBe(90);
  });

  it('takes the gap between pursuers on two sides, where pushes away from each cancel', () => {
    const heading = escapeHeading(origin, [{ x: 6, z: 0 }, { x: -6, z: 0 }]);
    expect(Math.abs(heading.x)).toBeLessThan(0.01);
    expect(Math.abs(heading.z)).toBeCloseTo(1);
    // Three round it, the widest gap to the south-west.
    const gap = angle(escapeHeading(origin, [{ x: 6, z: 0 }, { x: 0, z: -6 }, { x: -4, z: -4 }, { x: 5, z: 5 }]));
    expect(gap).toBeGreaterThanOrEqual(120);
    expect(gap).toBeLessThanOrEqual(165);
  });

  it('keeps the heading it is running while that still holds good, and turns when it no longer does', () => {
    const north = { x: 0, z: -1 };
    // The mobs shuffle a little: no turn.
    expect(escapeHeading(origin, [{ x: 6, z: 0.5 }, { x: -6, z: -0.5 }], north)).toBe(north);
    const chosen = escapeHeading(origin, [{ x: 6, z: 0 }]);
    expect(escapeHeading(origin, [{ x: 6, z: 0.3 }], chosen)).toBe(chosen); // what it returns, it keeps as the same object
    expect(escapeHeading(origin, [{ x: 6, z: -1 }, { x: -6, z: 1 }], north)).toEqual(north);
    // One comes round in front: turn.
    const turned = escapeHeading(origin, [{ x: 6, z: 0 }, { x: -6, z: 0 }, { x: 0, z: -4 }], north);
    expect(turned.z).toBeGreaterThan(0.5);
    // No pursuers: nothing to decide, the heading stands.
    expect(escapeHeading(origin, [], north)).toEqual(north);
  });

  it('leaves a heading that took the body nowhere, and those beside it', () => {
    // One pursuer to the east: west is best, but west is a cliff.
    const west = { x: -1, z: 0 };
    const turned = escapeHeading(origin, [{ x: 6, z: 0 }], west, 12, [west]);
    expect(turned.x * west.x + turned.z * west.z).toBeLessThan(0.77);
    expect(turned.x).toBeLessThan(0); // still away from the pursuer
    // Everything tried: any heading is better than none.
    const everyWay = Array.from({ length: 8 }, (_, i) => ({ x: Math.cos(i * Math.PI / 4), z: Math.sin(i * Math.PI / 4) }));
    expect(angle(escapeHeading(origin, [{ x: 6, z: 0 }], null, 12, everyWay))).toBe(180);
  });

  it('lets an escape stop to work only with nothing near', () => {
    expect(escapeMayWork(4)).toBe(false);
    expect(escapeMayWork(9.9)).toBe(false);
    expect(escapeMayWork(14)).toBe(true);
  });
});
