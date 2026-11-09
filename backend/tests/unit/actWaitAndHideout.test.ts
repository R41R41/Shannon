import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

// end1108h20 S7 (11/8): `wait 15 s accept blaze` went 20 → 14.8 from fireballs with nothing said (accept silenced the hurt rule), then hpBelow cut
// an attack at 11.3 in two blazes' line; the head ate and struck back where she stood and burned to death 48 s later.
const seen = vi.hoisted(() => ({ seeing: true, spawner: true, hideout: true }));
vi.mock('../../src/services/minebot/utils/floorReflexes.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/floorReflexes.js')>();
  return { ...actual,
    shootersInReach: vi.fn((bot: any) => [bot.entities[9]]),
    shootersSeeing: vi.fn((_bot: any, inReach: any[]) => seen.seeing ? inReach : []),
    shooterWords: vi.fn(() => 'blaze #9 4.0m') };
});
vi.mock('../../src/services/minebot/utils/loadedBlockScan.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/loadedBlockScan.js')>();
  return { ...actual, scanLoadedBlocks: vi.fn(() => ({ hits: seen.spawner ? [{ name: 'spawner', position: new Vec3(6, 65, 0) }] : [] })) };
});
vi.mock('../../src/services/minebot/utils/huntCamp.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/huntCamp.js')>();
  return { ...actual, hideoutsFrom: vi.fn(() => seen.hideout ? [{ x: -3, y: 64, z: 2, steps: 5, away: 9.5 }] : []) };
});
const { ACT_HANDS, runAct } = await import('../../src/services/minebot/instantSkills/act.js');

function body() {
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true, height: 1.8 },
    health: 20, food: 20, game: { dimension: 'the_nether' },
    entities: { 9: { id: 9, name: 'blaze', type: 'hostile', position: new Vec3(4.5, 64, 0.5), height: 1.8 } },
    inventory: { items: () => [], slots: new Array(46).fill(null) },
    blockAt: (p: Vec3) => ({ name: Math.floor(p.y) < 64 ? 'netherrack' : 'air', boundingBox: Math.floor(p.y) < 64 ? 'block' : 'empty', diggable: true, hardness: 0.4, position: p.floored() }),
    setControlState: () => undefined, clearControlStates: () => undefined,
  });
  bot.entities[9].entity = bot.entities[9];
  return bot;
}
const hands = (value: unknown) => ACT_HANDS.parse(value);
const why = async (bot: any, list: unknown, stopIf?: any, accept?: string[]) => {
  const result = await runAct(bot, hands(list), stopIf, undefined, { tickMs: 20, accept });
  return { ...JSON.parse(result.result), failureType: result.failureType };
};

describe('a wait is not silenced by an accepted kind', () => {
  it('a wait accepting blazes stops on a loss of 4 from one 4 m off, and says the hideout', async () => {
    Object.assign(seen, { seeing: true, spawner: true, hideout: true });
    const bot = body();
    setTimeout(() => { bot.health = 14.8; }, 60);
    const out = await why(bot, [{ do: 'wait', seconds: 1 }], { hostileWithin: 6 }, ['blaze']);
    expect(out.failureType).toBe('damage_taken');
    expect(out.stoppedWhy).toBe('被弾: 体力 20 → 15。射線の中: blaze #9 4.0m から見えている。隠れ場所（湧き場のどのマスからも見えない）: (-3,64,2) 5歩');
  });
});

describe('the hideout said with a stop in the line', () => {
  it('hpBelow in the line names the nearest hideout', async () => {
    Object.assign(seen, { seeing: true, spawner: true, hideout: true });
    const bot = body();
    setTimeout(() => { bot.health = 11.3; }, 60);
    const out = await why(bot, [{ do: 'wait', seconds: 1 }], { hpBelow: 12 });
    expect(out.stoppedWhy).toBe('hpBelow:11.3。射線の中: blaze #9 4.0m から見えている。隠れ場所（湧き場のどのマスからも見えない）: (-3,64,2) 5歩');
  });
  it('says there is none within 40 steps when the search finds none', async () => {
    Object.assign(seen, { seeing: true, spawner: true, hideout: false });
    const bot = body();
    setTimeout(() => { bot.health = 11.3; }, 60);
    expect((await why(bot, [{ do: 'wait', seconds: 1 }], { hpBelow: 12 })).stoppedWhy).toContain('。湧き場から見えない隠れ場所は 40 歩内に無い');
  });
  it('says nothing more out of the line or with no spawner loaded', async () => {
    Object.assign(seen, { seeing: false, spawner: true, hideout: true });
    let bot = body();
    setTimeout(() => { bot.health = 11.3; }, 60);
    expect((await why(bot, [{ do: 'wait', seconds: 1 }], { hpBelow: 12 })).stoppedWhy).toBe('hpBelow:11.3。射線の外: blaze #9 4.0m からは見えない');
    Object.assign(seen, { seeing: true, spawner: false });
    bot = body();
    setTimeout(() => { bot.health = 11.3; }, 60);
    expect((await why(bot, [{ do: 'wait', seconds: 1 }], { hpBelow: 12 })).stoppedWhy).toBe('hpBelow:11.3。射線の中: blaze #9 4.0m から見えている');
  });
});
