import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { boxDistance, DRAGON_PHASE, isPerched, partBox, partDamage, partOffset, partTarget, flameCloudCentre } from '../../src/services/minebot/utils/dragonParts.js';
import { breathCloudsOf, crystalCaged, crystalsOf, dragonView, endObservation, fireballPath, fountainOf, metaIndex, SPIKE_CENTRES, spikeStates } from '../../src/services/minebot/utils/dragonState.js';
import { attack } from '../../src/services/minebot/utils/primitives/attack.js';
import { partToStrike, swingWaitMs } from '../../src/services/minebot/utils/primitives/dragonStrike.js';

const KEYS = { ender_dragon: ['shared_flags', 'air_supply', 'custom_name', 'custom_name_visible', 'silent', 'no_gravity', 'pose', 'ticks_frozen', 'living_entity_flags', 'health',
  'effect_particles', 'effect_ambience', 'arrow_count', 'stinger_count', 'sleeping_pos', 'mob_flags', 'phase'],
  end_crystal: ['shared_flags', 'air_supply', 'custom_name', 'custom_name_visible', 'silent', 'no_gravity', 'pose', 'ticks_frozen', 'beam_target', 'show_bottom'],
  area_effect_cloud: ['shared_flags', 'air_supply', 'custom_name', 'custom_name_visible', 'silent', 'no_gravity', 'pose', 'ticks_frozen', 'radius', 'waiting', 'particle'] };

type World = Map<string, string>;
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
/** The End as a test sees it: the pillar's bedrock at x 0, z 0 (y 64..67), end stone round it at y 63, the rest air. */
function endWorld(): World {
  const world: World = new Map();
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) world.set(key(x, 63, z), 'end_stone');
  for (let y = 64; y <= 67; y++) world.set(key(0, y, 0), 'bedrock');
  return world;
}
function metadata(phase: number | null, health: number | null) {
  const meta: unknown[] = [];
  if (health !== null) meta[9] = health;
  if (phase !== null) meta[16] = phase;
  return meta;
}
function fixture(options: { phase?: number | null; health?: number; yaw?: number; at?: Vec3; world?: World } = {}) {
  const world = options.world ?? endWorld();
  const dragon: any = { id: 100, name: 'ender_dragon', uuid: 'dragon-1', position: new Vec3(0.5, 68, 0.5), yaw: options.yaw ?? 0, height: 8, width: 16,
    metadata: metadata(options.phase === undefined ? DRAGON_PHASE.sittingScanning : options.phase, options.health ?? 200) };
  const self: any = { id: 1, position: options.at ?? new Vec3(0.5, 64, 7.5), yaw: 0, pitch: 0, onGround: true, velocity: new Vec3(0, 0, 0) };
  const bot: any = Object.assign(new EventEmitter(), {
    game: { dimension: 'minecraft:the_end', difficulty: 'normal' }, entity: self, entities: { 100: dragon } as Record<number, any>,
    registry: { entitiesByName: Object.fromEntries(Object.entries(KEYS).map(([name, metadataKeys]) => [name, { metadataKeys }])) },
    heldItem: { name: 'diamond_sword' }, health: 20, food: 20,
    blockAt: (v: Vec3) => { const name = world.get(key(v.x, v.y, v.z)) ?? 'air'; return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: v }; },
    attack: vi.fn(), lookAt: vi.fn(async () => undefined), clearControlStates: vi.fn(), setControlState: vi.fn(), activateItem: vi.fn(), deactivateItem: vi.fn(),
    inventory: { items: () => [], slots: [] },
  });
  return { bot, dragon, self, world };
}
const ctxOf = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 60_000, facing: 'north' as const, base: { x: 0, y: 64, z: 7 } });

describe('the dragon\'s parts', () => {
  it('puts the head 6.5 blocks out along the yaw and one below the body, and the other parts as the server ticks them', () => {
    expect(partOffset('head', 0)).toMatchObject({ x: 0, y: -1, z: 6.5 });
    const turned = partOffset('head', Math.PI / 2);
    expect(turned.x).toBeCloseTo(6.5); expect(turned.z).toBeCloseTo(0);
    expect(partOffset('neck', 0)).toMatchObject({ z: 5.5, y: -1 });
    expect(partOffset('wing1', 0)).toMatchObject({ x: -4.5, y: 2 });
    expect(partOffset('wing2', 0)).toMatchObject({ x: 4.5, y: 2 });
    const box = partBox({ position: new Vec3(0.5, 68, 0.5), yaw: 0 }, 'head');
    expect(box).toMatchObject({ minY: 67, maxY: 68, minZ: 6.5, maxZ: 7.5 });
  });
  it('names the part by the body\'s id plus its offset, and takes a quarter and a block of a sword for any part but the head', () => {
    const target = partTarget({ id: 100, position: new Vec3(0.5, 68, 0.5), yaw: 0 }, 'head');
    expect(target).toMatchObject({ id: 101, dragonId: 100, dragonPart: 'head' });
    expect(partTarget({ id: 100, position: new Vec3(0, 0, 0), yaw: 0 }, 'wing2').id).toBe(108);
    expect(partDamage('head', 7)).toBe(7);
    expect(partDamage('body', 7)).toBeCloseTo(2.75);
    expect(partDamage('neck', 0.5)).toBeCloseTo(0.625);
  });
  it('knows the perch phases and where the flame lands: 2.5 blocks past the head', () => {
    expect([4, 5, 6, 7, 8].map(isPerched)).toEqual([false, true, true, true, false]);
    const flame = flameCloudCentre({ position: new Vec3(0.5, 68, 0.5), yaw: 0 });
    expect(flame.z).toBeCloseTo(7 + 2.5); expect(flame.x).toBeCloseTo(0.5);
  });
  it('waits the weapon\'s own time between blows', () => {
    expect(swingWaitMs('diamond_sword')).toBe(650); expect(swingWaitMs('iron_axe')).toBe(1250); expect(swingWaitMs(undefined)).toBe(300);
  });
});

describe('what the body reads of the fight', () => {
  it('reads the phase and the health by the names in the game\'s data', () => {
    const f = fixture({ phase: 5, health: 150 });
    expect(metaIndex(f.bot, 'ender_dragon', 'phase')).toBe(16);
    const view = dragonView(f.bot, f.dragon);
    expect(view).toMatchObject({ id: 100, health: 150, phase: 5, phaseName: 'sitting_flaming', perched: true });
  });
  it('says the head is in reach under it, out of reach far off, and gives no head while the dragon flies', () => {
    const under = dragonView(fixture({ at: new Vec3(0.5, 64, 7) }).bot, fixture().dragon);
    const f = fixture({ at: new Vec3(0.5, 64, 7.0) });
    expect(dragonView(f.bot, f.dragon)).toMatchObject({ perched: true, strike: true });
    expect(under.perched).toBe(true);
    const far = fixture({ at: new Vec3(0.5, 64, 14) });
    expect(dragonView(far.bot, far.dragon)).toMatchObject({ perched: true, strike: false });
    const flying = fixture({ phase: 0 });
    expect(dragonView(flying.bot, flying.dragon)).toMatchObject({ perched: false, head: null, headReach: null, strike: false });
  });
  it('finds the pillar\'s top and reads the cage round a crystal', () => {
    const f = fixture();
    expect(fountainOf(f.bot)).toEqual({ x: 0.5, y: 68, z: 0.5 });
    const crystal = { id: 7, name: 'end_crystal', position: new Vec3(20.5, 81, 20.5), metadata: [] as unknown[] };
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) f.world.set(key(20 + dx, 82, 20 + dz), 'iron_bars');
    f.world.set(key(20, 83, 20), 'iron_bars');
    expect(crystalCaged(f.bot, crystal)).toBe(true);
    const open = { id: 8, name: 'end_crystal', position: new Vec3(-20.5, 81, 20.5), metadata: [] as unknown[] };
    f.world.set(key(-21, 81, 20), 'air');
    expect(crystalCaged(f.bot, open)).toBe(false);
  });
  it('lists the crystals left, nearest first, and the observation is only for the End', () => {
    const f = fixture();
    f.bot.entities[7] = { id: 7, name: 'end_crystal', position: new Vec3(30.5, 80, 0.5), metadata: [] };
    f.bot.entities[8] = { id: 8, name: 'end_crystal', position: new Vec3(10.5, 80, 0.5), metadata: [] };
    f.bot.entities[8].metadata[8] = { x: 0, y: 60, z: 0 };
    expect(crystalsOf(f.bot).map(crystal => crystal.id)).toEqual([8, 7]);
    expect(crystalsOf(f.bot)[0].healing).toBe(true);
    const seen = endObservation(f.bot)!;
    expect(seen.crystals.list.length).toBe(2); expect(seen.perch).toEqual({ x: 0.5, y: 68, z: 0.5 }); expect(seen.dragon).toMatchObject({ phase: 6, perched: true });
    // the head's names: a crystal has a position and a distance (nearest first), the cloud list is there and empty
    expect(seen.crystals.list[0]).toMatchObject({ id: 8, position: { x: 10.5, y: 80, z: 0.5 }, healing: true });
    expect(typeof seen.crystals.list[0].distance).toBe('number'); expect(seen.dragonBreath).toEqual([]); expect(seen.dragonFireballs).toBe(0);
    f.bot.game.dimension = 'minecraft:overworld';
    expect(endObservation(f.bot)).toBeNull();
  });
  it('finds the dragon\'s breath by its particle and ignores another cloud', () => {
    const f = fixture();
    const cloud = (id: number, particle: unknown, radius: number) => { const meta: unknown[] = []; meta[8] = radius; meta[10] = particle; return { id, name: 'area_effect_cloud', position: new Vec3(5, 64, 5), metadata: meta }; };
    f.bot.entities[20] = cloud(20, { type: 'dragon_breath' }, 5);
    f.bot.entities[21] = cloud(21, { type: 'entity_effect' }, 3);
    const found = breathCloudsOf(f.bot);
    expect(found.map(c => c.id)).toEqual([20]); expect(found[0].radius).toBe(5);
  });
  it('flies a fireball on at (s + 0.1) * 0.95 a tick and stops it at the first solid cell', () => {
    const f = fixture();
    const read = (x: number, y: number, z: number) => { const name = f.world.get(key(x, y, z)); return name ? { name, solid: true } : { name: 'air', solid: false }; };
    const ball = { id: 30, position: { x: 0.5, y: 70, z: 9.5 }, velocity: { x: 0, y: -0.2, z: -0.1 } };
    const path = fireballPath(read, ball, 40);
    expect(path.impact).not.toBeNull();
    expect(path.impact!.y).toBeLessThan(64.5);
    const slow = fireballPath(read, { ...ball, velocity: { x: 0, y: 0, z: -0.1 } }, 5);
    expect(slow.impact).toBeNull();
    expect(slow.points[0].z).toBeCloseTo(9.5 - 0.1, 5);
    expect(slow.points[1].z).toBeCloseTo(9.5 - 0.1 - (0.1 + 0.1) * 0.95, 5);
  });
  it('picks the head before the neck, and a wing only when it is the one in reach', () => {
    const f = fixture();
    const dragon = { position: f.dragon.position, yaw: 0 };
    expect(partToStrike(dragon, new Vec3(0.5, 65.6, 7))?.part).toBe('head');
    expect(boxDistance(new Vec3(0.5, 65.6, 7), partBox(dragon, 'head'))).toBeLessThan(3);
    expect(partToStrike(dragon, new Vec3(-6.0, 70.5, -1.0))?.part).toBe('body');
    expect(partToStrike(dragon, new Vec3(-9, 71, 0.5))?.part).toBe('wing1');
    expect(partToStrike(dragon, new Vec3(30, 70, 30))).toBeNull();
  });
});

describe('attack at the dragon', () => {
  const run = (f: ReturnType<typeof fixture>, seconds = 1.2) => attack(ctxOf(f.bot) as never, { target: 'ender_dragon', maxSeconds: seconds });
  it('strikes the head part (the body\'s id + 1) while the dragon sits, never the body entity, and counts the blows that hurt it', async () => {
    const f = fixture({ at: new Vec3(0.5, 64, 7.0) });
    f.bot.heldItem = { name: 'stick' };
    f.bot.attack.mockImplementation((target: any) => { if (target.id === 101) setTimeout(() => f.bot.emit('entityHurt', f.dragon), 20); });
    const outcome = await run(f);
    const hit = f.bot.attack.mock.calls.map((call: any[]) => call[0].id);
    expect(hit.length).toBeGreaterThanOrEqual(2);
    expect(new Set(hit)).toEqual(new Set([101]));
    expect(outcome.ok).toBe(false); expect(outcome.reason).toBe('time_up');
    expect(outcome.text).toMatch(/当たった/u);
    expect(outcome.progress).toMatchObject({ unit: 'blow' });
    expect((outcome.progress as { done: number }).done).toBeGreaterThanOrEqual(2);
  });
  it('never swings while the dragon flies, and says it was not on the perch', async () => {
    const f = fixture({ phase: DRAGON_PHASE.holdingPattern, at: new Vec3(0.5, 64, 7.0) });
    const outcome = await run(f, 0.5);
    expect(f.bot.attack).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, reason: 'not_perched' });
    expect(outcome.text).toMatch(/phase 0/u);
  });
  it('does not swing at a perched dragon out of reach, and says how far the head is', async () => {
    const f = fixture({ at: new Vec3(0.5, 64, 16) });
    const outcome = await run(f, 0.5);
    expect(f.bot.attack).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, reason: 'out_of_reach' });
    expect(outcome.text).toMatch(/頭の箱まで/u);
  });
  it('ends with the kill when the death is seen, and stops swinging once the dragon is dying', async () => {
    const f = fixture({ at: new Vec3(0.5, 64, 7.0) });
    f.bot.heldItem = { name: 'stick' };
    f.bot.attack.mockImplementation(() => {
      f.dragon.metadata[16] = DRAGON_PHASE.dying; f.dragon.metadata[9] = 0;
      setTimeout(() => f.bot.emit('entityDead', f.dragon), 150);
    });
    const outcome = await run(f, 3);
    expect(f.bot.attack).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(true); expect(outcome.text).toMatch(/倒した/u);
  });
  it('ends when the perch is over after blows, as a stop the planner reads', async () => {
    const f = fixture({ at: new Vec3(0.5, 64, 7.0) });
    f.bot.heldItem = { name: 'stick' };
    f.bot.attack.mockImplementation(() => { f.dragon.metadata[16] = DRAGON_PHASE.takeoff; });
    const outcome = await run(f, 3);
    expect(outcome).toMatchObject({ ok: false, reason: 'perch_over' });
    expect(outcome.text).toMatch(/止まり木が終わった/u);
  });
  it('refuses a dragon that is not loaded, by name and by the planner\'s #id of something else, leaving other creatures to the old path', async () => {
    const f = fixture();
    delete f.bot.entities[100];
    expect(await run(f, 0.3)).toMatchObject({ ok: false, reason: 'target_not_found' });
  });
});

import { cloudReaches, dragonHazards } from '../../src/services/minebot/utils/dragonDanger.js';
import { runDragonRetreat } from '../../src/services/minebot/utils/floorReflexes.js';

describe('the dragon\'s reach', () => {
  const cloudAt = (f: ReturnType<typeof fixture>, id: number, at: Vec3, radius: number) => {
    const meta: unknown[] = []; meta[8] = radius; meta[10] = { type: 'dragon_breath' };
    f.bot.entities[id] = { id, name: 'area_effect_cloud', position: at, metadata: meta };
  };
  it('treats a cloud as at least 7 blocks in radius, as a slab on the ground the body is clear of when above it or under it', () => {
    expect(cloudReaches({ x: 0, y: 64, z: 0 }, 3, { x: 6, y: 64, z: 0 })).toBe(true);
    expect(cloudReaches({ x: 0, y: 64, z: 0 }, 3, { x: 8, y: 64, z: 0 })).toBe(false);
    expect(cloudReaches({ x: 0, y: 64, z: 0 }, 3, { x: 0, y: 65, z: 0 })).toBe(false);
    expect(cloudReaches({ x: 0, y: 64, z: 0 }, 3, { x: 0, y: 61.5, z: 0 })).toBe(false);
    expect(cloudReaches({ x: 0, y: 64, z: 0 }, 3, { x: 8, y: 64, z: 0 }, 1.5)).toBe(true);
  });
  it('finds a breath cloud under the body and none once it stands clear', () => {
    const f = fixture({ phase: DRAGON_PHASE.holdingPattern, at: new Vec3(10.5, 64, 0.5) });
    cloudAt(f, 20, new Vec3(12, 64, 0), 3);
    expect(dragonHazards(f.bot).map(h => h.kind)).toEqual(['breath']);
    f.self.position = new Vec3(25.5, 64, 0.5);
    expect(dragonHazards(f.bot)).toEqual([]);
  });
  it('expects the flame past the head in phase 5 at once and in phase 7 only after a second and a quarter', () => {
    const f = fixture({ phase: DRAGON_PHASE.sittingFlaming, at: new Vec3(0.5, 64, 12.0) });
    expect(dragonHazards(f.bot, { now: 1000 }).map(h => h.kind)).toContain('flame');
    const g = fixture({ phase: DRAGON_PHASE.sittingAttacking, at: new Vec3(0.5, 64, 12.0) });
    expect(dragonHazards(g.bot, { now: 1000 }).map(h => h.kind)).not.toContain('flame');
    expect(dragonHazards(g.bot, { now: 3000 }).map(h => h.kind)).toContain('flame');
    const scanning = fixture({ phase: DRAGON_PHASE.sittingScanning, at: new Vec3(0.5, 64, 12.0) });
    expect(dragonHazards(scanning.bot, { now: 3000 })).toEqual([]);
  });
  it('lets the body stand on the ground under the head, and warns when it stands a block higher (inside the head\'s block)', () => {
    const ground = fixture({ phase: DRAGON_PHASE.sittingScanning, at: new Vec3(0.5, 64, 7.0) });
    expect(dragonHazards(ground.bot).map(h => h.kind)).toEqual([]);
    const raised = fixture({ phase: DRAGON_PHASE.sittingScanning, at: new Vec3(0.5, 65, 7.0) });
    expect(dragonHazards(raised.bot).map(h => h.kind)).toContain('head');
    const wing = fixture({ phase: DRAGON_PHASE.sittingScanning, at: new Vec3(-4.0, 65, 0.5) });
    expect(dragonHazards(wing.bot).map(h => h.kind)).toContain('wing');
  });
  it('draws no box round a dragon in flight', () => {
    const f = fixture({ phase: DRAGON_PHASE.holdingPattern, at: new Vec3(0.5, 65, 7.0) });
    expect(dragonHazards(f.bot)).toEqual([]);
  });
  it('sees a fireball coming within 7 blocks of its line, and not one passing wide', () => {
    const f = fixture({ phase: DRAGON_PHASE.holdingPattern, at: new Vec3(0.5, 64, 0.5) });
    f.bot.toldVelocities = new Map([[40, new Vec3(0, -0.15, -0.3)]]);
    f.bot.entities[40] = { id: 40, name: 'dragon_fireball', position: new Vec3(0.5, 72, 8.5), metadata: [] };
    expect(dragonHazards(f.bot).map(h => h.kind)).toEqual(['fireball']);
    f.bot.entities[40].position = new Vec3(30.5, 72, 8.5);
    expect(dragonHazards(f.bot)).toEqual([]);
  });
  it('runs out of a cloud without a jump, a sprint or a block, and stops once clear', async () => {
    const f = fixture({ phase: DRAGON_PHASE.holdingPattern, at: new Vec3(0.5, 64, 0.5) });
    cloudAt(f, 20, new Vec3(0.5, 64, 0.5), 3);
    const keys: Array<[string, boolean]> = [];
    let yaw = 0;
    f.bot.look = vi.fn((y: number) => { yaw = y; });
    f.bot.setControlState = vi.fn((k: string, v: boolean) => {
      keys.push([k, v]);
      if (k === 'forward' && v) f.self.position = f.self.position.plus(new Vec3(-Math.sin(yaw) * 0.6, 0, -Math.cos(yaw) * 0.6));
    });
    const done = await runDragonRetreat(f.bot, f.bot, 1);
    expect(done.ended).toBe('clear');
    expect(done.moved).toBeGreaterThan(7);
    expect(keys.filter(([k, v]) => k === 'sprint' && v)).toEqual([]);
    expect(keys.filter(([k, v]) => k === 'jump' && v)).toEqual([]);
    expect(keys.some(([k, v]) => k === 'forward' && v)).toBe(true);
    expect(keys.slice(-5).every(([, v]) => v === false)).toBe(true);
  });
});

import { use } from '../../src/services/minebot/utils/primitives/use.js';

describe('a bed used in the End', () => {
  /** The bot at (0.5, 64, 0.5), a bed at the cell (3, 64, 0) behind a wall of end stone at x 2 (so that the blast is mostly shut out), the dragon sitting. */
  function bedFixture(options: { wall?: boolean; dimension?: string; blows?: boolean } = {}) {
    const f = fixture({ at: new Vec3(0.5, 64, 3.5), phase: DRAGON_PHASE.sittingScanning });
    f.bot.game.dimension = options.dimension ?? 'minecraft:the_end';
    if (options.wall !== false) for (let y = 63; y <= 67; y++) for (let z = 0; z <= 7; z++) f.world.set(key(2, y, z), 'end_stone');
    f.world.set(key(3, 64, 3), 'white_bed'); f.world.set(key(3, 64, 4), 'white_bed');
    f.bot._client = new EventEmitter();
    f.bot.sleep = vi.fn(async () => { throw new Error("it's not night and it's not a thunderstorm"); });
    f.bot.activateBlock = vi.fn(async () => {
      if (options.blows === false) return;
      f.world.delete(key(3, 64, 3)); f.world.delete(key(3, 64, 4));
      f.bot.health = 17; f.dragon.metadata[9] = 150;
      f.bot._client.emit('explosion', { center: { x: 3.5, y: 64.5, z: 3.5 }, radius: 5 });
    });
    return f;
  }
  it('right-clicks the bed (never sleeps) when the planner uses it in the End, and says it blew, how far, and what it cost', async () => {
    const f = bedFixture();
    const outcome = await use(ctxOf(f.bot) as never, { at: { x: 3, y: 64, z: 3 } });
    expect(f.bot.activateBlock).toHaveBeenCalledTimes(1);
    expect(f.bot.sleep).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/爆発した/u); expect(outcome.text).toMatch(/自分まで 3(\.\d)?m/u); expect(outcome.text).toMatch(/失った体力 3/u); expect(outcome.text).toMatch(/体力 200→150/u);
    expect(outcome.data?.bed).toMatchObject({ exploded: true, damage: 3 });
  });
  it("refuses, with the numbers, a bed whose blast would take the body's health, and does not click", async () => {
    const f = bedFixture({ wall: false });
    const outcome = await use(ctxOf(f.bot) as never, { at: { x: 3, y: 64, z: 3 } });
    expect(f.bot.activateBlock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, reason: 'blast_unsafe' });
    expect(outcome.text).toMatch(/素の被害 \d+→防具後/u);
  });
  it('says it did not blow when the click did nothing', async () => {
    const f = bedFixture({ blows: false });
    const outcome = await use(ctxOf(f.bot) as never, { at: { x: 3, y: 64, z: 3 } });
    expect(outcome).toMatchObject({ ok: false, reason: 'not_exploded' });
  });
  it('leaves a bed in the Overworld to sleep, as before', async () => {
    const f = bedFixture({ dimension: 'minecraft:overworld' });
    const outcome = await use(ctxOf(f.bot) as never, { at: { x: 3, y: 64, z: 3 } });
    expect(f.bot.activateBlock).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });
});

import { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';

describe('the observation the body gives the head', () => {
  it('carries the End fields in state.world in the End only, under the names the head reads', async () => {
    const f = fixture({ at: new Vec3(0.5, 64, 7.0), phase: DRAGON_PHASE.sittingScanning, health: 120 });
    f.bot.entities[7] = { id: 7, name: 'end_crystal', position: new Vec3(30.5, 80, 0.5), metadata: [] };
    const meta: unknown[] = []; meta[8] = 3; meta[10] = { type: 'dragon_breath' };
    f.bot.entities[20] = { id: 20, name: 'area_effect_cloud', position: new Vec3(8.5, 64, 9.5), metadata: meta };
    Object.assign(f.bot, { oxygenLevel: 20, controlState: {}, instantSkills: { getSkills: () => [] }, clearControlStates: vi.fn(), look: vi.fn(async () => {}) });
    const body = new NativeCommonFcaBody(f.bot, { serverId: 'home', capture: async () => { throw Error('unused'); } });
    const world = (body.observe().state as any).world;
    expect(world).toMatchObject({ perch: { x: 0.5, y: 68, z: 0.5 }, crystals: { caged: 0 }, dragon: { id: 100, health: 120, phase: 6, phaseName: 'sitting_scanning', perched: true, strike: true }, dragonFireballs: 0 });
    expect(world.dragon.headPosition).toMatchObject({ z: 7 }); expect(world.dragon.position).toMatchObject({ x: 0.5 }); expect(typeof world.dragon.distance).toBe('number');
    expect(world.crystals.list[0]).toMatchObject({ id: 7, position: { x: 30.5, y: 80, z: 0.5 } }); expect(typeof world.crystals.list[0].distance).toBe('number');
    // a young cloud: its own radius, and the radius the body keeps clear of
    expect(world.dragonBreath).toEqual([{ x: 8.5, y: 64, z: 9.5, radius: 3, dangerRadius: 7 }]);
    expect((body.observe().state as any).end).toBeUndefined();
    f.bot.game.dimension = 'minecraft:overworld';
    const elsewhere = (body.observe().state as any).world;
    for (const key of ['dragon', 'crystals', 'perch', 'dragonBreath', 'dragonFireballs']) expect(elsewhere[key]).toBeUndefined();
    await body.dispose();
  });
});

import { installFloorReflexes } from '../../src/services/minebot/utils/floorReflexes.js';
import { floorConfig } from '../../src/services/minebot/utils/floorConfig.js';

describe('the floor reflex out of the dragon\'s reach', () => {
  const cloudAt = (f: ReturnType<typeof fixture>, at: Vec3) => { const meta: unknown[] = []; meta[8] = 3; meta[10] = { type: 'dragon_breath' }; f.bot.entities[20] = { id: 20, name: 'area_effect_cloud', position: at, metadata: meta }; };
  function armed(world?: World) {
    const f = fixture({ phase: DRAGON_PHASE.holdingPattern, at: new Vec3(0.5, 64, 12.5), world });
    cloudAt(f, new Vec3(0.5, 64, 12.5));
    const keys: Array<[string, boolean]> = [];
    let yaw = 0;
    f.bot.look = vi.fn((y: number) => { yaw = y; });
    f.bot.setControlState = vi.fn((k: string, v: boolean) => { keys.push([k, v]); if (k === 'forward' && v) f.self.position = f.self.position.plus(new Vec3(-Math.sin(yaw) * 0.6, 0, -Math.cos(yaw) * 0.6)); });
    f.bot.equip = vi.fn(async () => undefined); f.bot.consume = vi.fn(async () => undefined);
    installFloorReflexes(f.bot, floorConfig({ MINEBOT_FCA_REFLEXES: 'default' }), { fleeTickMs: 1 });
    return { f, keys };
  }
  it('starts one run out of a cloud under the body, with no jump, sprint or block, and tells it in the ledger as a retreat that stops an act', async () => {
    const { f, keys } = armed();
    f.bot.emit('physicsTick');
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(keys.some(([k, v]) => k === 'forward' && v)).toBe(true);
    expect(keys.filter(([k, v]) => (k === 'jump' || k === 'sprint') && v)).toEqual([]);
    const entries = f.bot.reflexLedger.entriesSince(0);
    expect(entries.some((entry: any) => entry.kind === 'retreat' && /竜の危険から.*離れた/u.test(entry.detail))).toBe(true);
    expect(Math.hypot(f.self.position.x - 0.5, f.self.position.z - 12.5)).toBeGreaterThan(7);
  });
  it('starts nothing, and says so as a fact that stops no act, when every way out is a drop', async () => {
    // A 3 x 3 slab in the void: the cloud is on it, and every heading goes off the edge.
    const world: World = new Map();
    for (let x = -1; x <= 1; x++) for (let z = 11; z <= 13; z++) world.set(key(x, 63, z), 'end_stone');
    const { f, keys } = armed(world);
    f.bot.emit('physicsTick');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(keys.some(([k, v]) => k === 'forward' && v)).toBe(false);
    const entries = f.bot.reflexLedger.entriesSince(0);
    expect(entries.some((entry: any) => entry.kind === 'cover_none' && /離れる安全な道が無い/u.test(entry.detail))).toBe(true);
    expect(entries.some((entry: any) => entry.kind === 'retreat')).toBe(false);
  });
  it('does nothing outside the End, and nothing for a body that is clear', async () => {
    const { f, keys } = armed();
    f.bot.game.dimension = 'minecraft:overworld';
    f.bot.emit('physicsTick'); await new Promise(resolve => setTimeout(resolve, 100));
    expect(keys).toEqual([]);
    f.bot.game.dimension = 'minecraft:the_end'; f.self.position = new Vec3(0.5, 64, 40.5);
    f.bot.emit('physicsTick'); await new Promise(resolve => setTimeout(resolve, 100));
    expect(keys).toEqual([]);
  });
});

import { shoot, arrowBlockedAt } from '../../src/services/minebot/utils/primitives/shoot.js';

describe('shoot at a crystal', () => {
  /** The bot at (0.5, 64, 0.5) with a bow and arrows in hand, a crystal at the given place in the air. */
  function bowFixture(crystalAt: Vec3) {
    const f = fixture({ at: new Vec3(0.5, 64, 0.5), phase: DRAGON_PHASE.holdingPattern });
    const bow = { name: 'bow', type: 800, count: 1 };
    Object.assign(f.bot, {
      heldItem: bow, quickBarSlot: 0, setQuickBarSlot: vi.fn(), look: vi.fn(async () => undefined),
      inventory: { items: () => [bow, { name: 'arrow', type: 801, count: 20 }], slots: [] },
    });
    f.bot.entities[300] = { id: 300, name: 'end_crystal', position: crystalAt, metadata: [], height: 2 };
    return f;
  }
  const ctx = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 60_000, facing: 'north' as const, base: { x: 0, y: 64, z: 0 } });
  it('refuses a crystal nearer than its blast reaches, before any draw', async () => {
    const f = bowFixture(new Vec3(8.5, 66, 0.5));
    const outcome = await shoot(ctx(f.bot) as never, { target: 300 });
    expect(outcome).toMatchObject({ ok: false, reason: 'too_close' });
    expect(f.bot.activateItem).not.toHaveBeenCalled();
  });
  it('refuses when the arrow\'s way meets a bar, naming it, and lets the shot go once the bar is gone', async () => {
    const f = bowFixture(new Vec3(30.5, 66, 0.5));
    for (let y = 64; y <= 69; y++) f.world.set(key(28, y, 0), 'iron_bars');
    const blocked = await shoot(ctx(f.bot) as never, { target: 300 });
    expect(blocked).toMatchObject({ ok: false, reason: 'line_blocked' });
    expect(blocked.text).toMatch(/iron_bars/u);
    expect(f.bot.activateItem).not.toHaveBeenCalled();
    expect(arrowBlockedAt(f.bot, new Vec3(0.5, 65.52, 0.5), -Math.PI / 2, 0.15, 3, 30, new Vec3(30.5, 67, 0.5))).not.toBeNull();
    for (let y = 64; y <= 69; y++) f.world.delete(key(28, y, 0));
    const open = await shoot(ctx(f.bot) as never, { target: 300 });
    expect(f.bot.activateItem).toHaveBeenCalled();
    expect(open.text).toMatch(/射った/u);
  }, 15_000);
  it('does not let go of a draw when the body was brought within the blast\'s reach meanwhile', async () => {
    const f = bowFixture(new Vec3(30.5, 66, 0.5));
    f.bot.activateItem = vi.fn(() => { setTimeout(() => { f.self.position = new Vec3(22.5, 64, 0.5); }, 400); });
    const outcome = await shoot(ctx(f.bot) as never, { target: 300 });
    expect(f.bot.deactivateItem).not.toHaveBeenCalled();
    expect(f.bot.setQuickBarSlot).toHaveBeenCalledTimes(2);
    expect(outcome.text).toMatch(/放さなかった/u);
  }, 15_000);
});
