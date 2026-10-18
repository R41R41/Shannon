import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { judgeAppliedTick } from '../../src/services/minebot/utils/edgeGuard.js';
import { floorConfig } from '../../src/services/minebot/utils/floorConfig.js';
import { ESCAPE_SKILLS, fleeHeading, fleeHeadingSafe, fleeStart, installFloorReflexes, runLowHealthFlee, type FloorBody, type FloorState } from '../../src/services/minebot/utils/floorReflexes.js';

/** Terrain as the body reads it: stone up to y 64 everywhere `solid(x, z)` says so, air above, `patch` for single cells. */
type Cell = { name: string; boundingBox: string };
const STONE: Cell = { name: 'stone', boundingBox: 'block' }, AIR: Cell = { name: 'air', boundingBox: 'empty' }, LAVA: Cell = { name: 'lava', boundingBox: 'empty' };
function terrain(options: { solid?: (x: number, z: number) => boolean; patch?: (x: number, y: number, z: number) => Cell | undefined } = {}) {
  const solid = options.solid ?? (() => true);
  return (position: Vec3): Cell => {
    const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
    return options.patch?.(x, y, z) ?? (y <= 64 && solid(x, z) ? STONE : AIR);
  };
}
function fixture(blockAt: (position: Vec3) => Cell, patch: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, name: 'player', position: new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
    health: 5, food: 20, game: { dimension: 'overworld' }, entities: { 2: { id: 2, name: 'zombie', position: new Vec3(2.5, 65, 0.5) } } as Record<string, any>,
    inventory: { items: () => [] as any[], slots: new Array(46).fill(null) }, controlState: {} as Record<string, boolean>, executingSkill: false, interruptExecution: false,
    clearControlStates: vi.fn(), setControlState: vi.fn((key: string, value: boolean) => { calls.push([key, value]); }), look: vi.fn(async () => {}),
    equip: vi.fn(async () => {}), consume: vi.fn(async () => {}), blockAt, ...patch });
  return { bot: bot as FloorBody & any, calls };
}
/** The direction a yaw faces: mineflayer's (-sin yaw, -cos yaw). */
const facing = (yaw: number) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
const state = (patch: Partial<FloorState> = {}): FloorState => ({ retreat: { engaged: false, ticks: 0, cooldown: 0, engagements: 0 }, busy: null, retryAt: 0, engagements: { eat: 0, armor: 0 }, fleeStarts: [], ...patch });
const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));

describe('the low-health flee does not run toward a cliff or lava (P8 second review, L2)', () => {
  it('runs straight away from the enemy on open ground', () => {
    const { bot } = fixture(terrain());
    const yaw = fleeHeading(bot, new Vec3(2.5, 65, 0.5))!;
    expect(facing(yaw).x).toBeCloseTo(-1, 6); expect(facing(yaw).z).toBeCloseTo(0, 6);
  });
  it('turns aside when straight away is a cliff: the heading it takes has solid ground and no big drop for the whole run', () => {
    // Open ground for x >= -2; beyond that, nothing under it (a ravine).
    const world = terrain({ solid: x => x >= -2 });
    const { bot } = fixture(world);
    expect(fleeHeadingSafe(bot, bot.entity.position, Math.PI / 2)).toBe(false);
    const yaw = fleeHeading(bot, new Vec3(2.5, 65, 0.5))!;
    expect(yaw).not.toBeNull();
    // Every cell along the chosen way is ground it can stand on.
    const way = facing(yaw);
    for (let step = 1; step <= 5; step++) {
      const x = bot.entity.position.x + way.x * step, z = bot.entity.position.z + way.z * step;
      expect(world(new Vec3(x, 64, z)).boundingBox, `step ${step} at ${x.toFixed(1)},${z.toFixed(1)}`).toBe('block');
    }
    // And it does not turn toward the enemy.
    expect(way.x).toBeLessThanOrEqual(1e-9);
  });
  it('turns aside when straight away is lava (in the cell, or under it)', () => {
    const inCell = terrain({ patch: (x, y) => x <= -2 && y === 65 ? LAVA : undefined });
    const { bot } = fixture(inCell);
    expect(fleeHeadingSafe(bot, bot.entity.position, Math.PI / 2)).toBe(false);
    const yaw = fleeHeading(bot, new Vec3(2.5, 65, 0.5))!;
    expect(yaw).not.toBeNull(); expect(Math.abs(Math.sin(yaw) - 1)).toBeGreaterThan(1e-3);
    // A lake of it under a gap in the floor: the drop is into lava.
    const below = terrain({ patch: (x, y) => x <= -2 ? (y === 64 ? LAVA : y < 64 ? LAVA : undefined) : undefined });
    expect(fleeHeadingSafe(fixture(below).bot, new Vec3(0.5, 65, 0.5), Math.PI / 2)).toBe(false);
    // Fire and magma count as lethal ground too.
    const fire = terrain({ patch: (x, y) => x === -1 && y === 65 ? { name: 'fire', boundingBox: 'empty' } : undefined });
    expect(fleeHeadingSafe(fixture(fire).bot, new Vec3(0.5, 65, 0.5), Math.PI / 2)).toBe(false);
    const magma = terrain({ patch: (x, y) => x === -1 && y === 64 ? { name: 'magma_block', boundingBox: 'block' } : undefined });
    expect(fleeHeadingSafe(fixture(magma).bot, new Vec3(0.5, 65, 0.5), Math.PI / 2)).toBe(false); // the block it would stand on
    const underMagma = terrain({ patch: (x, y) => x === -1 && y === 63 ? { name: 'magma_block', boundingBox: 'block' } : undefined });
    expect(fleeHeadingSafe(fixture(underMagma).bot, new Vec3(0.5, 65, 0.5), Math.PI / 2)).toBe(true); // two down is not under the feet
  });
  it('is refused, and costs nothing, when every way it may take leads to a cliff or lava: the API\'s own judgment decides', async () => {
    // A pillar: ground only within one block of the body, a drop on every side.
    const pillar = terrain({ solid: (x, z) => Math.abs(x) <= 0 && Math.abs(z) <= 0 });
    const { bot, calls } = fixture(pillar);
    const flee = state();
    expect(fleeStart(bot, flee, Date.now())).toBeNull();
    expect(flee.engagements.fleeRefused).toBe(1); expect(flee.fleeStarts).toEqual([]);
    // Installed as the reflex: the tick starts nothing and no key is touched.
    installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1 });
    bot.emit('physicsTick'); await settle(20);
    expect(bot.floorReflexes.busy).toBeNull(); expect(calls).toEqual([]);
    expect(bot.floorReflexes.engagements.flee).toBe(0); expect(bot.floorReflexes.engagements.fleeRefused).toBeGreaterThanOrEqual(1);
    const ring = terrain({ patch: (x, y) => y === 65 && (x < 0 || Math.abs(x - 1) > 0) ? LAVA : undefined });
    expect(fleeStart(fixture(ring).bot, state(), Date.now())).toBeNull();
  });
  it('does not run into a wall at its back', () => {
    const wall = terrain({ patch: (x, y) => x === -1 && y >= 65 && y <= 66 ? STONE : undefined });
    const { bot } = fixture(wall);
    expect(fleeHeadingSafe(bot, bot.entity.position, Math.PI / 2)).toBe(false);
    const yaw = fleeHeading(bot, new Vec3(2.5, 65, 0.5))!;
    expect(yaw).not.toBeNull(); expect(facing(yaw).x).toBeGreaterThan(-0.8);
  });
  it('while running it re-reads the ground each step: lava appearing ahead turns the run aside, and it ends with the keys let go', async () => {
    let lava = false;
    const { bot, calls } = fixture(terrain({ patch: (x, y) => lava && x <= -1 && y === 65 ? LAVA : undefined }));
    const port = { ...bot } as any;
    port.setControlState = bot.setControlState; port.look = bot.look;
    const running = runLowHealthFlee(bot, port, 5);
    await settle(8); expect(bot.setControlState).toHaveBeenCalledWith('forward', true);
    // Straight away was fine until now.
    expect(facing(bot.look.mock.calls[0][0]).x).toBeCloseTo(-1, 6);
    bot.look.mockClear(); lava = true;
    const result = await running;
    expect(result.success).toBe(true);
    // From then on no look is toward the lava (-x): it runs along the shore instead.
    expect(bot.look.mock.calls.length).toBeGreaterThan(0);
    for (const [yaw] of bot.look.mock.calls) expect(facing(yaw).x).toBeGreaterThan(-0.5);
    expect(calls.slice(-5).map(([key]) => key)).toEqual(['forward', 'sprint', 'left', 'right', 'jump']); expect(calls.slice(-5).every(([, value]) => value === false)).toBe(true);
    expect(calls.some(([key, value]) => key === 'forward' && value === false)).toBe(true);
  });
  it('stops at once when there is no safe way left (the lava closes in on every side)', async () => {
    let lava = false;
    const { bot, calls } = fixture(terrain({ patch: (x, y, z) => lava && y === 65 && !(x === 0 && z === 0) ? LAVA : undefined }));
    const running = runLowHealthFlee(bot, { ...bot } as any, 5);
    await settle(8); lava = true;
    await running;
    const forwards = calls.filter(([key, value]) => key === 'forward' && value === true).length;
    expect(forwards).toBeGreaterThan(0); expect(forwards).toBeLessThan(24);
    expect(calls.some(([key, value]) => key === 'forward' && value === false)).toBe(true);
  });  it('never takes a heading toward the enemy', () => {
    const { bot } = fixture(terrain({ solid: x => x >= 0 }));
    const yaw = fleeHeading(bot, new Vec3(2.5, 65, 0.5));
    // Ground only on the enemy\'s side and at the body: every way away is the ravine, and nothing toward the enemy is offered.
    if (yaw !== null) expect(facing(yaw).x).toBeLessThanOrEqual(1e-9);
  });
  it('the edge guard still clips a step that goes over a ledge or into lava at the physics tick (defence in depth)', () => {
    const ledge = terrain({ solid: x => x >= 0 });
    const { bot } = fixture(ledge);
    const entity = bot.entity; entity.velocity = new Vec3(0, 0, 0);
    const before = { position: entity.position.clone(), onGround: true };
    entity.position = new Vec3(-1.4, 65, 0.5);
    bot.getControlState = (control: string) => control === 'forward';
    const refused = judgeAppliedTick(bot, before, null);
    expect(refused).not.toBeNull();
    expect(entity.position.x).toBeGreaterThanOrEqual(-0.31);
  });
  it('the commands that get the body out of danger are exactly the ones the flee gives way to: the API\'s flee and shelters plus leave-water, tower-up, climb-down and enter-portal; its fights (attack-*, retreat-attack) are not among them (P8 sixth review, L4)', () => {
    expect([...ESCAPE_SKILLS].sort()).toEqual(['build-around-self', 'climb-down', 'dig-shelter', 'enter-portal', 'flee-from', 'leave-water', 'tower-up']);
  });
});
