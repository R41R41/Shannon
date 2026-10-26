import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { conditionHolds, conditionMetText, conditionWords, readCondition, type ActCondition } from '../../src/services/minebot/utils/actConditions.js';
import { bodySkillCatalog } from '../../src/services/minebot/integration/commonFca/skillCatalog.js';
import Act from '../../src/services/minebot/instantSkills/act.js';

// The task queue's conditions (`tq/contract.md` section 1): the body reads JSON, checks it against itself, and says in words what an unmet clause lacks.
const AIR = { name: 'air', boundingBox: 'empty' };
function body(overrides: Record<string, unknown> = {}): any {
  const slots: any[] = new Array(46).fill(null);
  slots[5] = { name: 'iron_helmet', count: 1 };
  for (let i = 9; i < 14; i++) slots[i] = { name: 'x', count: 1 };
  return {
    entity: { position: new Vec3(10.5, 64, 10.5), yaw: 0 }, health: 18, food: 15, game: { dimension: 'the_nether' }, time: { timeOfDay: 14000 }, thunderState: 0,
    inventory: { items: () => [{ name: 'oak_log', count: 6 }, { name: 'birch_log', count: 4 }, { name: 'raw_iron', count: 1 }, { name: 'bread', count: 3 }], slots },
    entities: {}, registry: { entitiesByName: { zombie: { type: 'hostile' } } },
    blockAt: (p: Vec3) => (Math.floor(p.x) === 12 && Math.floor(p.y) === 64 && Math.floor(p.z) === 10 ? { name: 'blast_furnace', boundingBox: 'block' } : AIR),
    activeFurnaces: [{ pos: { x: 1, y: 2, z: 3 }, readyAt: Date.now() - 1000, item: 'raw_iron', count: 3, startedAt: Date.now() - 20_000 },
      { pos: { x: 5, y: 2, z: 3 }, readyAt: Date.now() + 60_000, item: 'raw_iron', count: 3, startedAt: Date.now() - 20_000 }],
    ...overrides,
  };
}
const one = (clause: Record<string, unknown>): ActCondition => readCondition([[clause]])!;

describe('act conditions: every clause kind', () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> = [
    ['have (ids ending in the item, worn armour counts)', { k: 'have', item: 'log', n: 10 }, { k: 'have', item: 'log', n: 11 }, 'log 10/11'],
    ['have of worn armour', { k: 'have', item: 'iron_helmet', n: 1 }, { k: 'have', item: 'iron_chestplate', n: 1 }, 'iron_chestplate 0/1'],
    ['have fewer than', { k: 'have', item: 'raw_iron', n: 3, op: '<' }, { k: 'have', item: 'raw_iron', n: 1, op: '<' }, 'raw_iron が 1 個'],
    ['food points carried', { k: 'food', n: 20 }, { k: 'food', n: 200 }, '食料'],
    ['hunger', { k: 'hunger', n: 15 }, { k: 'hunger', n: 16 }, '満腹 15/16'],
    ['hp', { k: 'hp', n: 18 }, { k: 'hp', n: 19 }, '体力 18/19'],
    ['dim', { k: 'dim', dim: 'the_nether' }, { k: 'dim', dim: 'overworld' }, '次元は overworld（今 the_nether）'],
    ['at within r', { k: 'at', x: 12, y: 64, z: 10, r: 4 }, { k: 'at', x: 50, y: 64, z: 10, r: 4 }, '(50,64,10) から 40m'],
    ['at in its dimension only', { k: 'at', x: 10, y: 64, z: 10, r: 4, dim: 'the_nether' }, { k: 'at', x: 10, y: 64, z: 10, r: 4, dim: 'overworld' }, '次元は overworld'],
    ['near (a name ending in the block)', { k: 'near', block: 'furnace', r: 4 }, { k: 'near', block: 'chest', r: 4 }, 'chest が 4m 内に無い'],
    ['free slots', { k: 'free', n: 30 }, { k: 'free', n: 32 }, '持ち物の空き 31/32'],
    ['night', { k: 'time', t: 'night' }, { k: 'time', t: 'day' }, '今は夜'],
    ['a furnace the body filled has finished', { k: 'furnace', x: 1, y: 2, z: 3 }, { k: 'furnace', x: 5, y: 2, z: 3 }, '焼きはまだ'],
    ['a furnace with no record is not finished', { k: 'hp', n: 1 }, { k: 'furnace', x: 9, y: 9, z: 9 }, '記録が無い'],
  ];
  it.each(cases)('%s', (_name, holds, lacks, words) => {
    const bot = body();
    expect(conditionHolds(bot, one(holds))).toBe(true);
    expect(conditionWords(bot, one(holds))).toBe('');
    expect(conditionHolds(bot, one(lacks))).toBe(false);
    expect(conditionWords(bot, one(lacks))).toContain(words);
  });
  it('safe: no hostile within r that can come to her', () => {
    const bot = body();
    expect(conditionHolds(bot, one({ k: 'safe', r: 8 }))).toBe(true);
    bot.entities = { 3: { id: 3, name: 'zombie', type: 'hostile', position: new Vec3(13.5, 64, 10.5), height: 1.9, width: 0.6 } };
    expect(conditionHolds(bot, one({ k: 'safe', r: 8 }))).toBe(false);
    expect(conditionWords(bot, one({ k: 'safe', r: 8 }))).toContain('zombie');
    expect(conditionHolds(bot, one({ k: 'safe', r: 2 }))).toBe(true);
  });
  it('day is the time a bed cannot be slept in, and thunder makes a night', () => {
    expect(conditionHolds(body({ time: { timeOfDay: 3000 } }), one({ k: 'time', t: 'day' }))).toBe(true);
    expect(conditionHolds(body({ time: { timeOfDay: 3000 }, thunderState: 1 }), one({ k: 'time', t: 'night' }))).toBe(true);
  });
  it('alternatives and conjunctions: any alternative whose clauses all hold; the words are the nearest alternative\'s missing clauses', () => {
    const bot = body();
    const condition = readCondition([[{ k: 'hp', n: 20 }, { k: 'dim', dim: 'the_nether' }], [{ k: 'have', item: 'log', n: 10 }, { k: 'hunger', n: 20 }]])!;
    expect(conditionHolds(bot, condition)).toBe(false);
    expect(conditionWords(bot, condition)).toMatch(/体力 18\/20|満腹 15\/20/u);
    const met = readCondition([[{ k: 'hp', n: 20 }], [{ k: 'have', item: 'log', n: 10 }, { k: 'dim', dim: 'the_nether' }]])!;
    expect(conditionHolds(bot, met)).toBe(true);
    expect(conditionMetText(bot, met)).toBe('have:log 10/10&dim:the_nether');
  });
});

describe('act conditions: the shape', () => {
  it('is strict: unknown keys, unknown kinds, empty lists, too many alternatives and bad ids are not conditions', () => {
    expect(readCondition([[{ k: 'hp', n: 5 }]])).not.toBeNull();
    expect(readCondition([[{ k: 'hp', n: 5, extra: 1 }]])).toBeNull();
    expect(readCondition([[{ k: 'sleep' }]])).toBeNull();
    expect(readCondition([])).toBeNull();
    expect(readCondition([[]])).toBeNull();
    expect(readCondition('hp>=5')).toBeNull();
    expect(readCondition(Array.from({ length: 5 }, () => [{ k: 'hp', n: 5 }]))).toBeNull();
    expect(readCondition([[{ k: 'have', item: 'Oak Log', n: 1 }]])).toBeNull();
    expect(readCondition([[{ k: 'near', block: 'stone', r: 9 }]])).toBeNull();
  });
  it('crosses the wire inside act\'s schema (depth and keys the catalog allows)', () => {
    const act = new Act({ instantSkills: {} } as never);
    const catalog = bodySkillCatalog([act as never], {});
    const schema = catalog.runnable.find(skill => skill.name === 'act')!.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['hands', 'stopIf', 'repeat', 'done']));
    const resolved = catalog.resolve('act', { hands: [{ do: 'wait', seconds: 1 }], repeat: 3, done: [[{ k: 'hp', n: 5 }]] });
    expect(resolved.args.slice(5)).toEqual([3, [[{ k: 'hp', n: 5 }]]]);
    expect(() => catalog.resolve('act', { hands: [{ do: 'wait', seconds: 1 }], repeat: 9 })).toThrow();
    expect(() => catalog.resolve('act', { hands: [{ do: 'wait', seconds: 1 }], done: [[{ k: 'bogus' }]] })).toThrow();
  });
});
