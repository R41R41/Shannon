import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { assertNoLavaRelease, installLavaDigGuard, SupportDigError, supportDropIfDug, isBurning, LavaReleaseError, lavaReflexTick, lavaReleasedBy, routeOutOfLava, shouldDouse, standsOnMagma, coverMagmaUnder } from '../../src/services/minebot/utils/lavaSafety.js';

const stone = { name: 'stone', boundingBox: 'block' }, air = { name: 'air', boundingBox: 'empty' }, lava = { name: 'lava', boundingBox: 'empty' };
/** Stone everywhere except the listed cells. */
function world(cells: Record<string, any>) {
  return { blockAt: (p: Vec3) => cells[`${p.x},${p.y},${p.z}`] ?? stone };
}
const body = (cells: Record<string, any>, position: Vec3, extra: Record<string, unknown> = {}) =>
  ({ ...world(cells), entity: { position, isInLava: false }, ...extra }) as any;

describe('a dig is judged by what it would let onto the body (paid run L63 broke a block with lava beside it from underneath)', () => {
  // The body stands at (0, 71, 0) in a shaft of its own; a lava pocket lies at (1, 73, 0), beside the block over its head.
  const shaft = { '0,71,0': air, '0,72,0': air, '1,73,0': lava };

  it('refuses the block overhead when lava lies beside or over it', () => {
    const bot = body(shaft, new Vec3(0.5, 71, 0.5));
    expect(lavaReleasedBy(bot, new Vec3(0, 73, 0))).toMatchObject({ x: 1, y: 73, z: 0 });
    expect(() => assertNoLavaRelease(bot, { name: 'dirt', position: new Vec3(0, 73, 0) })).toThrow(LavaReleaseError);
    const over = body({ ...shaft, '1,73,0': stone, '0,74,0': lava }, new Vec3(0.5, 71, 0.5));
    expect(lavaReleasedBy(over, new Vec3(0, 73, 0))).toMatchObject({ y: 74 });
    expect(lavaReleasedBy(body({ '0,71,0': air, '0,72,0': air }, new Vec3(0.5, 71, 0.5)), new Vec3(0, 73, 0))).toBeNull();
  });

  it('refuses a block in the tunnel wall with lava behind it, and the block underfoot with lava under or beside it', () => {
    const tunnel = body({ '0,71,0': air, '0,72,0': air, '2,71,0': lava }, new Vec3(0.5, 71, 0.5));
    expect(lavaReleasedBy(tunnel, new Vec3(1, 71, 0))).toMatchObject({ x: 2 });
    const overLava = body({ '0,71,0': air, '0,72,0': air, '0,69,0': lava }, new Vec3(0.5, 71, 0.5));
    expect(lavaReleasedBy(overLava, new Vec3(0, 70, 0))).toMatchObject({ y: 69 });
  });

  it('leaves alone a block below the feet and off to the side, where the lava stays in the cell it fills (obsidian at a pool rim)', () => {
    // Standing on the bank at y=71; the pool surface is at y=69, one block out; obsidian at (2, 69, 0) with lava beside it.
    const rim = body({ '0,71,0': air, '0,72,0': air, '3,69,0': lava, '2,70,0': air, '2,71,0': air }, new Vec3(0.5, 71, 0.5));
    expect(lavaReleasedBy(rim, new Vec3(2, 69, 0))).toBeNull();
  });

  it('guards every dig made through the body, and passes the others through', async () => {
    const dig = vi.fn(async () => 'dug');
    const bot = body(shaft, new Vec3(0.5, 71, 0.5), { dig });
    installLavaDigGuard(bot);
    await expect(bot.dig({ name: 'dirt', position: new Vec3(0, 73, 0) })).rejects.toBeInstanceOf(LavaReleaseError);
    expect(dig).not.toHaveBeenCalled();
    expect(bot.lavaDigGuard.refused).toBe(1);
    await expect(bot.dig({ name: 'stone', position: new Vec3(-1, 71, 0) })).resolves.toBe('dug');
    expect(dig).toHaveBeenCalledOnce();
  });
});

describe('the floor the body stands on is not dug over a dangerous fall (S5 lab, c1: the path executor broke it at y=110 over 58 blocks of air)', () => {
  // The body stands at (0.5, 110, 0.5) on netherrack (0, 109, 0); under it, air down to stone at y=50 (a 59-block fall).
  const open: Record<string, any> = { '0,110,0': air, '0,111,0': air };
  for (let y = 51; y <= 108; y++) open[`0,${y},0`] = air;
  // The edge guard reads the footprint's corners (x ± 0.3): this world floors what it is asked, as the client's does.
  const body = (cells: Record<string, any>, position: Vec3, extra: Record<string, unknown> = {}) => ({
    blockAt: (p: Vec3) => cells[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`] ?? stone, entity: { position, isInLava: false }, ...extra }) as any;

  it('refuses the floor block over the void, and the guard on the body refuses the dig', async () => {
    const bot = body(open, new Vec3(0.5, 110, 0.5), { health: 20 });
    expect(supportDropIfDug(bot, new Vec3(0, 109, 0))).toBe(59);
    const dig = vi.fn(async () => 'dug');
    const guarded: any = { ...bot, dig };
    installLavaDigGuard(guarded);
    await expect(guarded.dig({ name: 'netherrack', position: new Vec3(0, 109, 0) })).rejects.toBeInstanceOf(SupportDigError);
    expect(dig).not.toHaveBeenCalled();
    // A block beside the feet, and the one over the head, are dug as before.
    await guarded.dig({ name: 'netherrack', position: new Vec3(1, 110, 0) });
    expect(dig).toHaveBeenCalledTimes(1);
  });

  it('lets the floor go when the body drops a block or two (a shaft dug a level at a time), or when another block still holds a corner', () => {
    const shaft = body({ '0,110,0': air, '0,111,0': air, '0,108,0': air }, new Vec3(0.5, 110, 0.5), { health: 20 });
    expect(supportDropIfDug(shaft, new Vec3(0, 109, 0))).toBeNull();
    // Standing across two columns: the other one still holds the body.
    const edge = body(open, new Vec3(0.9, 110, 0.5), { health: 20 });
    expect(supportDropIfDug(edge, new Vec3(0, 109, 0))).toBeNull();
  });

  it('refuses the floor over lava however shallow', () => {
    const pool = body({ '0,110,0': air, '0,111,0': air, '0,108,0': lava }, new Vec3(0.5, 110, 0.5), { health: 20 });
    expect(supportDropIfDug(pool, new Vec3(0, 109, 0))).toBe(Infinity);
  });
});

describe('a body in lava swims for the nearest place clear of it', () => {
  // A corridor along x at y=71..72 over a stone floor; lava fills the cells at x=0 and x=1; clear from x=2 on and from x=-3 back.
  const corridor: Record<string, any> = {};
  for (let x = -4; x <= 5; x++) for (const y of [71, 72]) corridor[`${x},${y},0`] = x === 0 || x === 1 || x === -1 || x === -2 ? lava : air;

  it('finds the shorter way out', () => {
    expect(routeOutOfLava(world(corridor), new Vec3(1.5, 71, 0.5))!.map(cell => cell.x)).toEqual([2.5]);
    expect(routeOutOfLava(world(corridor), new Vec3(0.5, 71, 0.5))!.map(cell => cell.x)).toEqual([1.5, 2.5]);
    // Nowhere to stand within reach: no route.
    const sea: Record<string, any> = {};
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) for (const y of [71, 72]) sea[`${x},${y},${z}`] = lava;
    expect(routeOutOfLava(world(sea), new Vec3(0.5, 71, 0.5))).toBeNull();
  });

  it('presses jump and heads there the tick it is in lava, and lets go once it has been out for a moment', () => {
    const controls: Record<string, boolean> = {};
    const looks: number[] = [];
    const bot = body(corridor, new Vec3(1.5, 71, 0.5), { health: 16, setControlState: (c: string, v: boolean) => { controls[c] = v; },
      look: (yaw: number) => { looks.push(yaw); } });
    const state = { engaged: false, engagements: 0, clearTicks: 0 };
    expect(lavaReflexTick(bot, state)).toBeNull();                 // not in lava: nothing
    bot.entity.isInLava = true;
    expect(lavaReflexTick(bot, state)).toBe('engaged');
    expect(controls).toMatchObject({ jump: true, forward: true, sprint: true, sneak: false });
    expect(looks.at(-1)).toBeCloseTo(-Math.PI / 2);                // east, toward x=2.5
    bot.entity.isInLava = false; bot.entity.position = new Vec3(2.5, 71, 0.5);
    for (let tick = 0; tick < 5; tick++) expect(lavaReflexTick(bot, state)).toBeNull();
    expect(lavaReflexTick(bot, state)).toBe('released');
    expect(controls).toMatchObject({ jump: false, forward: false, sprint: false });
    expect(state.engagements).toBe(1);
  });

  it('still swims up when there is nowhere to go', () => {
    const controls: Record<string, boolean> = {};
    const sea: Record<string, any> = {};
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) for (const y of [71, 72]) sea[`${x},${y},${z}`] = lava;
    const bot = body(sea, new Vec3(0.5, 71, 0.5), { health: 16, setControlState: (c: string, v: boolean) => { controls[c] = v; } });
    bot.entity.isInLava = true;
    expect(lavaReflexTick(bot, { engaged: false, engagements: 0, clearTicks: 0 })).toBe('engaged');
    expect(controls.jump).toBe(true);
  });
});

describe('a body standing in a block of fire walks out of it (paid run L77c stood in the flames a ghast\'s fireball left, until it died)', () => {
  // Netherrack floor at y=70; the cells at x=0 and x=1 are on fire at the level of the feet; clear from x=2 on.
  const fire = { name: 'fire', boundingBox: 'empty' };
  const burningGround: Record<string, any> = {};
  for (let x = -4; x <= 5; x++) for (const y of [71, 72]) burningGround[`${x},${y},0`] = y === 71 && (x === 0 || x === 1 || x === -1 || x === -2) ? fire : air;

  it('heads for the nearest cell that is not burning, without jumping, and lets go once out', () => {
    const controls: Record<string, boolean> = {};
    const looks: number[] = [];
    const bot = body(burningGround, new Vec3(1.5, 71, 0.5), { health: 9, setControlState: (c: string, v: boolean) => { controls[c] = v; },
      look: (yaw: number) => { looks.push(yaw); } });
    const state: any = { engaged: false, engagements: 0, clearTicks: 0 };
    expect(lavaReflexTick(bot, state)).toBe('engaged');
    expect(state.in).toBe('fire');
    expect(controls).toMatchObject({ jump: false, forward: true, sprint: true });
    expect(looks.at(-1)).toBeCloseTo(-Math.PI / 2);                // east, toward x=2.5
    bot.entity.position = new Vec3(2.5, 71, 0.5);
    for (let tick = 0; tick < 5; tick++) expect(lavaReflexTick(bot, state)).toBeNull();
    expect(lavaReflexTick(bot, state)).toBe('released');
    expect(controls.forward).toBe(false);
  });

  // S2 (2026-11-02, the c1 blaze camp): the flames a fireball leaves are put out where the body stands (a quick dig) before the body is walked out of its place (which stopped its act).
  it('puts out the fire it stands in with a quick dig first, and is walked out only when the fire stands for two seconds all the same', async () => {
    vi.useFakeTimers();
    try {
      const controls: Record<string, boolean> = {};
      const punch = vi.fn(async () => true);
      const bot = body(burningGround, new Vec3(1.5, 71, 0.5), { health: 9, setControlState: (c: string, v: boolean) => { controls[c] = v; }, look: () => undefined, punchOutFire: punch });
      const state: any = { engaged: false, engagements: 0, clearTicks: 0 };
      expect(lavaReflexTick(bot, state)).toBeNull();
      expect(punch).toHaveBeenCalledTimes(1);
      expect(controls).toEqual({});
      let engagedAt = -1;
      for (let ms = 100; ms <= 3000 && engagedAt < 0; ms += 100) {
        await vi.advanceTimersByTimeAsync(100);
        if (lavaReflexTick(bot, state) === 'engaged') engagedAt = ms;
      }
      // the fire never went out in this world: the walk out comes once the episode has lasted its two seconds, after more than one dig
      expect(engagedAt).toBeGreaterThanOrEqual(2000);
      expect(punch.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(controls).toMatchObject({ forward: true, sprint: true });
    } finally { vi.useRealTimers(); }
  });

  it('walks out at once when the dig fails twice (a body that cannot dig is not left in the flames)', async () => {
    vi.useFakeTimers();
    try {
      const punch = vi.fn(async () => { throw new Error('cannot dig'); });
      const bot = body(burningGround, new Vec3(1.5, 71, 0.5), { health: 9, setControlState: () => undefined, look: () => undefined, punchOutFire: punch });
      const state: any = { engaged: false, engagements: 0, clearTicks: 0 };
      expect(lavaReflexTick(bot, state)).toBeNull();
      await vi.advanceTimersByTimeAsync(50);
      expect(lavaReflexTick(bot, state)).toBeNull();           // the second dig is tried
      await vi.advanceTimersByTimeAsync(50);
      expect(lavaReflexTick(bot, state)).toBe('engaged');
      expect(punch).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('lava is never punched at: a body in lava swims as before, with a puncher or without', () => {
    const punch = vi.fn(async () => true);
    const pool = body({ '0,71,0': lava, '0,72,0': air, '1,71,0': air, '1,72,0': air, '1,70,0': stone }, new Vec3(0.5, 71, 0.5), { health: 9, setControlState: () => undefined, look: () => undefined, punchOutFire: punch });
    pool.entity.isInLava = true;
    expect(lavaReflexTick(pool, { engaged: false, engagements: 0, clearTicks: 0 })).toBe('engaged');
    expect(punch).not.toHaveBeenCalled();
  });

  it('leaves a body beside the fire, or with nowhere clear in reach, to whoever holds the keys', () => {
    const controls: Record<string, boolean> = {};
    const beside = body(burningGround, new Vec3(3.5, 71, 0.5), { health: 9, setControlState: (c: string, v: boolean) => { controls[c] = v; } });
    expect(lavaReflexTick(beside, { engaged: false, engagements: 0, clearTicks: 0 })).toBeNull();
    const everywhere: Record<string, any> = {};
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) { everywhere[`${x},71,${z}`] = fire; everywhere[`${x},72,${z}`] = air; }
    const trapped = body(everywhere, new Vec3(0.5, 71, 0.5), { health: 9, setControlState: (c: string, v: boolean) => { controls[c] = v; } });
    expect(lavaReflexTick(trapped, { engaged: false, engagements: 0, clearTicks: 0 })).toBeNull();
    expect(controls).toEqual({});
  });
});

describe('lava does not rise: the block over a lava source may be taken off (paid run L68 was refused it twice and made no obsidian)', () => {
  it('lets the cover of a lava source be broken from beside it, and still refuses what would let the lava out', () => {
    // The body stands at (30,-10,56); a lava source at (30,-11,54) lies under the block (30,-10,54), two cells ahead at the level of its feet.
    const covered = { '30,-10,56': air, '30,-9,56': air, '30,-10,55': air, '30,-9,55': air, '30,-11,54': lava };
    const bot = body(covered, new Vec3(30.5, -10, 56.5));
    expect(lavaReleasedBy(bot, new Vec3(30, -10, 54))).toBeNull();
    // The same block with lava beside it at its own level is another matter.
    expect(lavaReleasedBy(body({ ...covered, '31,-10,54': lava }, new Vec3(30.5, -10, 56.5)), new Vec3(30, -10, 54))).toMatchObject({ x: 31, y: -10 });
  });
});

describe('a burning body with a bucket of water pours it at its feet (lab: three of four bodies the lava reflex got out died of the fire afterwards)', () => {
  const burningBody = (extra: Record<string, unknown> = {}) => ({ entity: { position: new Vec3(0.5, 71, 0.5), isInLava: false, isInWater: false, metadata: [1] },
    health: 12, game: { dimension: 'overworld' }, inventory: { items: () => [{ name: 'water_bucket' }] }, blockAt: () => air, on: () => undefined, ...extra }) as any;
  const idle = () => ({ running: false, attempts: 0, doused: 0, lastAt: 0 });

  it('reads the fire from the server\'s own flag', () => {
    expect(isBurning(burningBody())).toBe(true);
    expect(isBurning(burningBody({ entity: { position: new Vec3(0.5, 71, 0.5), metadata: [0x02] } }))).toBe(false); // crouching, not burning
    expect(isBurning({ entity: { position: new Vec3(0, 0, 0) } } as any)).toBe(false);
  });

  it('pours when burning, out of the lava, dry, and carrying water', () => {
    expect(shouldDouse(burningBody(), idle(), 10_000)).toBe(true);
    // Still in the lava: getting out comes first. In water: it is out already.
    expect(shouldDouse(burningBody({ entity: { position: new Vec3(0.5, 71, 0.5), isInLava: true, metadata: [1] } }), idle(), 10_000)).toBe(false);
    expect(shouldDouse(burningBody({ entity: { position: new Vec3(0.5, 71, 0.5), isInWater: true, metadata: [1] } }), idle(), 10_000)).toBe(false);
    // No water to pour, or an empty bucket.
    expect(shouldDouse(burningBody({ inventory: { items: () => [{ name: 'bucket' }] } }), idle(), 10_000)).toBe(false);
    // The Nether boils water away.
    expect(shouldDouse(burningBody({ game: { dimension: 'the_nether' } }), idle(), 10_000)).toBe(false);
    // Not burning; dead; already pouring; just tried.
    expect(shouldDouse(burningBody({ entity: { position: new Vec3(0.5, 71, 0.5), metadata: [0] } }), idle(), 10_000)).toBe(false);
    expect(shouldDouse(burningBody({ health: 0 }), idle(), 10_000)).toBe(false);
    expect(shouldDouse(burningBody(), { ...idle(), running: true }, 10_000)).toBe(false);
    expect(shouldDouse(burningBody(), { ...idle(), lastAt: 9_000 }, 10_000)).toBe(false);
  });
});

describe('a body on magma crouches, which the game leaves unburnt (paid run L94: "hurt by something unknown" on a magma field by a lava sea, stood still, died)', () => {
  const magma = { name: 'magma_block', boundingBox: 'block' };
  // A magma floor at y=70 for x <= 1; netherrack from x = 2 on.
  const field: Record<string, any> = {};
  for (let x = -4; x <= 5; x++) { field[`${x},70,0`] = x <= 1 ? magma : { name: 'netherrack', boundingBox: 'block' }; field[`${x},71,0`] = air; field[`${x},72,0`] = air; }
  it('crouches while on it and lets the crouch go once off it, without taking the keys that move the body or setting the held reflex', () => {
    const controls: Record<string, boolean> = { forward: true };
    const bot = body(field, new Vec3(0.5, 71, 0.5), { health: 12, setControlState: (c: string, v: boolean) => { controls[c] = v; } });
    expect(standsOnMagma(bot)).toBe(true);
    const state: any = { engaged: false, engagements: 0, clearTicks: 0 };
    expect(lavaReflexTick(bot, state)).toBe('magma');
    // run62: magma set `engaged`, which reflexHeld read as lava-escape, and every act hand on the rim came back not_run.
    expect(state.engaged).toBe(false);
    expect(state.engagements).toBe(0);
    expect(state.magma.engagements).toBe(1);
    expect(controls).toEqual({ forward: true, sneak: true });
    // A moving body is left to whoever moves it.
    for (let tick = 1; tick <= 10; tick++) { bot.entity.position = new Vec3(0.5 - tick * 0.1, 71, 0.5); lavaReflexTick(bot, state); }
    expect(controls).toEqual({ forward: true, sneak: true });
    bot.entity.position = new Vec3(3.5, 71, 0.5);
    expect(standsOnMagma(bot)).toBe(false);
    for (let tick = 0; tick < 5; tick++) expect(lavaReflexTick(bot, state)).toBeNull();
    expect(lavaReflexTick(bot, state)).toBe('magma-off');
    expect(controls).toEqual({ forward: true, sneak: false });
  });

  it('walks a body that stands still on it to the nearest cell off it, crouched on the level, and stops the walk once off', () => {
    const controls: Record<string, boolean> = {}, looks: number[] = [];
    const bot = body(field, new Vec3(1.5, 71, 0.5), { health: 12, setControlState: (c: string, v: boolean) => { controls[c] = v; }, look: (yaw: number) => { looks.push(yaw); } });
    const state: any = { engaged: false, engagements: 0, clearTicks: 0 };
    for (let tick = 0; tick < 6; tick++) lavaReflexTick(bot, state);
    expect(controls.forward).toBeUndefined();
    lavaReflexTick(bot, state);
    expect(controls).toMatchObject({ forward: true, sprint: false, jump: false, sneak: true });
    // Toward +x (netherrack from x = 2): yaw atan2(-dx, -dz) with dx > 0.
    expect(looks.at(-1)).toBeCloseTo(Math.atan2(-1, 0));
    bot.entity.position = new Vec3(2.5, 71, 0.5);
    lavaReflexTick(bot, state);
    expect(controls).toMatchObject({ forward: false, jump: false, sneak: true });
    expect(state.engaged).toBe(false);
  });

  it('steps down uncrouched off a rim of magma whose centre is over a hole (run62, c1: the broken portal)', () => {
    // A hole at (0, 70, 0) with stone under it; magma round it. The body stands at x = 0.75: its centre over the hole, its width on the magma at x = 1.
    const rim: Record<string, any> = { '0,70,0': air, '0,71,0': air, '0,72,0': air };
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) { rim[`${x},70,${z}`] = magma; rim[`${x},71,${z}`] = air; rim[`${x},72,${z}`] = air; }
    const controls: Record<string, boolean> = {};
    const bot = body(rim, new Vec3(0.75, 71, 0.5), { health: 12, setControlState: (c: string, v: boolean) => { controls[c] = v; }, look: () => undefined });
    expect(standsOnMagma(bot)).toBe(true);
    expect(routeOutOfLava(bot, bot.entity.position, { offMagma: true })?.[0]).toMatchObject({ x: 0.5, y: 70, z: 0.5 });
    // Without the magma rule the rim beside it would do.
    expect(routeOutOfLava(bot, bot.entity.position)?.[0]).toMatchObject({ x: 1.5, y: 71 });
    const state: any = { engaged: false, engagements: 0, clearTicks: 0 };
    for (let tick = 0; tick < 7; tick++) lavaReflexTick(bot, state);
    expect(controls).toMatchObject({ forward: true, sneak: false, jump: false });
  });

  it('puts a block down when there is no cell off it in reach', async () => {
    const sea: Record<string, any> = {};
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) { sea[`${x},70,${z}`] = magma; sea[`${x},71,${z}`] = air; sea[`${x},72,${z}`] = air; sea[`${x},73,${z}`] = air; }
    const cover = vi.fn(async () => true);
    const controls: Record<string, boolean> = {};
    const bot = body(sea, new Vec3(0.5, 71, 0.5), { health: 12, setControlState: (c: string, v: boolean) => { controls[c] = v; }, coverMagma: cover });
    const state: any = { engaged: false, engagements: 0, clearTicks: 0 };
    for (let tick = 0; tick < 7; tick++) lavaReflexTick(bot, state);
    expect(cover).toHaveBeenCalledTimes(1);
    expect(state.magma.covering).toBe(true);
    lavaReflexTick(bot, state);
    expect(cover).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(state.magma.covers).toBe(1);
    expect(state.magma.covering).toBe(false);
  });

  it('fills the hole under the centre, or rises a block on magma all round, with a common block, and puts the held item back', async () => {
    const placed: Array<{ ref: Vec3; face: Vec3 }> = [], equipped: string[] = [];
    const tools = (extra: Record<string, unknown>) => ({ heldItem: { name: 'iron_pickaxe' }, inventory: { items: () => [{ name: 'obsidian' }, { name: 'cobblestone' }] },
      equip: async (item: { name: string }) => { equipped.push(item.name); }, placeBlock: async (ref: { position: Vec3 }, face: Vec3) => { placed.push({ ref: ref.position, face }); },
      setControlState: () => undefined, ...extra });
    const located = (cells: Record<string, any>) => ({ blockAt: (p: Vec3) => ({ ...(cells[`${p.x},${p.y},${p.z}`] ?? stone), position: p }) });
    const hole = { '0,70,0': air, '0,71,0': air, '0,72,0': air, '1,70,0': magma };
    const rimBody = { ...located(hole), entity: { position: new Vec3(0.75, 71, 0.5) }, ...tools({}) } as any;
    expect(await coverMagmaUnder(rimBody)).toBe(true);
    expect(placed[0]).toMatchObject({ ref: { x: 0, y: 69, z: 0 }, face: { x: 0, y: 1, z: 0 } });
    expect(equipped).toEqual(['cobblestone', 'iron_pickaxe']);
    // Magma all round: jump, then put the block on the magma under the centre.
    const open = { '0,70,0': magma, '0,71,0': air, '0,72,0': air, '0,73,0': air };
    const riser: any = { ...located(open), entity: { position: new Vec3(0.5, 71, 0.5) } };
    Object.assign(riser, tools({ setControlState: (c: string, v: boolean) => { if (c === 'jump' && v) riser.entity.position = new Vec3(0.5, 72.1, 0.5); } }));
    expect(await coverMagmaUnder(riser)).toBe(true);
    expect(placed[1]).toMatchObject({ ref: { x: 0, y: 70, z: 0 }, face: { x: 0, y: 1, z: 0 } });
    // end1109f18: the centre over a one-wide lava source, the width on the magma rim beside it: the lava cell is filled from the stone under it.
    const pool = { '0,70,0': lava, '0,71,0': air, '0,72,0': air, '-1,70,0': magma };
    const overLava = { ...located(pool), entity: { position: new Vec3(0.2, 71, 0.5) }, ...tools({}) } as any;
    expect(await coverMagmaUnder(overLava)).toBe(true);
    expect(placed[2]).toMatchObject({ ref: { x: 0, y: 69, z: 0 }, face: { x: 0, y: 1, z: 0 } });
    // Nothing common to put down: no cover.
    expect(await coverMagmaUnder({ ...rimBody, inventory: { items: () => [{ name: 'obsidian' }] } })).toBe(false);
  });
});

