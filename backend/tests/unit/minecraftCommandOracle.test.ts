import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  MinecraftCommandOracle,
  prepareAssertion,
  normalizeVersionedCommand,
} from '../../src/services/minebot/testing/MinecraftCommandOracle.js';

class FakeCommandBot extends EventEmitter {
  commands: string[] = [];
  assertionPass = true;

  chat(command: string): void {
    this.commands.push(command);
    const marker = command.match(/SHANNON_TEST:(READY|SETUP|PASS|FAIL):[a-z0-9]+/)?.[0];
    if (!marker) return;
    const direct = command.startsWith('/tellraw ');
    const shouldEmit = direct
      || (marker.includes(':PASS:') && this.assertionPass)
      || (marker.includes(':FAIL:') && !this.assertionPass);
    if (shouldEmit) queueMicrotask(() => this.emit('message', { toString: () => marker }));
  }
}

describe('MinecraftCommandOracle', () => {
  it('clears old query results to an impossible sentinel before each query', async () => {
    const bot = new FakeCommandBot();
    const oracle = new MinecraftCommandOracle(bot);
    await oracle.evaluate({ type: 'gamerule', rule: 'spawn_mobs', value: false });
    const reset = bot.commands.findIndex(c => c.includes('scoreboard players set @s sh_test -2147483648'));
    const query = bot.commands.findIndex(c => c.includes('run gamerule minecraft:spawn_mobs'));
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(query).toBeGreaterThan(reset);
  });
  it('uses modern game-rule names while preserving older server compatibility', () => {
    expect(normalizeVersionedCommand('/gamerule natural_regeneration false', '1.21.11')).toBe('gamerule minecraft:natural_health_regeneration false');
    expect(normalizeVersionedCommand('/gamerule naturalRegeneration false', '1.21.11')).toBe('gamerule minecraft:natural_health_regeneration false');
    expect(normalizeVersionedCommand('/gamerule naturalRegeneration false', '1.21.10')).toBe('gamerule naturalRegeneration false');
    expect(normalizeVersionedCommand('/gamerule doMobSpawning false', '1.21.11')).toBe('gamerule minecraft:spawn_mobs false');
    expect(normalizeVersionedCommand('/gamerule doMobSpawning false', '1.21.10')).toBe('gamerule doMobSpawning false');
    expect(prepareAssertion({ type: 'gamerule', rule: 'spawn_mobs', value: false }).prepare)
      .toEqual(['execute store result score @s sh_test run gamerule minecraft:spawn_mobs']);
    expect(prepareAssertion({ type: 'block_at', x: 1, y: 99, z: 0, block: 'wheat', state: { age: 7 } }).positive)
      .toBe('if block 1 99 0 minecraft:wheat[age=7]');
  });
  it('turns bounded assertions into safe server-side execute predicates', () => {
    expect(prepareAssertion({ type: 'inventory_count', item: 'iron_ingot', minCount: 3 })).toEqual({
      prepare: ['execute store result score @s sh_test run clear @s minecraft:iron_ingot 0'],
      positive: 'if score @s sh_test matches 3..',
      negative: 'unless score @s sh_test matches 3..',
    });
    expect(prepareAssertion({
      type: 'position_within', x: 0, y: 64, z: 0, radius: 3,
    }).positive).toBe('positioned 0 64 0 if entity @s[distance=..3]');
    expect(prepareAssertion({
      type: 'entity_nearby', entity: 'zombie', maxDistance: 8, present: false,
    }).positive).toContain('unless entity @e[type=minecraft:zombie,distance=..8,limit=1]');
  });

  it('rejects command-injection-shaped resource locations', () => {
    expect(() => prepareAssertion({
      type: 'block_at', x: 0, y: 64, z: 0, block: 'stone run kill @a',
    })).toThrow('RESOURCE_LOCATION_INVALID');
  });

  it('counts tagged enemies in the fixed arena even if the bot flees', () => {
    expect(prepareAssertion({ type: 'entity_count', entity: 'zombie', tag: 'stress_target',
      x: 0, y: 100, z: 0, radius: 48, minCount: 0, maxCount: 0 })).toEqual({
      prepare: ['execute store result score @s sh_test run execute if entity @e[type=minecraft:zombie,x=0,y=100,z=0,distance=..48,tag=stress_target]'],
      positive: 'if score @s sh_test matches 0..0',
      negative: 'unless score @s sh_test matches 0..0',
    });
    expect(() => prepareAssertion({ type: 'entity_count', entity: 'zombie', tag: 'x] run kill @a',
      x: 0, y: 100, z: 0, radius: 48, minCount: 0 })).toThrow('ENTITY_TAG_INVALID');
  });

  it('rejects negative spatial assertion radii', () => {
    expect(() => prepareAssertion({
      type: 'position_within', x: 0, y: 64, z: 0, radius: -1,
    })).toThrow('ASSERTION_RADIUS_INVALID');
    expect(() => prepareAssertion({
      type: 'entity_nearby', entity: 'zombie', maxDistance: -1,
    })).toThrow('ASSERTION_RADIUS_INVALID');
  });

  it('uses tellraw markers to report pass and fail independently of a skill result', async () => {
    const bot = new FakeCommandBot();
    const oracle = new MinecraftCommandOracle(bot, 200);
    await oracle.verifyReady();

    const passed = await oracle.evaluate({ type: 'gamemode', gamemode: 'survival' });
    expect(passed).toMatchObject({ passed: true, error: null });

    bot.assertionPass = false;
    const failed = await oracle.evaluate({ type: 'dimension', dimension: 'overworld' });
    expect(failed).toMatchObject({ passed: false, error: null });
    expect(bot.commands.some(command => command.includes('run tellraw @s'))).toBe(true);
  });

  it('serializes scoreboard preparation before the assertion marker', async () => {
    const bot = new FakeCommandBot();
    const oracle = new MinecraftCommandOracle(bot, 200);
    const result = await oracle.evaluate({
      type: 'health_between', min: 10, max: 20,
    });
    expect(result.passed).toBe(true);
    expect(bot.commands).toContain('/scoreboard objectives add sh_test dummy');
    expect(bot.commands).toContain('/execute store result score @s sh_test run data get entity @s Health 100');
    expect(bot.commands.at(-2)).toContain('matches 1000..2000');
  });
});
