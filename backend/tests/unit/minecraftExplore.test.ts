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
  it('keeps places per named server and world', () => {
    expect(placesFile('shannon-home', 'home-2026-10-14b')).toBe('shannon-home--home-2026-10-14b.json');
    expect(placesFile('../etc', 'a/b')).toBe('___etc--a_b.json');
  });
});
