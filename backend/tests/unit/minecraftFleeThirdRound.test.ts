import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { executeAction } from '../../src/services/minebot/execution/ActionExecution.js';
import { floorConfig, reflexPromptText } from '../../src/services/minebot/utils/floorConfig.js';
import { noteAttackedBy } from '../../src/services/minebot/utils/hostileMobHints.js';
import { fleeHeading, fleeHeadingSafe, fleeStart, fleeThreat, floorEatChoice, hostileWithin, installFloorReflexes, isThreat, type FloorBody, type FloorState } from '../../src/services/minebot/utils/floorReflexes.js';
import { ensureReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';

// ---- terrain -------------------------------------------------------------------------------------------------------------------------
type Block = { name: string; boundingBox: string; shapes?: number[][] };
const AIR: Block = { name: 'air', boundingBox: 'empty' };
const FULL = [[0, 0, 0, 1, 1, 1]];
const stone: Block = { name: 'stone', boundingBox: 'block', shapes: FULL };
const water: Block = { name: 'water', boundingBox: 'empty' };
const block = (name: string, top: number, extra: Partial<Block> = {}): Block => ({ name, boundingBox: 'block', shapes: [[0, 0, 0, 1, top, 1]], ...extra });
const strip = (value: Block): Block => ({ name: value.name, boundingBox: value.boundingBox });

/** Stone up to `ground - 1`, then `patch` for single cells, else air: the body stands at y = ground (top of the stone). */
function world(options: { ground?: number; floor?: Block; patch?: (x: number, y: number, z: number) => Block | undefined; solid?: (x: number, z: number) => boolean } = {}) {
  const ground = options.ground ?? 65;
  return (position: Vec3): Block => {
    const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
    const patched = options.patch?.(x, y, z);
    if (patched) return patched;
    if (options.solid && !options.solid(x, z)) return AIR;
    if (y < ground - 1) return stone;
    if (y === ground - 1) return options.floor ?? stone;
    return AIR;
  };
}

function fixture(blockAt: (position: Vec3) => Block, patch: Record<string, unknown> = {}, at = new Vec3(0.5, 65, 0.5)) {
  const calls: Array<[string, unknown]> = [];
  const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, name: 'player', position: at, yaw: 0, pitch: 0, onGround: true },
    health: 5, food: 20, game: { dimension: 'overworld' }, entities: { 2: { id: 2, name: 'zombie', position: new Vec3(at.x + 2, at.y, at.z) } } as Record<string, any>,
    inventory: { items: () => [] as any[], slots: new Array(46).fill(null) }, controlState: {} as Record<string, boolean>, executingSkill: false, interruptExecution: false,
    clearControlStates: vi.fn(), setControlState: vi.fn((key: string, value: boolean) => { calls.push([key, value]); }), look: vi.fn(async () => {}),
    equip: vi.fn(async () => {}), consume: vi.fn(async () => {}), blockAt, ...patch });
  return { bot: bot as FloorBody & any, calls, ledger: ensureReflexLedger(bot) };
}
/** The direction a yaw faces: mineflayer's (-sin yaw, -cos yaw). */
const facing = (yaw: number) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
const state = (patch: Partial<FloorState> = {}): FloorState => ({ retreat: { engaged: false, ticks: 0, cooldown: 0, engagements: 0 }, busy: null, retryAt: 0, engagements: { eat: 0, armor: 0 }, fleeStarts: [], ...patch });
const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const tick = (bot: EventEmitter) => bot.emit('physicsTick');
const AWAY_FROM_ZOMBIE = Math.PI / 2; // the zombie is at +x, so away is -x: mineflayer yaw +PI/2

// ---- H1: half-block floors -----------------------------------------------------------------------------------------------------------
describe('H1: the low-health flee starts on floors that are not a whole block (the feet are inside the floor block\'s own cell)', () => {
  const FLOORS: Array<{ name: string; top: number; block: Block }> = [
    { name: 'oak_slab', top: 0.5, block: block('oak_slab', 0.5) },
    { name: 'soul_sand', top: 0.875, block: block('soul_sand', 0.875) },
    { name: 'farmland', top: 0.9375, block: block('farmland', 0.9375) },
    { name: 'dirt_path', top: 0.9375, block: block('dirt_path', 0.9375) },
    { name: 'white_carpet', top: 0.0625, block: block('white_carpet', 0.0625) },
    { name: 'oak_stairs (low step)', top: 0.5, block: { name: 'oak_stairs', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0, 0.5, 1, 1]] } },
    { name: 'mud', top: 0.875, block: block('mud', 0.875) },
    { name: 'honey_block', top: 0.9375, block: block('honey_block', 0.9375) },
    { name: 'snow (layers)', top: 0.5, block: block('snow', 0.5) },
  ];
  for (const stripped of [false, true]) {
    describe(stripped ? 'blocks without shape data (names only)' : 'blocks with their real shapes', () => {
      for (const { name, top, block: floor } of FLOORS) {
        it(`${name}: the heading is safe, straight away from the enemy, and the flee starts and runs`, async () => {
          const y = 64 + top, floorBlock = stripped ? strip(floor) : floor;
          const terrain = world({ ground: 65, floor: floorBlock });
          const { bot, calls } = fixture(terrain, {}, new Vec3(0.5, y, 0.5));
          bot.entities[2].position = new Vec3(2.5, y, 0.5);
          expect(fleeHeadingSafe(bot, bot.entity.position, AWAY_FROM_ZOMBIE)).toBe(true);
          const yaw = fleeHeading(bot, new Vec3(2.5, y, 0.5))!;
          expect(yaw).not.toBeNull(); expect(facing(yaw).x).toBeCloseTo(-1, 6); expect(facing(yaw).z).toBeCloseTo(0, 6);
          expect(fleeStart(bot, state(), Date.now())).not.toBeNull();
          installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1 });
          tick(bot);
          expect(bot.floorReflexes.busy).toBe('flee');
          await settle(60);
          expect(calls.some(([key, value]) => key === 'forward' && value === true)).toBe(true);
          expect(bot.floorReflexes.engagements.fleeRefused ?? 0).toBe(0);
        });
      }
    });
  }
  it('a lily pad on water: the flee starts (the floor cell is the pad, the water is under it)', () => {
    const terrain = world({ ground: 65, patch: (_x, y) => y === 63 ? water : y === 64 ? { name: 'lily_pad', boundingBox: 'block', shapes: [[0.0625, 0, 0.0625, 0.9375, 0.09375, 0.9375]] } : y < 63 ? stone : undefined });
    for (const pad of [false, true]) {
      const where = new Vec3(0.5, 64.09375, 0.5);
      const { bot } = fixture(pad ? (p => { const b = terrain(p); return b.name === 'lily_pad' ? strip(b) : b; }) : terrain, {}, where);
      bot.entities[2].position = new Vec3(2.5, 64.09375, 0.5);
      expect(fleeHeadingSafe(bot, where, AWAY_FROM_ZOMBIE), `shapes stripped: ${pad}`).toBe(true);
      expect(fleeStart(bot, state(), Date.now())).not.toBeNull();
    }
  });
  it('the old reading is what stood in the way: the feet\'s cell on a slab is the slab itself', () => {
    // Documented, not asserted against the code: floor(64.5) = 64 is the slab's cell, and a block there was taken for a wall.
    expect(Math.floor(64.5)).toBe(64);
    expect(Math.floor(64.5 - 0.01)).toBe(64); // the cell the feet rest on (the edge guard's floorY)
  });
});

describe('walls and steps on stairs and slabs terrain', () => {
  const ahead = (x: number, y: number, value: Block) => (cx: number, cy: number) => cx === x && cy === y ? value : undefined;
  it('on a whole-block floor: a slab, a stair or a carpet ahead is a step up, a whole block (or a ceiling) is a wall', () => {
    const run = (value: Block, y = 65) => {
      const { bot } = fixture(world({ ground: 65, patch: (cx, cy, cz) => cz === 0 || cz === 1 ? ahead(-1, y, value)(cx, cy) : undefined }));
      return fleeHeadingSafe(bot, bot.entity.position, AWAY_FROM_ZOMBIE);
    };
    expect(run(block('oak_slab', 0.5))).toBe(true);
    expect(run({ name: 'oak_stairs', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0, 0.5, 1, 1]] })).toBe(true);
    expect(run(block('white_carpet', 0.0625))).toBe(true);
    expect(run(strip(block('oak_slab', 0.5)))).toBe(true); expect(run(strip(block('oak_stairs', 1)))).toBe(true); expect(run(strip(block('white_carpet', 1)))).toBe(true);
    expect(run(stone)).toBe(false);
    expect(run(strip(stone))).toBe(false);
    // A ceiling the head would hit: one block above the feet's cell.
    expect(run(stone, 66)).toBe(false);
    expect(run(block('oak_slab', 1, { shapes: [[0, 0.5, 0, 1, 1, 1]] }), 66)).toBe(false); // a top slab at head height
    // Out of reach: three blocks up is no obstacle to a body that is 1.8 tall.
    expect(run(stone, 67)).toBe(true);
  });
  it('on a slab (feet at 64.5): the whole block beside it at its own height is a step, the same block one up is a wall, and so is a slab one up', () => {
    const at = new Vec3(0.5, 64.5, 0.5);
    const walk = (value: Block, y: number) => {
      const { bot } = fixture(world({ ground: 65, floor: block('oak_slab', 0.5), patch: (cx, cy) => cx === -1 && cy === y ? value : undefined }), {}, at);
      return fleeHeadingSafe(bot, at, AWAY_FROM_ZOMBIE);
    };
    expect(walk(stone, 64)).toBe(true);
    expect(walk(stone, 65)).toBe(false);
    expect(walk(block('oak_slab', 0.5), 65)).toBe(false);
    expect(walk(block('oak_stairs', 1, { shapes: [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0, 0.5, 1, 1]] }), 64)).toBe(true);
  });
  it('a field of slabs and a field of stairs: every way is open, and the flee picks the way straight away', () => {
    for (const floor of [block('oak_slab', 0.5), { name: 'oak_stairs', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0, 0.5, 1, 1]] }] as Block[]) {
      const { bot } = fixture(world({ ground: 65, floor }), {}, new Vec3(0.5, 64.5, 0.5));
      for (let step = 0; step < 8; step++) expect(fleeHeadingSafe(bot, bot.entity.position, step * Math.PI / 4)).toBe(true);
      expect(facing(fleeHeading(bot, new Vec3(2.5, 64.5, 0.5))!).x).toBeCloseTo(-1, 6);
    }
  });
  it('a drop beside a slab floor is still a drop: a three-block fall is refused, a cliff of a few blocks is not run off', () => {
    const edge = world({ ground: 65, floor: block('oak_slab', 0.5), solid: x => x >= -1 });
    const { bot } = fixture(edge, {}, new Vec3(0.5, 64.5, 0.5));
    expect(fleeHeadingSafe(bot, bot.entity.position, AWAY_FROM_ZOMBIE)).toBe(false);
    const yaw = fleeHeading(bot, new Vec3(2.5, 64.5, 0.5));
    if (yaw !== null) expect(facing(yaw).x).toBeGreaterThan(-0.9);
  });
});

// ---- L: the lethal set, and water ----------------------------------------------------------------------------------------------------
describe('what the flee will not run into (cobweb, berry bush, powder snow, magma, campfire) and water', () => {
  it.each([['cobweb'], ['sweet_berry_bush'], ['powder_snow'], ['cactus'], ['fire'], ['campfire']])('%s in the way (feet cell or head cell) refuses that heading, and another is taken', name => {
    for (const y of [65, 66]) {
      const { bot } = fixture(world({ patch: (x, cy) => x === -1 && cy === y ? { name, boundingBox: 'empty' } : undefined }));
      expect(fleeHeadingSafe(bot, bot.entity.position, AWAY_FROM_ZOMBIE), `${name} at ${y}`).toBe(false);
      const yaw = fleeHeading(bot, new Vec3(2.5, 65, 0.5))!;
      expect(yaw).not.toBeNull(); expect(facing(yaw).x).toBeGreaterThan(-0.8);
    }
  });
  it('magma under the cell (and a campfire as the floor) is lethal to stand on; magma two down is not', () => {
    const on = (name: string, y: number) => fixture(world({ patch: (x, cy) => x === -1 && cy === y ? { name, boundingBox: 'block', shapes: FULL } : undefined })).bot;
    expect(fleeHeadingSafe(on('magma_block', 64), new Vec3(0.5, 65, 0.5), AWAY_FROM_ZOMBIE)).toBe(false);
    expect(fleeHeadingSafe(on('magma_block', 63), new Vec3(0.5, 65, 0.5), AWAY_FROM_ZOMBIE)).toBe(true);
  });
  // Land for x <= -4, water (two deep, over a stone bed) for x > -4.
  const shore = (inWater: boolean, at: Vec3) => {
    const terrain = (position: Vec3): Block => {
      const x = Math.floor(position.x), y = Math.floor(position.y);
      if (y <= 61) return stone;
      if (x <= -4) return y <= 63 ? stone : AIR;
      return y === 62 ? stone : y <= 64 ? water : AIR;
    };
    const made = fixture(terrain, { entity: { id: 1, name: 'player', position: at, yaw: 0, pitch: 0, onGround: !inWater, isInWater: inWater } }, at);
    return made;
  };
  it('from land it does not run into deep water, and from the water it runs only for a shore (chased by a drowned)', () => {
    // On the shore (x = -4.5, standing at y 64): the drowned in the water, +x, so straight away is -x onto land. Fine.
    const land = shore(false, new Vec3(-3.5, 64, 0.5));
    land.bot.entities = { 2: { id: 2, name: 'drowned', position: new Vec3(-1.5, 63.5, 0.5) } };
    // Running east (into the lake) is refused; running west (inland) is fine.
    expect(fleeHeadingSafe(land.bot, land.bot.entity.position, -Math.PI / 2)).toBe(false);
    expect(fleeHeadingSafe(land.bot, land.bot.entity.position, Math.PI / 2)).toBe(true);
    // Swimming, the shore 4 blocks west: heading west reaches ground, heading east does not.
    const swim = shore(true, new Vec3(-0.5, 63.5, 0.5));
    swim.bot.entities = { 2: { id: 2, name: 'drowned', position: new Vec3(1.5, 63.5, 0.5) } };
    expect(fleeHeadingSafe(swim.bot, swim.bot.entity.position, Math.PI / 2)).toBe(true);
    expect(fleeHeadingSafe(swim.bot, swim.bot.entity.position, -Math.PI / 2)).toBe(false);
    expect(facing(fleeHeading(swim.bot, new Vec3(1.5, 63.5, 0.5))!).x).toBeLessThan(-0.7);
    // With the drowned between the body and the shore (west), the way out is toward it: the flee does not start rather than swim to sea.
    swim.bot.entities = { 2: { id: 2, name: 'drowned', position: new Vec3(-1.5, 63.5, 0.5) } };
    expect(fleeHeading(swim.bot, new Vec3(-1.5, 63.5, 0.5))).toBeNull();
    const refused = state();
    expect(fleeStart(swim.bot, refused, Date.now())).toBeNull(); expect(refused.engagements.fleeRefused).toBe(1);
  });
});

// ---- M1: one threat predicate --------------------------------------------------------------------------------------------------------
describe('M1: what the flee (and eating, and the pickup) takes for an enemy is the legacy isThreatEntity', () => {
  const registry = { entitiesByName: {
    silverfish: { type: 'hostile' }, vex: { type: 'hostile' }, ravager: { type: 'hostile' }, guardian: { type: 'hostile' }, elder_guardian: { type: 'hostile' }, bogged: { type: 'hostile' },
    endermite: { type: 'hostile' }, zombie_villager: { type: 'hostile' }, warden: { type: 'hostile' }, evoker: { type: 'hostile' }, ghast: { type: 'hostile' }, breeze: { type: 'hostile' },
    zombified_piglin: { type: 'hostile' }, piglin: { type: 'hostile' }, enderman: { type: 'hostile', metadataKeys: ['a', 'b', 'creepy'] },
    cow: { type: 'animal' }, villager: { type: 'passive' }, iron_golem: { type: 'passive' }, wolf: { type: 'animal' }, bee: { type: 'animal' },
  } };
  const alone = (name: string, patch: Record<string, unknown> = {}, entity: Record<string, unknown> = {}) => {
    const made = fixture(world(), { registry, ...patch });
    made.bot.entities = { 2: { id: 2, name, position: new Vec3(2.5, 65, 0.5), ...entity } };
    return made.bot as FloorBody & any;
  };
  it.each(['silverfish', 'vex', 'ravager', 'guardian', 'elder_guardian', 'bogged', 'endermite', 'zombie_villager', 'warden', 'evoker', 'ghast', 'breeze', 'husk', 'cave_spider', 'drowned', 'creeper'])('%s is run from (listed in the old 19, or hostile by the game\'s own kind)', name => {
    const bot = alone(name);
    expect(isThreat(bot, bot.entities[2])).toBe(true);
    expect(fleeThreat(bot)?.threats).toHaveLength(1);
  });
  it.each(['cow', 'villager', 'iron_golem', 'wolf', 'bee'])('%s is not a threat until it has struck the body', name => {
    const bot = alone(name);
    expect(fleeThreat(bot)).toBeNull(); expect(hostileWithin(bot, 5)).toBe(false);
  });
  it('a mob that hit the body is a threat for a while whatever it is (noteAttackedBy), as in the legacy system', () => {
    const bot = alone('bee');
    expect(fleeThreat(bot)).toBeNull();
    noteAttackedBy('bee');
    expect(fleeThreat(bot)?.threats).toHaveLength(1); expect(hostileWithin(bot, 5)).toBe(true);
  });
  it('a zombified piglin and an enderman are threats only once angry or after a strike; a piglin only while the body wears no gold', () => {
    expect(fleeThreat(alone('zombified_piglin'))).toBeNull();
    const calm = alone('enderman', {}, { metadata: [0, 0, false] }); expect(fleeThreat(calm)).toBeNull();
    const angry = alone('enderman', {}, { metadata: [0, 0, true] }); expect(fleeThreat(angry)).not.toBeNull();
    const naked = alone('piglin'); expect(fleeThreat(naked)).not.toBeNull();
    const slots = new Array(46).fill(null); slots[6] = { name: 'golden_chestplate' };
    const gilded = alone('piglin', { inventory: { items: () => [], slots } }); expect(fleeThreat(gilded)).toBeNull();
    noteAttackedBy('zombified_piglin');
    expect(fleeThreat(alone('zombified_piglin'))).not.toBeNull();
  });
  it('the entity\'s own kind field counts when the registry does not say (a "hostile" type)', () => {
    const bot = alone('some_new_mob', { registry: null }, { type: 'hostile' });
    expect(fleeThreat(bot)).not.toBeNull();
    const peaceful = alone('some_new_mob', { registry: null }, { type: 'animal' });
    expect(fleeThreat(peaceful)).toBeNull();
  });
  it('eating waits for any such enemy within 5 blocks in the default mode; `floor` keeps the production list of names (a silverfish does not stop a meal there)', async () => {
    const eats = async (env: Record<string, string>) => {
      const made = fixture(world(), { registry, health: 20, food: 3, inventory: { items: () => [{ name: 'bread' }], slots: new Array(46).fill(null) } });
      made.bot.entities = { 2: { id: 2, name: 'silverfish', position: new Vec3(3.5, 65, 0.5) } };
      installFloorReflexes(made.bot, floorConfig(env)); tick(made.bot); await settle(10);
      return made.bot.consume.mock.calls.length;
    };
    expect(await eats({})).toBe(0);
    expect(await eats({ MINEBOT_FCA_REFLEXES: 'floor' })).toBe(1);
    const made = fixture(world(), { registry, health: 20, food: 3, inventory: { items: () => [{ name: 'bread' }], slots: new Array(46).fill(null) } });
    made.bot.entities = { 2: { id: 2, name: 'silverfish', position: new Vec3(3.5, 65, 0.5) } };
    expect(floorEatChoice(made.bot)).toBeNull(); expect(floorEatChoice(made.bot, false)?.name).toBe('bread');
  });
});

// ---- M5: all threats, in every direction ---------------------------------------------------------------------------------------------
describe('M5: the flee runs from all the threats at once', () => {
  const at = new Vec3(0.5, 65, 0.5);
  const run = (threats: Vec3[], blockAt = world()) => {
    const { bot } = fixture(blockAt, {}, at);
    const yaw = fleeHeading(bot, threats);
    return yaw === null ? null : facing(yaw);
  };
  it('two threats at right angles: straight between away from both (the diagonal)', () => {
    const way = run([new Vec3(3.5, 65, 0.5), new Vec3(0.5, 65, 3.5)])!;
    expect(way.x).toBeLessThan(-0.6); expect(way.z).toBeLessThan(-0.6);
    expect(Math.abs(way.x - way.z)).toBeLessThan(0.05);
  });
  it('the near one counts more: a zombie at 1.5 m east and a skeleton at 6 m north push the body mostly west, a little south', () => {
    const way = run([new Vec3(2, 65, 0.5), new Vec3(0.5, 65, 6.5)])!;
    expect(way.x).toBeLessThan(-0.9); expect(way.z).toBeLessThan(0);
  });
  it('threats on two opposite sides: the gap between them (across), not along the line toward either', () => {
    const way = run([new Vec3(3.5, 65, 0.5), new Vec3(-2.5, 65, 0.5)])!;
    expect(Math.abs(way.x)).toBeLessThan(0.35); expect(Math.abs(way.z)).toBeGreaterThan(0.9);
  });
  it('a near threat east and a far one west on the same line: it does not run into the far one, it goes across', () => {
    const way = run([new Vec3(2.5, 65, 0.5), new Vec3(-4.5, 65, 0.5)])!;
    expect(Math.abs(way.x)).toBeLessThan(0.6); expect(Math.abs(way.z)).toBeGreaterThan(0.7);
  });
  it('three around it: out through the open side', () => {
    const way = run([new Vec3(3.5, 65, 0.5), new Vec3(-2.5, 65, 0.5), new Vec3(0.5, 65, 3.5)])!;
    expect(way.z).toBeLessThan(-0.9);
  });
  it('a ravine on the preferred side: the turn it takes is safe and not toward either threat', () => {
    // Ground only for z >= -1.5 (a cliff to the north, where "away from both" points).
    const cliff = world({ solid: (_x, z) => z >= -1 });
    const way = run([new Vec3(3.5, 65, 0.5), new Vec3(0.5, 65, 3.5)], cliff);
    expect(way).not.toBeNull();
    expect(way!.z).toBeLessThanOrEqual(0.01); // never south, toward the second threat
    expect(way!.x).toBeLessThan(0);           // the open side: west
  });
  it('the flee reads every threat in range from the entities (not only the nearest) and keeps them for the heading', () => {
    const { bot } = fixture(world(), {}, at);
    bot.entities = { 2: { id: 2, name: 'zombie', position: new Vec3(3.5, 65, 0.5) }, 3: { id: 3, name: 'skeleton', position: new Vec3(0.5, 65, 12.5) },
      4: { id: 4, name: 'spider', position: new Vec3(-5.5, 65, 0.5) }, 5: { id: 5, name: 'zombie', position: new Vec3(0.5, 65, -9.5) } };
    const found = fleeThreat(bot)!;
    // The zombie (3 m), the spider (6 m) and the skeleton (a shooter, 12 m); the second zombie at 10 m is beyond 8.
    expect(found.threats).toHaveLength(3); expect(found.nearest).toBeCloseTo(3, 6); expect(found.from.x).toBe(3.5);
    expect(fleeThreat(bot, true)!.threats).toHaveLength(4);
  });
});

// ---- the episode ---------------------------------------------------------------------------------------------------------------------
describe('the flee runs in segments for as long as the danger is near, up to the cap, and is bounded', () => {
  /** A body that moves 0.28 blocks along the heading each tick the forward key is set, and a zombie that stays or follows. */
  function chase(options: { follow?: boolean; speed?: number; blockAtWorld?: (position: Vec3) => Block } = {}) {
    const clock = { at: 5_000_000 };
    const made = fixture(options.blockAtWorld ?? world({ ground: 65 }), {}, new Vec3(0.5, 65, 0.5));
    const { bot } = made;
    let yaw = 0;
    bot.look = vi.fn(async (value: number) => { yaw = value; });
    bot.setControlState = vi.fn((key: string, value: boolean) => {
      if (key === 'forward' && value) bot.entity.position = bot.entity.position.offset(-Math.sin(yaw) * (options.speed ?? 0.28), 0, -Math.cos(yaw) * (options.speed ?? 0.28));
      if (options.follow && key === 'forward' && value) bot.entities[2].position = bot.entity.position.offset(2, 0, 0);
    });
    installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1, now: () => clock.at });
    const distance = () => bot.entity.position.distanceTo(bot.entities[2].position);
    return { ...made, clock, distance, yawOf: () => yaw };
  }
  async function drive(sim: ReturnType<typeof chase>, until: () => boolean, rounds = 400, advance = 50) {
    for (let round = 0; round < rounds && !until(); round++) {
      // The clock moves only between segments, so that a long step of it does not pass while a segment runs.
      while (sim.bot.floorReflexes.busy) await settle(2);
      sim.clock.at += advance; tick(sim.bot); await settle(3);
    }
  }
  it('keeps running past the 8 m it started at, in more than one segment, until the enemy is more than 12 m away, then stops: one ledger entry, one of the two allowed', async () => {
    const sim = chase();
    await drive(sim, () => sim.bot.floorReflexes.engagements.flee === 1 && !sim.bot.floorReflexes.fleeEpisode && !sim.bot.floorReflexes.busy && sim.distance() > 12);
    await settle(20);
    expect(sim.distance()).toBeGreaterThan(12); expect(sim.distance()).toBeLessThan(15);
    expect(sim.bot.floorReflexes.engagements.flee).toBe(1);
    expect(sim.bot.floorReflexes.fleeStarts).toHaveLength(1);
    expect(sim.ledger.entriesSince(-1).filter(entry => entry.kind === 'flee').map(entry => entry.outcome)).toEqual(['done']);
    expect(sim.bot.entity.position.distanceTo(new Vec3(0.5, 65, 0.5))).toBeGreaterThan(9);
    expect(sim.bot.controlState.forward).not.toBe(true);
    expect(sim.bot.floorReflexes.busy).toBeNull();
  }, 20_000);
  it('a pursuer that keeps up is run from for 32 blocks at most, then the body is let go for 2 s (the API\'s turn) and the next episode is the second of two', async () => {
    const sim = chase({ follow: true });
    const origin = sim.bot.entity.position.clone();
    await drive(sim, () => !!sim.bot.floorReflexes.fleeRestUntil && !sim.bot.floorReflexes.fleeEpisode && !sim.bot.floorReflexes.busy);
    await settle(20);
    const moved = sim.bot.entity.position.distanceTo(origin);
    expect(moved).toBeGreaterThanOrEqual(32); expect(moved).toBeLessThan(42);
    expect(sim.bot.floorReflexes.engagements.flee).toBe(1);
    expect(sim.ledger.entriesSince(-1).filter(entry => entry.kind === 'flee')).toHaveLength(1);
    // Within the rest nothing starts, however many ticks come; after it, the second episode starts, and a third would not (two in 20 s).
    const writes = sim.bot.setControlState.mock.calls.length;
    sim.clock.at += 1500; for (let i = 0; i < 5; i++) { tick(sim.bot); await settle(3); }
    expect(sim.bot.setControlState.mock.calls.length).toBe(writes); expect(sim.bot.floorReflexes.engagements.flee).toBe(1);
    sim.clock.at += 700; tick(sim.bot);
    expect(sim.bot.floorReflexes.engagements.flee).toBe(2); expect(sim.bot.floorReflexes.busy).toBe('flee');
  }, 30_000);
  it('ends after 6 seconds even when it is still getting away', async () => {
    const sim = chase({ follow: true, speed: 0.1 });
    const origin = sim.bot.entity.position.clone();
    // A segment is 24 ticks of 0.1 = 2.4 blocks (headway); the clock goes 1.6 s a round: five rounds pass 6 s.
    await drive(sim, () => !!sim.bot.floorReflexes.fleeRestUntil && !sim.bot.floorReflexes.fleeEpisode && !sim.bot.floorReflexes.busy, 60, 1600);
    await settle(20);
    expect(sim.bot.floorReflexes.fleeRestUntil).toBeGreaterThan(0);
    expect(sim.bot.entity.position.distanceTo(origin)).toBeLessThan(32);
    expect(sim.ledger.entriesSince(-1).filter(entry => entry.kind === 'flee')).toHaveLength(1);
  }, 30_000);
  it('gives up a run that is not getting anywhere (two segments of no headway) and rests', async () => {
    const sim = chase({ speed: 0 });
    await drive(sim, () => !!sim.bot.floorReflexes.fleeRestUntil && !sim.bot.floorReflexes.fleeEpisode && !sim.bot.floorReflexes.busy, 100);
    await settle(20);
    expect(sim.bot.floorReflexes.fleeRestUntil).toBeGreaterThan(0);
    const segments = sim.bot.setControlState.mock.calls.filter(([key, value]: [string, boolean]) => key === 'forward' && value === true).length;
    expect(segments).toBeGreaterThan(0); expect(segments).toBeLessThanOrEqual(72); // three segments of 24 ticks at the very most
  }, 30_000);
  it('a command waiting for the body ends the segment at once (after a fifth of a second) and gets it, and the flee does not take it back for 2 s', async () => {
    const sim = chase({ follow: true });
    tick(sim.bot);
    expect(sim.bot.floorReflexes.busy).toBe('flee');
    await settle(10);
    const command = executeAction(sim.bot, 'move-to', 2000, async () => ({ success: true, result: 'arrived' }), { priority: 0, waitForQuiescence: true });
    const began = Date.now();
    expect(await command).toMatchObject({ success: true, result: 'arrived' });
    expect(Date.now() - began).toBeLessThan(800);
    await settle(20);
    expect(sim.bot.floorReflexes.busy).toBeNull();
    const writes = sim.bot.setControlState.mock.calls.length;
    for (let i = 0; i < 5; i++) { sim.clock.at += 100; tick(sim.bot); await settle(3); }
    expect(sim.bot.setControlState.mock.calls.length).toBe(writes);
    expect(sim.ledger.entriesSince(-1).filter(entry => entry.kind === 'flee').map(entry => entry.outcome)).toEqual(['done']);
  }, 30_000);
});

describe('a flee that is refused is told to the mind and does not cost a search every tick', () => {
  const pillar = () => world({ solid: (x, z) => x === 0 && z === 0 });
  it('records one ledger entry the mind reads in state.world.reflexes, and not another for 10 s', () => {
    const { bot, ledger } = fixture(pillar());
    const flee = state();
    expect(fleeStart(bot, flee, 1_000_000)).toBeNull();
    const entries = ledger.entriesSince(-1);
    expect(entries).toHaveLength(1); expect(entries[0]).toMatchObject({ kind: 'flee', outcome: 'failed' });
    expect(entries[0].detail).toContain('逃げ道'); expect(entries[0].detail.length).toBeLessThanOrEqual(40);
    expect(ledger.summary()!.recent[0]).toMatchObject({ kind: 'flee' });
    expect(flee.engagements.fleeRefused).toBe(1);
    for (let at = 1_000_600; at < 1_009_000; at += 600) fleeStart(bot, flee, at);
    expect(ledger.entriesSince(-1)).toHaveLength(1);
    expect(fleeStart(bot, flee, 1_011_000)).toBeNull();
    expect(ledger.entriesSince(-1)).toHaveLength(2);
  });
  it('reads the ground once per half second, not once per tick', () => {
    const { bot } = fixture(pillar());
    const flee = state(), reads = vi.spyOn(bot, 'blockAt');
    expect(fleeStart(bot, flee, 1_000_000)).toBeNull();
    const first = reads.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    for (let i = 1; i <= 9; i++) fleeStart(bot, flee, 1_000_000 + i * 50);
    expect(reads.mock.calls.length).toBe(first); expect(flee.engagements.fleeRefused).toBe(1);
    expect(fleeStart(bot, flee, 1_000_501)).toBeNull();
    expect(reads.mock.calls.length).toBeGreaterThan(first); expect(flee.engagements.fleeRefused).toBe(2);
  });
  it('through the reflex: the body is not taken, no key is touched, and the mind can read why', async () => {
    const { bot, calls, ledger } = fixture(pillar());
    installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1 });
    for (let i = 0; i < 20; i++) { tick(bot); await settle(2); }
    expect(calls).toEqual([]); expect(bot.floorReflexes.busy).toBeNull();
    expect(ledger.summary()!.recent.filter(entry => entry.kind === 'flee')).toHaveLength(1);
    expect(bot.floorReflexes.engagements.flee).toBe(0);
  });
});

// ---- words ---------------------------------------------------------------------------------------------------------------------------
describe('the prompts say what the default floor really does', () => {
  it('reflexPromptText names retreat, eating, armour, the flee (and that it cuts the fight) and the pickup by default, and only the production floor in `floor` mode', () => {
    const all = reflexPromptText(floorConfig({}));
    for (const word of ['クリーパー', '矢', '食べる', '防具', '走って離れる', '実行中の戦闘・作業を中断', '20秒に2回', '落とし物']) expect(all).toContain(word);
    const production = reflexPromptText(floorConfig({ MINEBOT_FCA_REFLEXES: 'floor' }));
    expect(production).toContain('クリーパー'); expect(production).not.toContain('走って離れる'); expect(production).not.toContain('落とし物');
    expect(reflexPromptText(floorConfig({ MINEBOT_FCA_REFLEXES: 'off' }))).toBe('床の反射は動いていない');
    expect(reflexPromptText(floorConfig({ MINEBOT_FCA_REFLEX_OFF: 'flee;pickup' }))).not.toContain('走って離れる');
  });
  it('both skills build their common-FCA sentence from it', () => {
    for (const file of ['acceptThreat.ts', 'attackContinuously.ts']) {
      const source = readFileSync(new URL(`../../src/services/minebot/instantSkills/${file}`, import.meta.url), 'utf8');
      expect(source, file).toContain('reflexPromptText()');
      expect(source, file).not.toContain('下がる・食べる・防具だけは動く');
    }
  });
  it('the lab probe states its floor: the production floor unless MINECRAFT_PROBE_FLOOR says default (or off)', () => {
    const source = readFileSync(new URL('../../src/services/minebot/testing/MinecraftProbeBot.ts', import.meta.url), 'utf8');
    expect(source).toContain("process.env.MINECRAFT_PROBE_FLOOR ?? 'floor'");
    expect(source).toContain("floorConfig({ MINEBOT_FCA_REFLEXES: 'floor' })");
    expect(source).not.toContain('floorReflexPlugin');
  });
});
