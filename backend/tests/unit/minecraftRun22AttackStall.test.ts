import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

// Run 22: "chicken に攻撃できませんでした" after 62 s with not a line in the journal. A target that does not come to the body and is not got
// nearer is given up after ten seconds, and the result says what stood in the way.
const gotoSafeMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: gotoSafeMock }));
vi.mock('../../src/services/minebot/execution/observedWait.js', () => ({ actionDelay: vi.fn(async () => {}) }));

const { default: AttackContinuously } = await import('../../src/services/minebot/instantSkills/attackContinuously.js');

const solid = (name: string) => ({ name, boundingBox: 'block' });
function body(targets: any[], blockAt: (p: Vec3) => unknown, attack = vi.fn(async () => {})) {
  return {
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, health: 20, minebotControlState: 'idle',
    entities: Object.fromEntries(targets.map(target => [target.id, target])),
    inventory: { items: () => [{ name: 'stone_sword', count: 1 }], slots: [] }, heldItem: { name: 'stone_sword' },
    equip: async () => {}, setControlState: () => {}, pathfinder: { stop: () => {} }, blockAt,
    nearestEntity: (match: (entity: any) => boolean) => targets.filter(target => target.isValid && match(target))[0] ?? null,
    lookAt: async () => {}, attack,
  } as any;
}
const ground = (p: Vec3) => (Math.floor(p.y) < 64 ? solid('stone') : { name: 'air', boundingBox: 'empty' });

describe('attack-continuously gives up a target it cannot get nearer, early, with the cause', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); gotoSafeMock.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  const run = async (bot: any, entityName = 'food_animals') => {
    const skill: any = new AttackContinuously(bot);
    skill.shouldInterrupt = () => false;
    skill.collectNearbyDrops = async () => [];
    // Each walk of the chase takes six seconds and gets the body nowhere.
    gotoSafeMock.mockImplementation(async () => { vi.advanceTimersByTime(6000); return { success: false, error: 'timeout' }; });
    const started = Date.now();
    const result = await skill.runImpl(entityName, 30, 48, 0);
    return { result, seconds: (Date.now() - started) / 1000 };
  };

  it('a chicken on a ledge 5 m up is let go after about ten seconds, and the answer names the height', async () => {
    const chicken: any = { id: 2, name: 'chicken', position: new Vec3(6.5, 69, 0.5), height: 0.7, isValid: true };
    const attack = vi.fn(async () => {});
    const { result, seconds } = await run(body([chicken], ground, attack));
    expect(attack).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, failureType: 'target_unreachable', recoverable: true });
    expect(result.result).toContain('chickenに攻撃できませんでした');
    expect(result.result).toContain('上');
    expect(seconds).toBeLessThan(25);
    expect(gotoSafeMock.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('a chicken 48 m off that the walks do not close in on is given up with the figures; a second one ends the call', async () => {
    const far = (id: number, x: number): any => ({ id, name: 'chicken', position: new Vec3(x, 64, 0.5), height: 0.7, isValid: true });
    const { result, seconds } = await run(body([far(2, 48), far(3, 40)], ground));
    expect(result).toMatchObject({ success: false, failureType: 'target_unreachable' });
    expect(result.result).toContain('秒歩いても');
    expect(result.result).toContain('水平');
    expect(seconds).toBeLessThan(40);
  });

  it('a fence between is named', async () => {
    const chicken: any = { id: 2, name: 'chicken', position: new Vec3(6.5, 64, 0.5), height: 0.7, isValid: true };
    const fenced = (p: Vec3) => (Math.floor(p.x) === 3 && Math.floor(p.y) === 64 ? solid('oak_fence') : ground(p));
    const { result } = await run(body([chicken], fenced));
    expect(result.failureType).toBe('target_unreachable');
    expect(result.result).toContain('oak_fence');
  });

  it('a hostile that is simply out of reach is not given up (it comes to the body): the call keeps its minute', async () => {
    const zombie: any = { id: 2, name: 'zombie', position: new Vec3(30.5, 64, 0.5), height: 1.95, isValid: true };
    const bot = body([zombie], ground);
    const skill: any = new AttackContinuously(bot);
    skill.shouldInterrupt = () => false;
    skill.collectNearbyDrops = async () => [];
    let calls = 0;
    gotoSafeMock.mockImplementation(async () => { calls++; vi.advanceTimersByTime(6000); return { success: false, error: 'timeout' }; });
    const result = await skill.runImpl('zombie', 5, 48, 0);
    expect(calls).toBeGreaterThanOrEqual(8);
    expect(result.failureType).not.toBe('target_unreachable');
  });

  it('a target that is reached and struck is not given up, and the unreached one is added to the result', async () => {
    const near: any = { id: 2, name: 'cow', position: new Vec3(2.5, 64, 0.5), height: 1.4, isValid: true };
    let blows = 0;
    const attack = vi.fn(async () => { blows++; if (blows >= 2) near.isValid = false; });
    const stuckHen: any = { id: 3, name: 'chicken', position: new Vec3(0.5, 72, 20.5), height: 0.7, isValid: true };
    const bot = body([near, stuckHen], ground, attack);
    const skill: any = new AttackContinuously(bot);
    skill.shouldInterrupt = () => false;
    skill.collectNearbyDrops = async () => [];
    gotoSafeMock.mockImplementation(async () => { vi.advanceTimersByTime(6000); return { success: false, error: 'timeout' }; });
    // the cow dies on the second blow; the hen is found next and given up
    const result = await skill.runImpl('food_animals', 30, 48, 0);
    expect(blows).toBe(2);
    expect(result.success).toBe(true);
    expect(result.result).toContain('届かなかった相手: chicken');
  });
});
