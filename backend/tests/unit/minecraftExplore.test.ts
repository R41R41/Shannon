import { describe, expect, it } from 'vitest';
import { exploreHeading, exploreLegs } from '../../src/services/minebot/utils/explore.js';
import { placesFile } from '../../src/services/minebot/integration/commonFca/createCommonFcaBody.js';

describe('exploring for a structure', () => {
  it('takes the named heading, or the one the body faces, with its sides', () => {
    expect(exploreHeading('EAST', 0)).toMatchObject({ name: 'east', dx: 1, dz: 0 });
    expect(exploreHeading(undefined, 0)?.name).toBe('north');
    expect(exploreHeading(undefined, Math.PI / 2)?.name).toBe('west');
    expect(exploreHeading(undefined, -Math.PI / 2 + 0.3)?.name).toBe('east');
    expect(exploreHeading(undefined, Math.PI - 0.2)?.name).toBe('south');
    expect(exploreHeading('up', 0)).toBeNull();
    const east = exploreHeading('east', 0)!;
    expect([east.left.name, east.right.name]).toEqual(['north', 'south']);
  });
  it('goes in legs of 48 blocks', () => {
    expect(exploreLegs(exploreHeading('north', 0)!, 120)).toEqual([48, 48, 24]);
  });
  it('keeps places per server and world (the spawn point stands for the world)', () => {
    expect(placesFile('shannon-home', { x: 12.7, y: 64, z: -3.2 })).toBe('shannon-home-spawn_12_64_-4.json');
    expect(placesFile('../etc', { x: 0, y: 0, z: 0 })).toBe('___etc-spawn_0_0_0.json');
  });
});
