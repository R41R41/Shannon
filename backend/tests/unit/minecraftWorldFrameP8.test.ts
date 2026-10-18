import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { captureWorldObservation } from '../../src/services/minebot/cognition/worldFrame.js';
import { ReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';

const body = (patch: Record<string, unknown> = {}): any => ({ entity: { position: new Vec3(10.5, 64, -3.2) }, health: 20, food: 20, game: { dimension: 'minecraft:overworld' },
  registry: { biomes: { 1: { name: 'plains' }, 4: { name: 'forest' } } }, ...patch });

describe('biome from the world (B-1)', () => {
  it('reads the name through the registry and caches it per 2-block cell', () => {
    const getBiome = vi.fn(() => 4);
    const bot = body({ world: { getBiome } });
    expect(captureWorldObservation(bot).biome).toBe('forest');
    captureWorldObservation(bot); captureWorldObservation(bot);
    expect(getBiome).toHaveBeenCalledTimes(1);
    // Within the same 2-block cell: no new lookup. Over the line: a new one.
    bot.entity.position = new Vec3(11.4, 64.9, -3.9); captureWorldObservation(bot); expect(getBiome).toHaveBeenCalledTimes(1);
    getBiome.mockReturnValue(1); bot.entity.position = new Vec3(12.2, 64, -3.2);
    expect(captureWorldObservation(bot).biome).toBe('plains'); expect(getBiome).toHaveBeenCalledTimes(2);
  });
  it('says null (never an empty string) for an unloaded cell, and tries again next time', () => {
    const getBiome = vi.fn(() => undefined);
    const bot = body({ world: { getBiome }, environmentState: { biome: '' } });
    expect(captureWorldObservation(bot).biome).toBeNull();
    expect(captureWorldObservation(bot).biome).toBeNull();
    expect(getBiome).toHaveBeenCalledTimes(2);
    getBiome.mockReturnValue(4); expect(captureWorldObservation(bot).biome).toBe('forest');
  });
  it('falls back to what auto-update-state kept when the world cannot answer or throws', () => {
    expect(captureWorldObservation(body({ environmentState: { biome: 'desert' } })).biome).toBe('desert');
    const throwing = body({ world: { getBiome: () => { throw Error('no chunk'); } }, environmentState: { biome: 'taiga' } });
    expect(captureWorldObservation(throwing).biome).toBe('taiga');
    expect(captureWorldObservation(body()).biome).toBeNull();
    expect(captureWorldObservation(body({ world: { getBiome: () => 99 } })).biome).toBeNull();
  });
});

describe('jobs: furnaces still working (B-6)', () => {
  /** A body of common-FCA mode: the reflex ledger is what marks it, and `jobs` are said only there. */
  const common = (patch: Record<string, unknown> = {}) => { const bot = body(patch); bot.reflexLedger = new ReflexLedger(bot); return bot; };
  it('is said only in common-FCA mode: the legacy observation is the one it had (it has get-background-jobs)', () => {
    expect(captureWorldObservation(body({ activeFurnaces: [{ pos: new Vec3(1, 64, 1), item: 'raw_iron', count: 8, startedAt: 1000, readyAt: Date.now() + 80_000 }] }))).not.toHaveProperty('jobs');
  });
  const furnace = (n: number, patch: Record<string, unknown> = {}) => ({ pos: new Vec3(n, 64, n), item: 'raw_iron', count: 8, startedAt: 1000, readyAt: Date.now() + 80_000, ...patch });
  it('says nothing without a furnace, and the planner\'s wording is not repeated', () => {
    expect(captureWorldObservation(body())).not.toHaveProperty('jobs');
    expect(captureWorldObservation(common({ activeFurnaces: [] }))).not.toHaveProperty('jobs');
    const jobs = captureWorldObservation(common({ activeFurnaces: [furnace(1)] })).jobs!;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'waiting_external', input: 'raw_iron', count: 8, position: { x: 1, y: 64, z: 1 }, completionVerified: false });
    expect(jobs[0].remainingEstimateMs).toBeGreaterThan(70_000);
    expect(JSON.stringify(jobs)).not.toContain('instruction');
  });
  it('marks a furnace whose time is up as due for verification, one in another dimension as such, and an unfuelled one', () => {
    const jobs = captureWorldObservation(common({ activeFurnaces: [furnace(1, { readyAt: Date.now() - 1 }), furnace(2, { dimension: 'minecraft:the_nether' }), furnace(3, { unfueledCount: 4 })] })).jobs!;
    expect(jobs.map(job => job.status)).toEqual(['verification_due', 'different_dimension', 'waiting_external']);
    expect(jobs[0].remainingEstimateMs).toBe(0); expect(jobs[2].unfueledInputCount).toBe(4);
  });
  it('stays within 600 characters however many furnaces', () => {
    const two = captureWorldObservation(common({ activeFurnaces: [furnace(1), furnace(2, { unfueledCount: 4 })] })).jobs!;
    expect(two).toHaveLength(2); expect(JSON.stringify(two).length).toBeLessThanOrEqual(600);
    const many = captureWorldObservation(common({ activeFurnaces: Array.from({ length: 12 }, (_, i) => furnace(i + 100, { unfueledCount: 7 })) })).jobs!;
    expect(JSON.stringify(many).length).toBeLessThanOrEqual(600); expect(many.length).toBeGreaterThanOrEqual(2);
  });
  it('says how many furnaces it left out (P8 second review, L4), and nothing when none', () => {
    const none = captureWorldObservation(common({ activeFurnaces: [furnace(1), furnace(2)] }));
    expect(none).not.toHaveProperty('jobsOmitted');
    const frame = captureWorldObservation(common({ activeFurnaces: Array.from({ length: 12 }, (_, i) => furnace(i + 100, { unfueledCount: 7 })) }));
    expect(frame.jobs!.length + frame.jobsOmitted!).toBe(12); expect(frame.jobsOmitted).toBeGreaterThan(0);
  });
});

describe('reflexes in the observation (P8)', () => {
  it('leaves the key out when nothing happened, and shows what did within 500 characters', () => {
    const bot = body(); bot.reflexLedger = new ReflexLedger(bot);
    expect(captureWorldObservation(bot)).not.toHaveProperty('reflexes');
    bot.reflexLedger.note('eat', '食事（パン）'); bot.reflexLedger.note('shield', '盾を構えた');
    const reflexes = captureWorldObservation(bot).reflexes!;
    expect(reflexes.recent.map(item => item.kind)).toEqual(['shield', 'eat']);
    expect(reflexes.counts).toEqual({ eat: 1, shield: 1 });
    expect(JSON.stringify(reflexes).length).toBeLessThanOrEqual(500);
  });
  it('is not broken by a ledger that throws', () => {
    const bot = body({ reflexLedger: { summary: () => { throw Error('boom'); } } });
    expect(captureWorldObservation(bot)).not.toHaveProperty('reflexes');
  });
});
