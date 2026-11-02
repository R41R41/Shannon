import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

// The pillar hand is the last stand's (a jump and a block under the feet, timed to the tick); the dragon reflex only chooses it, so the test sees what it was asked.
vi.mock('../../src/services/minebot/utils/primitives/pillarUp.js', () => ({ pillarUp: vi.fn(async (_ctx: unknown, args: { n: number; block: string }) => ({ ok: true, text: `${args.n}段上がった（${args.block}）` })) }));

import { boxDistance, DRAGON_PHASE, isPerched, partBox, partDamage, partOffset, partTarget, flameCloudCentre } from '../../src/services/minebot/utils/dragonParts.js';
import { breathCloudsOf, crystalCaged, crystalsOf, crystalTellingReach, dragonView, endObservation, fireballPath, fountainOf, metaIndex, SPIKE_CENTRES, spikeStates } from '../../src/services/minebot/utils/dragonState.js';
import { attack } from '../../src/services/minebot/utils/primitives/attack.js';
import { pillarUp } from '../../src/services/minebot/utils/primitives/pillarUp.js';
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
    blockAt: (v: Vec3) => { const name = world.get(key(v.x, v.y, v.z)) ?? 'air'; return { name, boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], position: v }; },
    attack: vi.fn(), lookAt: vi.fn(async () => undefined), clearControlStates: vi.fn(), setControlState: vi.fn(), activateItem: vi.fn(), deactivateItem: vi.fn(),
    inventory: { items: () => [], slots: [] },
  });
  return { bot, dragon, self, world };
}
/** A ball at 45 degrees down toward -z, `ahead` blocks beyond the body in z and 6 up: it lands `ahead - 6` blocks beyond the body. */
const fireballAt = (f: ReturnType<typeof fixture>, id: number, ahead: number) => {
  f.bot.toldVelocities = new Map([[id, new Vec3(0, -0.25, -0.25)]]);
  f.bot.entities[id] = { id, name: 'dragon_fireball', position: new Vec3(0.5, 70, 0.5 + ahead), metadata: [] };
};
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
  it('calls a spike destroyed only when the body is near enough to have been told of a crystal on it, and keeps it so', () => {
    // The lab: a body 100 blocks from the ring saw the blocks of four spikes and none of their crystals, and four were counted destroyed that were not.
    const f = fixture({ at: new Vec3(SPIKE_CENTRES[0].x + 0.5 + 100, 64, SPIKE_CENTRES[0].z + 0.5) });
    for (const index of [0, 5]) f.world.set(key(SPIKE_CENTRES[index].x, 85, SPIKE_CENTRES[index].z), 'obsidian');
    let now = 1_000_000;
    const states = () => spikeStates(f.bot, now).map(spike => spike.state);
    expect(states()[0]).toBe('unknown'); expect(states()[5]).toBe('unknown');
    f.self.position = new Vec3(SPIKE_CENTRES[0].x + 0.5 + 20, 64, SPIKE_CENTRES[0].z + 0.5);
    // near, the column loaded and no crystal on it: not yet called destroyed (a chunk's entities come with it, but not in the same moment); after three seconds it is
    expect(states()[0]).toBe('unknown'); now += 2000; expect(states()[0]).toBe('unknown');
    now += 1500; expect(states()[0]).toBe('gone'); expect(states()[5]).toBe('unknown'); // the other pillar is loaded too, and too far
    f.self.position = new Vec3(SPIKE_CENTRES[0].x + 0.5 + 100, 64, SPIKE_CENTRES[0].z + 0.5);
    expect(states()[0]).toBe('gone'); // seen destroyed: it stays so when the body goes off
    expect(endObservation(f.bot, now)!.crystals).toMatchObject({ remaining: 9, gone: 1 });
    // a crystal seen there again (the dragon's respawn) clears it; gone from sight while the body is far, it is not called destroyed
    f.bot.entities[40] = { id: 40, name: 'end_crystal', position: new Vec3(SPIKE_CENTRES[0].x + 0.5, 86, SPIKE_CENTRES[0].z + 0.5), metadata: [] };
    expect(states()[0]).toBe('crystal');
    delete f.bot.entities[40];
    expect(states()[0]).toBe('unknown');
  });
  it('starts the three seconds again when the body goes out of the reach', () => {
    const f = fixture({ at: new Vec3(SPIKE_CENTRES[0].x + 0.5 + 20, 64, SPIKE_CENTRES[0].z + 0.5) });
    f.world.set(key(SPIKE_CENTRES[0].x, 85, SPIKE_CENTRES[0].z), 'obsidian');
    let now = 5_000_000;
    expect(spikeStates(f.bot, now)[0].state).toBe('unknown');
    now += 2500; f.self.position = new Vec3(SPIKE_CENTRES[0].x + 0.5 + 100, 64, SPIKE_CENTRES[0].z + 0.5);
    expect(spikeStates(f.bot, now)[0].state).toBe('unknown');
    now += 2500; f.self.position = new Vec3(SPIKE_CENTRES[0].x + 0.5 + 20, 64, SPIKE_CENTRES[0].z + 0.5);
    expect(spikeStates(f.bot, now)[0].state).toBe('unknown'); // out of reach in between: the count began again
    now += 3100; expect(spikeStates(f.bot, now)[0].state).toBe('gone');
  });
  it('tells how far a crystal is surely told of from the view distance the server gave', () => {
    expect(crystalTellingReach({ game: {} })).toBe(32);
    expect(crystalTellingReach({ game: { serverViewDistance: 6 } })).toBe(48);
    expect(crystalTellingReach({ game: { serverViewDistance: 10 } })).toBe(48);
    expect(crystalTellingReach({ game: { serverViewDistance: 3 } })).toBe(16);
    expect(crystalTellingReach(null)).toBe(32);
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
  it('runs from where a fireball lands when that is well off the body, and across its line when it falls on the body', () => {
    // lands 6 blocks off: the push comes from the landing
    const off = fixture({ phase: DRAGON_PHASE.holdingPattern, at: new Vec3(0.5, 64, 0.5) });
    fireballAt(off, 40, 12);
    const [away] = dragonHazards(off.bot);
    expect(away.kind).toBe('fireball');
    expect(Math.abs(away.centre.x - 0.5)).toBeLessThan(0.7); expect(away.centre.z).toBeGreaterThan(4); expect(away.centre.z).toBeLessThan(8);
    // falls on the body: the push comes from 7 blocks to one side of the line (the line runs along z), so that the flee is a sidestep
    const on = fixture({ phase: DRAGON_PHASE.holdingPattern, at: new Vec3(0.5, 64, 0.5) });
    fireballAt(on, 41, 6);
    const [across] = dragonHazards(on.bot);
    expect(across.kind).toBe('fireball');
    expect(Math.abs(across.centre.z - 0.5)).toBeLessThan(0.5); expect(Math.abs(Math.abs(across.centre.x - 0.5) - 7)).toBeLessThan(0.5);
  });
  it('keeps a fireball\'s landing as a breath to come for a moment after the ball is gone, and leaves it to the cloud once that is in sight', () => {
    const f = fixture({ phase: DRAGON_PHASE.holdingPattern, at: new Vec3(0.5, 64, 0.5) });
    fireballAt(f, 40, 6);
    expect(dragonHazards(f.bot, { now: 1000 }).map(h => h.kind)).toEqual(['fireball']);
    delete f.bot.entities[40]; // landed
    const gap = dragonHazards(f.bot, { now: 1250 });
    expect(gap.map(h => h.kind)).toEqual(['breath']); expect(gap[0].why).toContain('落ちた'); expect(gap[0].pending).toBe(true);
    expect(dragonHazards(f.bot, { now: 3000 })).toEqual([]);
    // the cloud comes into sight at the landing: only the cloud counts
    fireballAt(f, 42, 6);
    dragonHazards(f.bot, { now: 5000 });
    delete f.bot.entities[42];
    cloudAt(f, 20, new Vec3(0.5, 64, 0.5), 3);
    const later = dragonHazards(f.bot, { now: 5250 });
    expect(later.map(h => h.kind)).toEqual(['breath']); expect(later[0].why).toContain('竜の息の雲'); expect(later[0].pending).toBeUndefined();
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
  it('says what the bed did when the act, or a reflex, ends the hand just after the click', async () => {
    // Lab 2026-11-02: the blast's fire sent the lava escape a tenth of a second after, and the planner was told "reflex" and not that the bed had blown and what it cost.
    const f = bedFixture();
    const controller = new AbortController();
    const click = f.bot.activateBlock;
    f.bot.activateBlock = vi.fn(async (...args: unknown[]) => { await click(...args); setTimeout(() => controller.abort('lava_escape'), 10); });
    const cut = await use({ ...ctxOf(f.bot), stop: controller.signal } as never, { at: { x: 3, y: 64, z: 3 } }).then(() => null, (error: unknown) => error) as { constructor: { name: string }; why?: string; summary?: string } | null;
    expect(cut?.constructor.name).toBe('HandCut');
    expect(cut?.why).toBe('lava_escape');
    expect(cut?.summary).toMatch(/爆発した/u); expect(cut?.summary).toMatch(/失った体力 3/u); expect(cut?.summary).toMatch(/体力 200→150/u);
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

import { dragonFleePlan, FALL_CLUTCH_ENABLED, installFloorReflexes } from '../../src/services/minebot/utils/floorReflexes.js';
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
  /** Waits for a positive result (a rise is a task on the action queue: its start is not on a fixed clock under load), up to a few seconds. */
  const until = async (check: () => boolean, ms = 2500) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20)); };
  const risen = (n: number) => () => vi.mocked(pillarUp).mock.calls.length >= n;
  const platformWorld = (): World => { const world: World = new Map(); for (let x = -1; x <= 1; x++) for (let z = 11; z <= 13; z++) world.set(key(x, 63, z), 'end_stone'); return world; };
  const OBSIDIAN = { name: 'obsidian', type: 2, count: 3 }, COBBLE = { name: 'cobblestone', type: 1, count: 20 };
  it('rises one block above a cloud, on obsidian first, when no way out can be walked and a block is carried (the arrival platform of the End)', async () => {
    vi.mocked(pillarUp).mockClear();
    const { f, keys } = armed(platformWorld());
    f.bot.inventory = { items: () => [COBBLE, OBSIDIAN], slots: [] };
    f.bot.emit('physicsTick');
    await until(risen(1)); await new Promise(resolve => setTimeout(resolve, 150));
    expect(pillarUp).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pillarUp).mock.calls[0][1]).toEqual({ n: 1, block: 'obsidian' });
    expect(keys.some(([k, v]) => k === 'forward' && v)).toBe(false);
    const entries = f.bot.reflexLedger.entriesSince(0);
    expect(entries.some((entry: any) => entry.kind === 'retreat' && entry.outcome === 'done' && /obsidian を足元に積んだ/u.test(entry.detail))).toBe(true);
    // not again at once: the next look is a while off
    f.bot.emit('physicsTick'); await new Promise(resolve => setTimeout(resolve, 100));
    expect(pillarUp).toHaveBeenCalledTimes(1);
  });
  it('moves onto the cell that holds it first, when it stands over the front edge of a bridge (its feet cell has no floor), and then rises', async () => {
    vi.mocked(pillarUp).mockClear();
    const { f, keys } = armed(platformWorld());
    f.bot.inventory = { items: () => [OBSIDIAN], slots: [] };
    // the platform is x -1 to 1: the body's middle is over x 2, where nothing is under it, and the block behind it holds it
    f.self.position = new Vec3(2.05, 64, 12.5);
    f.bot.emit('physicsTick'); await until(risen(1)); await new Promise(resolve => setTimeout(resolve, 150));
    expect(keys.some(([k, v]) => k === 'forward' && v)).toBe(true);
    expect(f.self.position.x).toBeLessThan(2);
    expect(pillarUp).toHaveBeenCalledTimes(1);
    expect(keys.filter(([k, v]) => k === 'forward' && v).length).toBeLessThan(5);
  });
  it('does not rise for a fireball in the air (its cloud is put on the body at its height), looks again at the next tick, and rises once the ball has landed and its cloud is not yet in sight', async () => {
    vi.mocked(pillarUp).mockClear();
    const { f } = armed(platformWorld());
    delete f.bot.entities[20];
    fireballAt(f, 41, 18); // the body stands 12 blocks out on z: the ball lands on it
    f.bot.inventory = { items: () => [OBSIDIAN], slots: [] };
    f.bot.emit('physicsTick'); await new Promise(resolve => setTimeout(resolve, 200));
    expect(pillarUp).not.toHaveBeenCalled();
    expect(f.bot.reflexLedger.entriesSince(0).some((entry: any) => entry.kind === 'cover_none')).toBe(true);
    delete f.bot.entities[41]; // landed, its cloud not yet in sight: the next look is not the 1.5 s of a blocked one
    f.bot.emit('physicsTick'); await until(risen(1));
    expect(pillarUp).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pillarUp).mock.calls[0][1]).toEqual({ n: 1, block: 'obsidian' });
  });
  it('says what to try when a cloud lies and there is no block to put under the feet', async () => {
    vi.mocked(pillarUp).mockClear();
    const { f } = armed(platformWorld());
    f.bot.inventory = { items: () => [], slots: [] };
    f.bot.emit('physicsTick'); await new Promise(resolve => setTimeout(resolve, 200));
    expect(pillarUp).not.toHaveBeenCalled();
    expect(f.bot.reflexLedger.entriesSince(0).some((entry: any) => entry.kind === 'cover_none' && /積めるブロックが無い。次: 黒曜石か丸石/u.test(entry.detail))).toBe(true);
  });
  it('rises again for the cloud laid at the new height, after a moment, and no more than three times in twenty seconds', async () => {
    vi.mocked(pillarUp).mockClear();
    const { f } = armed(platformWorld());
    f.bot.inventory = { items: () => [OBSIDIAN], slots: [] };
    f.bot.emit('physicsTick'); await until(risen(1));
    expect(pillarUp).toHaveBeenCalledTimes(1);
    f.bot.floorReflexes.dragonNextAt = 0;
    f.bot.emit('physicsTick'); await new Promise(resolve => setTimeout(resolve, 100));
    expect(pillarUp).toHaveBeenCalledTimes(1); // the cloud still lies under the body, but not again at once
    await new Promise(resolve => setTimeout(resolve, 1200));
    f.bot.floorReflexes.dragonNextAt = 0;
    f.bot.emit('physicsTick'); await until(risen(2));
    expect(pillarUp).toHaveBeenCalledTimes(2);
    const at = Date.now();
    f.bot.floorReflexes.dragonRises = [at - 15_000, at - 9_000, at - 3_000];
    f.bot.floorReflexes.dragonNextAt = 0;
    f.bot.emit('physicsTick'); await new Promise(resolve => setTimeout(resolve, 200));
    expect(pillarUp).toHaveBeenCalledTimes(2); // three within the twenty seconds: enough
  });
  it('does not rise where the head or neck of the dragon is what reaches the body (a block under the feet takes it into the head box)', async () => {
    vi.mocked(pillarUp).mockClear();
    const world = platformWorld(); for (let x = -1; x <= 1; x++) for (let z = 6; z <= 8; z++) world.set(key(x, 63, z), 'end_stone');
    const f = fixture({ phase: DRAGON_PHASE.sittingScanning, at: new Vec3(0.5, 65, 7.0), world });
    cloudAt(f, new Vec3(0.5, 64, 7.0));
    expect(dragonHazards(f.bot).map(h => h.kind)).toContain('head');
    f.bot.look = vi.fn(); f.bot.setControlState = vi.fn(); f.bot.equip = vi.fn(async () => undefined); f.bot.consume = vi.fn(async () => undefined);
    f.bot.inventory = { items: () => [OBSIDIAN], slots: [] };
    installFloorReflexes(f.bot, floorConfig({ MINEBOT_FCA_REFLEXES: 'default' }), { fleeTickMs: 1 });
    f.bot.emit('physicsTick');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(pillarUp).not.toHaveBeenCalled();
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

describe('a fireball that lands on a body at the front end of a bridge one wide (lab r18, 2026-11-03: half the balls left "no safe way", the body took three clouds and fell off)', () => {
  /** A bridge one wide along x at z 12 (y 63), its front end at x 0 and nothing beyond it, the platform at its other end; the body at the front end, the dragon in flight. */
  function atFrontEnd(at = 0.5) {
    const world: World = new Map();
    for (let x = 0; x <= 14; x++) world.set(key(x, 63, 12), 'cobblestone');
    for (let x = 15; x <= 19; x++) for (let z = 10; z <= 14; z++) world.set(key(x, 63, z), 'obsidian');
    const f = fixture({ phase: DRAGON_PHASE.holdingPattern, at: new Vec3(at, 64, 12.5), world });
    f.dragon.position = new Vec3(0.5, 90, -40.5);
    return f;
  }
  /** A ball that comes down on the body, travelling along z (toward +z or -z): the side of its sidestep is decided by the way it travels. */
  const ballOnBody = (f: ReturnType<typeof fixture>, direction: 1 | -1) => {
    f.bot.toldVelocities = new Map([[41, new Vec3(0, -0.25, 0.25 * direction)]]);
    f.bot.entities[41] = { id: 41, name: 'dragon_fireball', position: new Vec3(f.self.position.x, 70, 12.5 - 6 * direction), metadata: [] };
  };
  for (const direction of [1, -1] as const) {
    it(`finds the way along the bridge, away from the front end, for a ball travelling ${direction > 0 ? '+z' : '-z'}`, () => {
      const f = atFrontEnd();
      ballOnBody(f, direction);
      const hazards = dragonHazards(f.bot);
      expect(hazards.map(hazard => hazard.kind)).toEqual(['fireball']);
      expect(hazards[0].alternative).toBeDefined();
      const plan = dragonFleePlan(f.bot, hazards);
      expect(plan).not.toBeNull();
      expect(-Math.sin(plan!.yaw)).toBeGreaterThan(0.9); // east: along the bridge, toward the platform
      expect(plan!.jump).toBe(false);
    });
  }
  it('starts the retreat along the bridge (the floor reflex), not a note that there is no way, whichever way the ball travels', async () => {
    for (const direction of [1, -1] as const) {
      const f = atFrontEnd();
      ballOnBody(f, direction);
      const keys: Array<[string, boolean]> = [];
      f.bot.look = vi.fn(); f.bot.setControlState = vi.fn((k: string, v: boolean) => { keys.push([k, v]); }); f.bot.equip = vi.fn(async () => undefined); f.bot.consume = vi.fn(async () => undefined);
      installFloorReflexes(f.bot, floorConfig({ MINEBOT_FCA_REFLEXES: 'default' }), { fleeTickMs: 1 });
      f.bot.emit('physicsTick');
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(keys.some(([k, v]) => k === 'forward' && v)).toBe(true);
      const entries = f.bot.reflexLedger.entriesSince(0);
      expect(entries.some((entry: any) => entry.kind === 'cover_none')).toBe(false);
      expect(entries.some((entry: any) => entry.kind === 'retreat')).toBe(true);
    }
  });
  it('still reports no way where there is none on either side (a bridge one cell long)', () => {
    const f = atFrontEnd();
    for (let x = 1; x <= 14; x++) f.world.delete(key(x, 63, 12)); // one block of bridge, the void all round it
    ballOnBody(f, 1);
    expect(dragonFleePlan(f.bot, dragonHazards(f.bot))).toBeNull();
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

import { clutchWanted, runFallClutch, scoopBack, scoopWanted, CLUTCH_REACH, SCOOP_BUCKET_WAIT_MS, SCOOP_GAP_MS, SCOOP_NEAR, SCOOP_PENDING_MS, SCOOP_PENDING_TRIES, type FallMemory } from '../../src/services/minebot/utils/fallClutch.js';
import { createMotorPort, dropReservation, executeAction, hasActiveSafetyLease, preemptLowerPriorityActions, reserveHandover } from '../../src/services/minebot/execution/ActionExecution.js';

describe('the water-bucket clutch of a fall in the End', () => {
  /** In the second slot of the hotbar (slot 37 of the window). */
  const BUCKET = { name: 'water_bucket', type: 5, count: 1, slot: 37 };
  const until = async (check: () => boolean, ms = 2500) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20)); };
  /** A body over a floor of end stone (its top at y 64), in the End, in the air and falling. */
  function falling(options: { y?: number; vy?: number; items?: any[]; floor?: string | null; dimension?: string } = {}) {
    const world: World = new Map();
    if (options.floor !== null) for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) world.set(key(x, 63, z), options.floor ?? 'end_stone');
    const f = fixture({ phase: DRAGON_PHASE.holdingPattern, at: new Vec3(0.5, options.y ?? 100, 0.5), world });
    f.self.onGround = false; f.self.velocity = new Vec3(0, options.vy ?? -1.6, 0);
    f.bot.inventory = { items: () => options.items ?? [BUCKET], slots: [] };
    if (options.dimension) f.bot.game.dimension = options.dimension;
    return f;
  }
  /**
   * The body comes down half a block every 15 ms to the floor, as a falling body does tick by tick; the bucket pours water into the cell over the floor, and takes it up again. The hotbar is a sword (slot 36)
   * and the bucket (slot 37), the hand the sword: the bucket comes into the hand by selecting its slot (the game's `equip`, which is clicks of the window over several ticks, must stay unused).
   */
  function withBucket(f: ReturnType<typeof falling>, selected = 0) {
    const { bot, self, world } = f;
    const seen = { uses: 0, rotations: [] as number[], pourY: Number.NaN };
    const hotbar: any[] = [{ name: 'diamond_sword', slot: 36 }, { name: 'water_bucket', slot: 37 }];
    bot.inventory = { items: () => [...hotbar], slots: [] };
    bot.heldItem = hotbar[selected];
    bot.quickBarSlot = selected;
    bot._client = { write: vi.fn((name: string, data: any) => { if (name === 'use_item') seen.rotations.push(data.rotation.y); }) };
    bot.look = vi.fn((_yaw: number, pitch: number) => { self.pitch = pitch; });
    bot.equip = vi.fn(async () => undefined);
    bot.setQuickBarSlot = vi.fn((slot: number) => { selected = slot; bot.quickBarSlot = slot; bot.heldItem = hotbar[selected]; });
    bot.activateItem = vi.fn(() => {
      bot._client.write('use_item', { rotation: { x: 0, y: 0 } });
      seen.uses++;
      const item = hotbar[selected];
      if (item.name === 'water_bucket') { if (Number.isNaN(seen.pourY)) seen.pourY = self.position.y; hotbar[selected] = { name: 'bucket', slot: 36 + selected }; world.set(key(0, 64, 0), 'water'); }
      else if (item.name === 'bucket') { hotbar[selected] = { name: 'water_bucket', slot: 36 + selected }; world.delete(key(0, 64, 0)); }
      bot.heldItem = hotbar[selected];
    });
    const timer = setInterval(() => { if (self.position.y > 64) self.position.y = Math.max(64, self.position.y - 0.5); else { self.onGround = true; self.velocity = new Vec3(0, 0, 0); } }, 15);
    return { seen, hotbar, stop: () => clearInterval(timer) };
  }
  it('starts for a long fall over a floor with a bucket of water, and says how far and how much', () => {
    expect(clutchWanted(falling().bot, {}, 1000)).toMatch(/落ちて36ブロック（地面まであと36、受ける被害およそ33）/u);
  });
  it('does not start for a short fall, a slow one, one with no bucket, one into water or the void, one outside the End, or twice within a few seconds', () => {
    expect(clutchWanted(falling({ y: 70 }).bot, {}, 1000)).toBeNull(); // 6 blocks: 3 of damage
    expect(clutchWanted(falling({ vy: -0.4 }).bot, {}, 1000)).toBeNull();
    expect(clutchWanted(falling({ items: [] }).bot, {}, 1000)).toBeNull();
    expect(clutchWanted(falling({ floor: 'water' }).bot, {}, 1000)).toBeNull();
    expect(clutchWanted(falling({ floor: null }).bot, {}, 1000)).toBeNull();
    expect(clutchWanted(falling({ dimension: 'minecraft:overworld' }).bot, {}, 1000)).toBeNull();
    const f = falling(), memory: FallMemory = {};
    expect(clutchWanted(f.bot, memory, 1000)).not.toBeNull();
    memory.clutchAt = 1000;
    expect(clutchWanted(f.bot, memory, 3000)).toBeNull();
    expect(clutchWanted(f.bot, memory, 8000)).not.toBeNull();
  });
  it('counts what the body has already fallen: a body that stood on a pillar and has fallen most of the way still has the whole fall to pay for', () => {
    const f = falling({ y: 80 }), memory: FallMemory = { from: 100 };
    expect(clutchWanted(f.bot, memory, 1000)).toMatch(/落ちて36ブロック（地面まであと16、/u);
  });
  it('starts only for a bucket that is in the hand or in the hotbar: one in the pack would be brought over by clicks of the window that a stronger reflex cannot stop (round 6 of the independent review)', async () => {
    const pack = { ...BUCKET, slot: 20 };
    expect(clutchWanted(falling({ items: [pack] }).bot, {}, 1000)).toBeNull();
    expect(clutchWanted(falling({ items: [{ ...BUCKET, slot: undefined }] }).bot, {}, 1000)).toBeNull(); // a stack that does not say where it is
    const f = falling({ items: [pack] });
    expect(await runFallClutch(f.bot, f.bot)).toMatchObject({ success: false });
    expect(f.bot.activateItem).not.toHaveBeenCalled();
    expect(clutchWanted(falling({ items: [{ ...BUCKET, slot: 36 }] }).bot, {}, 1000)).not.toBeNull();
    expect(clutchWanted(falling({ items: [{ ...BUCKET, slot: 44 }] }).bot, {}, 1000)).not.toBeNull();
    const inHand = falling({ items: [] }); inHand.bot.heldItem = { name: 'water_bucket' };
    expect(clutchWanted(inHand.bot, {}, 1000)).not.toBeNull();
  });
  it('pours in the tick the ground comes within reach, along a look straight down, and takes the water up again', async () => {
    const f = falling({ y: 80, vy: -2 });
    const { seen, stop } = withBucket(f);
    try {
      const result = await runFallClutch(f.bot, f.bot);
      expect(result).toMatchObject({ success: true });
      expect(result.result).toMatch(/落下を止めた.*汲み直した/u);
    } finally { stop(); }
    // the bucket came into the hand by its hotbar slot (one packet), not by the game's equip (clicks of the window over several ticks) ...
    expect(f.bot.setQuickBarSlot).toHaveBeenCalledWith(1);
    expect(f.bot.equip).not.toHaveBeenCalled();
    // ... and the hand was given back when it ended (round 8: an attack at the dragon strikes with what the hand holds): the sword's slot, the bucket full again in its own
    expect(f.bot.setQuickBarSlot.mock.calls.map((call: number[]) => call[0])).toEqual([1, 0]);
    expect(f.bot.heldItem.name).toBe('diamond_sword');
    expect(f.bot.look).toHaveBeenCalledWith(expect.any(Number), -Math.PI / 2, true);
    expect(seen.rotations[0]).toBeCloseTo(90, 3); // the packet carries the downward look, not the library's level one
    expect(seen.pourY + 1.62 - 64).toBeLessThanOrEqual(CLUTCH_REACH);
    expect(seen.pourY + 1.62 - 64).toBeGreaterThan(CLUTCH_REACH - 0.6);
    expect(seen.uses).toBe(2);
  });
  it('lets go of the body at once when a stronger reflex takes it, and sends nothing after (round 5 of the independent review: it waited on, holding the lease, and poured through the bare bot)', async () => {
    const f = falling({ y: 100, vy: -2 }); // the body stays in the air: the ground never comes within reach, so the clutch would poll for its whole four seconds
    const { seen, stop } = withBucket(f);
    try {
      const started = Date.now();
      const running = executeAction(f.bot, 'floor-clutch', 8000, (() => runFallClutch(f.bot, createMotorPort(f.bot))) as never, { priority: 380, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true });
      await new Promise(resolve => setTimeout(resolve, 150));
      preemptLowerPriorityActions(f.bot, 500, 'wall-escape');
      await running;
      expect(Date.now() - started).toBeLessThan(1500);
      expect(seen.uses).toBe(0);
      // the body goes on falling past the height at which the pour would have been made: nothing is poured
      await new Promise(resolve => setTimeout(resolve, 1500));
      expect(seen.uses).toBe(0);
    } finally { stop(); }
  });
  it.skipIf(!FALL_CLUTCH_ENABLED)('is started by the floor reflex in the tick the fall is worth it, over the rest, and told in the ledger', async () => {
    const f = falling({ y: 80, vy: -2 });
    const { stop } = withBucket(f);
    f.bot.setControlState = vi.fn(); f.bot.consume = vi.fn(async () => undefined);
    installFloorReflexes(f.bot, floorConfig({ MINEBOT_FCA_REFLEXES: 'default' }), { fleeTickMs: 1 });
    try {
      f.bot.emit('physicsTick');
      await until(() => f.bot.reflexLedger.entriesSince(0).some((entry: any) => entry.kind === 'retreat' && entry.outcome === 'done'), 4000);
      const entries = f.bot.reflexLedger.entriesSince(0);
      expect(entries.some((entry: any) => entry.kind === 'retreat' && entry.outcome === 'done' && /落下を水バケツで止めた/u.test(entry.detail))).toBe(true);
    } finally { stop(); }
  });

  it('sends nothing, selects nothing and clicks nothing when the body is taken before the bucket is brought to the hand (round 6: the game\'s equip went on with two window clicks and held the wall escape back half a second)', async () => {
    const f = falling({ y: 100, vy: -2 });
    const { seen, stop } = withBucket(f);
    try {
      const result = await executeAction(f.bot, 'floor-clutch', 8000, (() => { preemptLowerPriorityActions(f.bot, 500, 'wall-escape'); return runFallClutch(f.bot, createMotorPort(f.bot)); }) as never, { priority: 380, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true });
      expect(result).toMatchObject({ success: false, failureType: 'interrupted' });
      expect(f.bot.setQuickBarSlot).not.toHaveBeenCalled();
      expect(f.bot.equip).not.toHaveBeenCalled();
      expect(seen.uses).toBe(0);
    } finally { stop(); }
  });

  describe('the water a clutch leaves behind when a stronger reflex takes the body after the pour (round 6: an empty bucket and a source of water with no one to take it up, and no clutch for the next fall)', () => {
    /**
     * A body that stands where a clutch poured water and was cut off before it took it up: the empty bucket in the hand (it took it from the sword's slot 0, in the note), the source at (0, 64, 0), the dragon far off.
     * `hand` is what the note says the hand was on before the clutch (none: the bucket was in the hand already).
     */
    function afterCutOff(hand: number | undefined = 0) {
      const f = falling({ y: 64 });
      f.self.onGround = true; f.self.velocity = new Vec3(0, 0, 0);
      f.dragon.position = new Vec3(0.5, 90, 60.5);
      const kit = withBucket(f, 1);
      kit.hotbar[1] = { name: 'bucket', slot: 37 }; f.bot.heldItem = kit.hotbar[1];
      f.world.set(key(0, 64, 0), 'water');
      f.bot.setControlState = vi.fn(); f.bot.consume = vi.fn(async () => undefined);
      installFloorReflexes(f.bot, floorConfig({ MINEBOT_FCA_REFLEXES: 'default' }), { fleeTickMs: 1 });
      const memory: FallMemory = f.bot.floorReflexes.fall = { scoop: { x: 0, y: 64, z: 0, at: Date.now(), tries: 0, ...(hand !== undefined ? { hand } : {}) } };
      return { ...f, ...kit, memory };
    }
    it.skipIf(!FALL_CLUTCH_ENABLED)('leaves the note in the floor\'s memory at the pour, tells the cut in the ledger, and has the floor take the water up once the body stands, so that the next fall has its clutch', async () => {
      const f = falling({ y: 80, vy: -2 });
      f.dragon.position = new Vec3(0.5, 90, 60.5);
      const kit = withBucket(f);
      f.bot.setControlState = vi.fn(); f.bot.consume = vi.fn(async () => undefined);
      // a stronger reflex takes the body in the very moment after the pour, before the water is taken up (not on a clock: a loaded machine would let the clutch finish first)
      const use = f.bot.activateItem;
      f.bot.activateItem = vi.fn((...args: unknown[]) => { const done = use(...args); if (kit.seen.uses === 1) queueMicrotask(() => preemptLowerPriorityActions(f.bot, 500, 'wall-escape')); return done; });
      installFloorReflexes(f.bot, floorConfig({ MINEBOT_FCA_REFLEXES: 'default' }), { fleeTickMs: 1 });
      try {
        f.bot.emit('physicsTick'); // the clutch begins, pours, and is taken from
        await until(() => kit.seen.uses === 1, 4000);
        await until(() => f.self.onGround === true && !hasActiveSafetyLease(f.bot), 4000);
        const memory: FallMemory = f.bot.floorReflexes.fall;
        expect(memory.scoop).toMatchObject({ x: 0, y: 64, z: 0, tries: 0, hand: 0 }); // the note says the hand the bucket was taken from
        expect(kit.seen.uses).toBe(1);
        expect(kit.hotbar[1].name).toBe('bucket'); // the only bucket of water is empty: left so, the next fall has no clutch
        expect(f.bot.heldItem.name).toBe('bucket'); // and the clutch that was cut off left it in the hand
        await until(() => { f.bot.emit('physicsTick'); return kit.seen.uses === 2; }, 4000);
        expect(kit.hotbar[1].name).toBe('water_bucket');
        expect(memory.scoop).toBeUndefined();
        await until(() => f.bot.heldItem.name === 'diamond_sword', 2000); // the taking-up gave the hand back to where the clutch took the bucket from
        expect(f.bot.heldItem.name).toBe('diamond_sword');
        const entries = f.bot.reflexLedger.entriesSince(0);
        expect(entries.some((entry: any) => entry.kind === 'retreat' && entry.outcome === 'cut' && /落下を水バケツで止める途中で操作を取られた（水はあけた：あとで汲み直す）/u.test(entry.detail))).toBe(true);
        // the next fall
        f.self.onGround = false; f.self.position = new Vec3(0.5, 100, 0.5); f.self.velocity = new Vec3(0, -1.6, 0);
        expect(clutchWanted(f.bot, {}, Date.now() + 10_000)).not.toBeNull();
      } finally { kit.stop(); }
    });
    it('takes the water up in a quiet moment with a hold that has no safety lease, the empty bucket in the hand', async () => {
      const s = afterCutOff();
      const leases: boolean[] = [];
      const use = s.bot.activateItem;
      s.bot.activateItem = vi.fn((...args: unknown[]) => { leases.push(hasActiveSafetyLease(s.bot)); return use(...args); });
      try {
        await until(() => { s.bot.emit('physicsTick'); return s.seen.uses === 1; }, 4000);
        expect(s.seen.uses).toBe(1);
        expect(s.hotbar[1].name).toBe('water_bucket');
        expect(s.memory.scoop).toBeUndefined();
        expect(leases).toEqual([false]); // every reflex may cut it: the dragon's retreat waits for no lease of its
        expect(s.bot.equip).not.toHaveBeenCalled();
        // the empty bucket was in the hand (the clutch left it there): the hand goes back to where the clutch took the bucket from
        expect(s.bot.setQuickBarSlot.mock.calls.map((call: number[]) => call[0])).toEqual([0]);
        expect(s.bot.heldItem.name).toBe('diamond_sword');
      } finally { s.stop(); }
    });
    it('does not take the water up while an action runs, a hazard of the dragon is on the body or a handover is reserved, and does once the moment is quiet', async () => {
      const s = afterCutOff();
      try {
        const act = executeAction(s.bot, 'some-act', 2000, (async () => { await new Promise(resolve => setTimeout(resolve, 400)); return { success: true, result: 'done' }; }) as never, { legacyExecutingSkill: true });
        await new Promise(resolve => setTimeout(resolve, 30)); // the action has the body (a tick is a task of its own: it never falls between the call and the lock)
        s.bot.emit('physicsTick'); await new Promise(resolve => setTimeout(resolve, 100));
        expect(s.seen.uses).toBe(0); expect(s.memory.scoop?.tries).toBe(0);
        await act;
        // a cloud of breath on the body, and the dragon reflex not due to look yet: the taking-up looks for itself
        const meta: unknown[] = []; meta[8] = 3; meta[10] = { type: 'dragon_breath' };
        s.bot.entities[20] = { id: 20, name: 'area_effect_cloud', position: new Vec3(0.5, 64, 0.5), metadata: meta };
        s.bot.floorReflexes.dragonNextAt = Date.now() + 60_000;
        s.bot.emit('physicsTick'); await new Promise(resolve => setTimeout(resolve, 100));
        expect(s.seen.uses).toBe(0); expect(s.memory.scoop?.tries).toBe(0);
        delete s.bot.entities[20];
        // a handover reserved for the act that is to come: taking the body for the water would drop it
        reserveHandover(s.bot, { fromActionId: 'x', reflex: 'floor-melee', target: 7, life: 1, forCommand: 'attack-nearest', shield: false });
        s.bot.emit('physicsTick'); await new Promise(resolve => setTimeout(resolve, 100));
        expect(s.seen.uses).toBe(0); expect(s.memory.scoop?.tries).toBe(0);
        dropReservation(s.bot);
        await until(() => { s.bot.emit('physicsTick'); return s.seen.uses === 1; }, 4000);
        expect(s.seen.uses).toBe(1);
        expect(s.hotbar[1].name).toBe('water_bucket');
      } finally { s.stop(); }
    });
    it('brings the empty bucket to the hand by its hotbar slot when something else is held (never by the game\'s equip), and drops a note that cannot be kept, a bucket only in the pack among them', async () => {
      const s = afterCutOff();
      try {
        s.bot.setQuickBarSlot(0); s.bot.setQuickBarSlot.mockClear(); // the sword is in the hand
        expect(await scoopBack(s.bot, s.bot, s.memory)).toMatchObject({ success: true, scooped: true });
        expect(s.bot.setQuickBarSlot.mock.calls.map((call: number[]) => call[0])).toEqual([1, 0]); // the bucket's slot, and the sword's again
        expect(s.bot.equip).not.toHaveBeenCalled();
        expect(s.hotbar[1].name).toBe('water_bucket');
        expect(s.memory.scoop).toBeUndefined();
        expect(s.bot.heldItem.name).toBe('diamond_sword');
      } finally { s.stop(); }
      const gone = afterCutOff(); // the source is gone
      try {
        gone.world.delete(key(0, 64, 0));
        expect(await scoopBack(gone.bot, gone.bot, gone.memory)).toMatchObject({ success: true, scooped: false });
        expect(gone.memory.scoop).toBeUndefined();
      } finally { gone.stop(); }
      const pack = afterCutOff(); // the empty bucket is in the pack, the sword in the hand
      try {
        pack.hotbar[1] = { name: 'bucket', slot: 20 }; pack.bot.setQuickBarSlot(0); pack.bot.setQuickBarSlot.mockClear();
        expect(await scoopBack(pack.bot, pack.bot, pack.memory)).toMatchObject({ success: false, scooped: false });
        expect(pack.bot.setQuickBarSlot).not.toHaveBeenCalled();
        expect(pack.bot.activateItem).not.toHaveBeenCalled();
        expect(pack.memory.scoop).toBeUndefined();
      } finally { pack.stop(); }
    });
    it('keeps the note when the taking-up did not take', async () => {
      const s = afterCutOff();
      try {
        s.bot.activateItem = vi.fn(); // the use does nothing
        expect(await scoopBack(s.bot, s.bot, s.memory)).toMatchObject({ success: false, scooped: false });
        expect(s.memory.scoop).toBeDefined();
      } finally { s.stop(); }
    }, 10_000);
    it('gives the hand back to the one a later reflex chose, not to the note\'s, and leaves it alone when the taking-up is cut off (round 8: the bucket stayed in the hand and the next attack struck with it)', async () => {
      const s = afterCutOff();
      try {
        s.hotbar[2] = { name: 'diamond_pickaxe', slot: 38 };
        s.bot.setQuickBarSlot(2); s.bot.setQuickBarSlot.mockClear(); // a reflex that took the body after the cut chose the pickaxe
        expect(await scoopBack(s.bot, s.bot, s.memory)).toMatchObject({ success: true, scooped: true });
        expect(s.bot.setQuickBarSlot.mock.calls.map((call: number[]) => call[0])).toEqual([1, 2]);
        expect(s.bot.heldItem.name).toBe('diamond_pickaxe');
      } finally { s.stop(); }
      const cut = afterCutOff();
      try {
        cut.bot.setQuickBarSlot(0); cut.bot.setQuickBarSlot.mockClear(); // the sword in the hand, and a stronger reflex takes the body during the look at the water
        cut.bot.lookAt = vi.fn(async () => { preemptLowerPriorityActions(cut.bot, 500, 'wall-escape'); });
        const result = await executeAction(cut.bot, 'floor-scoop', 3000, (() => scoopBack(cut.bot, createMotorPort(cut.bot), cut.memory)) as never, { priority: 100, safetyLease: false, waitForQuiescence: false, legacyExecutingSkill: true });
        expect(result).toMatchObject({ success: false, failureType: 'interrupted' });
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(cut.seen.uses).toBe(0);
        expect(cut.bot.setQuickBarSlot.mock.calls.map((call: number[]) => call[0])).toEqual([1]); // the bucket's slot was taken; nothing after the cut (the hand is the reflex's)
        expect(cut.memory.scoop).toBeDefined();
      } finally { cut.stop(); }
    });
    it('takes the water only where the body would stand without it (round 8: a body held up by a waterfall over a drop was dropped by the taking-up)', async () => {
      const s = afterCutOff();
      try {
        // swimming in a column of water, the floor far under it: not wanted, the note kept; and a taking-up that is asked for does not select, use or move anything
        for (const y of [65, 66]) s.world.set(key(0, y, 0), 'water');
        s.self.position = new Vec3(0.5, 66.2, 0.5); s.self.onGround = false; s.self.isInWater = true;
        expect(scoopWanted(s.bot, s.memory, Date.now())).toBe(false);
        expect(s.memory.scoop).toBeDefined();
        s.bot.setQuickBarSlot(0); s.bot.setQuickBarSlot.mockClear();
        expect(await scoopBack(s.bot, s.bot, s.memory)).toMatchObject({ success: false, scooped: false });
        expect(s.bot.setQuickBarSlot).not.toHaveBeenCalled();
        expect(s.bot.activateItem).not.toHaveBeenCalled();
        expect(s.memory.scoop).toBeDefined();
        // on the floor, in the water over it: wanted
        s.self.position = new Vec3(0.5, 64, 0.5); s.self.isInWater = true;
        expect(scoopWanted(s.bot, s.memory, Date.now())).toBe(true);
        // a floor one cell down is still a floor, two cells and the fall would cost: not
        s.self.position = new Vec3(0.5, 65, 0.5); s.world.delete(key(0, 65, 0)); s.world.delete(key(0, 66, 0));
        s.world.set(key(0, 64, 0), 'air');
        expect(scoopWanted(s.bot, s.memory, Date.now())).toBe(true);
        s.self.position = new Vec3(0.5, 66, 0.5);
        expect(scoopWanted(s.bot, s.memory, Date.now())).toBe(false);
      } finally { s.stop(); }
      const lost = afterCutOff(); // the floor goes while the body looks at the water: nothing is used
      try {
        lost.bot.lookAt = vi.fn(async () => { lost.world.delete(key(0, 63, 0)); });
        lost.bot.setQuickBarSlot(0); lost.bot.setQuickBarSlot.mockClear();
        expect(await scoopBack(lost.bot, lost.bot, lost.memory)).toMatchObject({ success: false, scooped: false });
        expect(lost.seen.uses).toBe(0);
        expect(lost.memory.scoop).toBeDefined();
      } finally { lost.stop(); }
    });
    it('takes the water the note names and no other: a source where the body stands is no substitute (round 8: the one poured stayed and the note was dropped)', async () => {
      const s = afterCutOff();
      try {
        s.world.set(key(3, 64, 0), 'water'); s.self.position = new Vec3(3.5, 64, 0.5); // a second source, under the body, three blocks from the one poured at (0, 64, 0)
        expect(await scoopBack(s.bot, s.bot, s.memory)).toMatchObject({ success: true, scooped: true });
        expect(s.bot.lookAt).toHaveBeenCalledWith(expect.objectContaining({ x: 0.5, z: 0.5 }), true);
        expect(s.world.has(key(0, 64, 0))).toBe(false); // the poured one is taken
        expect(s.world.get(key(3, 64, 0))).toBe('water'); // the other is left
        expect(s.memory.scoop).toBeUndefined();
      } finally { s.stop(); }
      const gone = afterCutOff(); // the poured one is gone, another is near: the note is dropped and the other is left alone
      try {
        gone.world.delete(key(0, 64, 0)); gone.world.set(key(1, 64, 0), 'water');
        expect(await scoopBack(gone.bot, gone.bot, gone.memory)).toMatchObject({ success: true, scooped: false });
        expect(gone.seen.uses).toBe(0);
        expect(gone.world.get(key(1, 64, 0))).toBe('water');
        expect(gone.memory.scoop).toBeUndefined();
      } finally { gone.stop(); }
    });
    it('wants to take the water up only near it, not twice within a moment, and not for long; a note that cannot be kept is dropped', () => {
      const f = falling({ y: 64 });
      f.self.onGround = true; f.bot.heldItem = { name: 'bucket', slot: 37 };
      const note = (extra: Record<string, unknown> = {}): FallMemory => ({ scoop: { x: 0, y: 64, z: 0, at: 1000, tries: 0, ...extra } });
      expect(scoopWanted(f.bot, note(), 1500)).toBe(true);
      expect(scoopWanted(f.bot, note({ lastAt: 1000 }), 1000 + SCOOP_GAP_MS - 1)).toBe(false);
      expect(scoopWanted(f.bot, note({ lastAt: 1000 }), 1000 + SCOOP_GAP_MS)).toBe(true);
      const far = note();
      f.world.set(key(5, 63, 0), 'end_stone'); // a floor under the far place: it is the distance that says no
      f.self.position = new Vec3(0.5 + SCOOP_NEAR + 1, 64, 0.5);
      expect(scoopWanted(f.bot, far, 1500)).toBe(false);
      expect(far.scoop).toBeDefined(); // kept: the body may come back
      f.self.position = new Vec3(0.5, 64, 0.5);
      f.self.onGround = false;
      expect(scoopWanted(f.bot, note(), 1500)).toBe(false); // in the air
      f.self.onGround = true;
      const old = note();
      expect(scoopWanted(f.bot, old, 1000 + SCOOP_PENDING_MS + 1)).toBe(false);
      expect(old.scoop).toBeUndefined();
      const tried = note({ tries: SCOOP_PENDING_TRIES });
      expect(scoopWanted(f.bot, tried, 1500)).toBe(false);
      expect(tried.scoop).toBeUndefined();
      f.bot.health = 0;
      expect(scoopWanted(f.bot, note(), 1500)).toBe(false);
      f.bot.health = 20;
      f.bot.heldItem = { name: 'diamond_sword' }; f.bot.inventory = { items: () => [{ name: 'bucket', slot: 20 }], slots: [] };
      const packed = note();
      expect(scoopWanted(f.bot, packed, 1500)).toBe(false);
      expect(packed.scoop).toBeDefined(); // the server's word that the bucket is empty may still be on its way a moment after the pour
      expect(scoopWanted(f.bot, packed, 1000 + SCOOP_BUCKET_WAIT_MS + 1)).toBe(false);
      expect(packed.scoop).toBeUndefined(); // an empty bucket in the pack is not to be had
    });
  });
});

import { blastAt } from '../../src/services/minebot/utils/crystalBlast.js';

describe("a blast's line of sight through blocks that are not whole cubes (independent review 2026-11-02: a slab was taken for a cube)", () => {
  const BOTTOM_SLAB = [[0, 0, 0, 1, 0.5, 1]], TOP_SLAB = [[0, 0.5, 0, 1, 1, 1]], CUBE = [[0, 0, 0, 1, 1, 1]];
  const centre = { x: 0.5, y: 65.5, z: 0.5 }, feet = { x: 4.5, y: 64, z: 0.5 };
  /** A row of blocks at x 2 (z -3 to 3) at the given heights, of a name whose boxes are given (none: a whole cube, as a block the game does not list). */
  function wallOf(heights: number[], name: string, shapes?: number[][]) {
    const world: World = new Map();
    for (const y of heights) for (let z = -3; z <= 3; z++) world.set(key(2, y, z), name);
    const f = fixture({ phase: DRAGON_PHASE.holdingPattern, at: new Vec3(feet.x, feet.y, feet.z), world });
    const original = f.bot.blockAt;
    f.bot.blockAt = (v: Vec3, ...rest: unknown[]) => {
      const block = original(v, ...rest);
      if (block.name !== name) return block;
      const { shapes: _listed, ...plain } = block;
      return shapes === undefined ? plain : { ...plain, shapes };
    };
    return f.bot;
  }
  it('is shut out by a wall of whole cubes', () => {
    expect(blastAt(wallOf([63, 64, 65, 66], 'obsidian', CUBE), centre, feet).seen).toBe(0);
  });
  it('is shut out by nothing that has no collision (an open fence gate is solid by its bounding box and lists no boxes), nor by a block whose boxes are not known: the estimate is the larger one', () => {
    const gate = blastAt(wallOf([63, 64, 65, 66], 'oak_fence_gate', []), centre, feet);
    expect(gate.seen).toBe(1);
    expect(blastAt(wallOf([63, 64, 65, 66], 'obsidian'), centre, feet).seen).toBe(1);
    // (round 5 of the independent review: the open gate was taken for a cube and a blast of 32 was judged 5)
    expect(gate.raw).toBeGreaterThan(blastAt(wallOf([63, 64, 65, 66], 'obsidian', CUBE), centre, feet).raw);
  });
  it('sees over a bottom slab: the line passes above its top, where a cube would have shut it out', () => {
    const slabs = blastAt(wallOf([64], 'stone_slab', BOTTOM_SLAB), centre, feet);
    expect(slabs.seen).toBeGreaterThan(0.85); // the few lines to the lowest points clip the far edge of the slab
    const asCube = blastAt(wallOf([64], 'stone_slab', CUBE), centre, feet);
    expect(asCube.seen).toBeLessThan(slabs.seen);
    expect(slabs.raw).toBeGreaterThan(asCube.raw);
  });
  it('is partly shut out by a top slab: the lines under it pass, those through its half are stopped', () => {
    const seen = blastAt(wallOf([65], 'stone_slab', TOP_SLAB), centre, feet).seen;
    expect(seen).toBeGreaterThan(0);
    expect(seen).toBeLessThan(1);
  });
});
