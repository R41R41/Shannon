import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

// S2 (2026-11-02, the c1 hideout): at eight hearts the body rested in a corridor no blaze of the spawner can see, a blaze twelve metres off "could reach" it, the low-health flee found no way, and the
// last stand dug the floor out from under it seven times. A blaze or a ghast (shooters that fire only at what they see) out of whose sight the body is, farther than 6 m, is no threat the floor runs from.
const exposures: Record<number, 'seen' | 'reachable' | 'sealed'> = {};
vi.mock('../../src/services/minebot/utils/threatExposure.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/threatExposure.js')>();
  return { ...actual, threatExposure: vi.fn((_bot: unknown, entity: { id: number }) => exposures[entity.id] ?? 'seen') };
});
const { fleeThreat, reachingThreats } = await import('../../src/services/minebot/utils/floorReflexes.js');

const mob = (id: number, name: string, at: Vec3) => ({ id, name, type: 'hostile', position: at, height: 1.8, width: 0.6 });
const body = (mobs: Record<string, any>, health = 6): any => ({
  health, food: 20, game: { dimension: 'the_nether' }, entity: { id: 1, name: 'player', position: new Vec3(0.5, 64, 0.5), onGround: true }, entities: mobs,
  registry: { entitiesByName: { blaze: { type: 'hostile' }, zombie: { type: 'hostile' }, skeleton: { type: 'hostile' }, ghast: { type: 'hostile' } } }, inventory: { items: () => [] },
  blockAt: () => ({ name: 'stone', boundingBox: 'block' }),
});

describe('a blaze or a ghast that cannot see the body is no threat the floor runs from (beyond 6 m)', () => {
  it('seen: the flee has its threat; reachable but not seen at 12 m: none; the same near (4 m): still one', () => {
    exposures[1] = 'seen'; exposures[2] = 'reachable'; exposures[3] = 'reachable'; exposures[4] = 'sealed';
    expect(fleeThreat(body({ 1: mob(1, 'blaze', new Vec3(12.5, 66, 0.5)) }))?.nearest).toBeGreaterThan(11);
    expect(fleeThreat(body({ 2: mob(2, 'blaze', new Vec3(12.5, 66, 0.5)) }))).toBeNull();
    expect(fleeThreat(body({ 3: mob(3, 'blaze', new Vec3(4.5, 66, 0.5)) }))?.nearest).toBeLessThan(6);
    expect(fleeThreat(body({ 4: mob(4, 'blaze', new Vec3(4.5, 66, 0.5)) }))).toBeNull();
  });

  it('a ghast likewise; a skeleton or a zombie that can reach the body is a threat whether it sees it or not (they walk after it)', () => {
    exposures[5] = 'reachable'; exposures[6] = 'reachable'; exposures[7] = 'reachable';
    expect(fleeThreat(body({ 5: mob(5, 'ghast', new Vec3(15.5, 70, 0.5)) }))).toBeNull();
    expect(fleeThreat(body({ 6: mob(6, 'skeleton', new Vec3(12.5, 64, 0.5)) }))?.nearest).toBeGreaterThan(11);
    expect(fleeThreat(body({ 7: mob(7, 'zombie', new Vec3(8.5, 64, 0.5)) }))?.nearest).toBeGreaterThan(7);
  });

  it('the last stand reads the same: an unseen blaze at 12 m reaches nothing, a seen one does', () => {
    exposures[8] = 'reachable'; exposures[9] = 'seen';
    expect(reachingThreats(body({ 8: mob(8, 'blaze', new Vec3(12.5, 66, 0.5)) }))).toEqual([]);
    expect(reachingThreats(body({ 9: mob(9, 'blaze', new Vec3(12.5, 66, 0.5)) })).map(entry => entry.exposure)).toEqual(['seen']);
  });
});

// S2 (2026-11-02, the c1 fortress): the floor's own digs down are capped (the cover's and the last stand's together): a shaft six deep under a bridge in ten seconds ended in a fall.
describe('the floor\'s digs down are at most three in thirty seconds', () => {
  it('counts the ones in the window, forgets the older ones', async () => {
    const { recentEscapeDigs } = await import('../../src/services/minebot/utils/floorReflexes.js');
    const state: { escapeDigs?: number[] } = {};
    expect(recentEscapeDigs(state, 1_000)).toBe(0);
    state.escapeDigs = [1_000, 4_000, 9_000];
    expect(recentEscapeDigs(state, 10_000)).toBe(3);
    expect(recentEscapeDigs(state, 33_000)).toBe(2);        // the first is older than 30 s
    expect(state.escapeDigs).toEqual([4_000, 9_000]);
    expect(recentEscapeDigs(state, 60_000)).toBe(0);
  });
});
