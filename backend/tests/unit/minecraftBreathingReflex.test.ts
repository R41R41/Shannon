import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { airRunningOut, breathingReflexTick, buoyancyTick, centreInColumn, describeSurfacingBlockers, markSurfacingStalled, recordAirTrail, retraceFeasible, retraceWaypoint, secondsToAir, secondsToBreakOut, secondsToSurface, secondsToSwimOut, steerAlongRoute, steerSwimmingRoute, steerToward, surfacingStalled, surfacingStallsHere, swimRouteToAir } from '../../src/services/minebot/utils/breathingReflex.js';
import { surfacingPossible } from '../../src/services/minebot/constantSkills/autoSwim.js';
import { executeAction } from '../../src/services/minebot/execution/ActionExecution.js';
import { scanDryFootholds } from '../../src/services/minebot/instantSkills/findDryFootholds.js';
import { holdsWater } from '../../src/services/minebot/utils/waterBlocks.js';

function body(overrides: Record<string, unknown> = {}) {
  const controls: Record<string, boolean> = {};
  const looks: number[] = [];
  return Object.assign({
    entity: { position: new Vec3(0.5, 52, 0.5), isInWater: true }, oxygenLevel: 4, health: 20,
    executingSkill: false, interruptExecution: false,
    blockAt: (p: Vec3) => ({ name: p.y > 62 ? 'air' : 'water', boundingBox: 'empty' }),
    getControlState: (c: string) => controls[c] ?? false,
    setControlState: (c: string, v: boolean) => { controls[c] = v; },
    look: (yaw: number) => { looks.push(yaw); },
    constantSkills: { getSkills: () => [{ skillName: 'auto-swim', priority: 10, isLocked: true, status: true, isSwimmingUp: false }] },
    controls, looks,
  }, overrides) as any;
}
const fresh = () => ({ engaged: false, engagements: 0, unattendedSince: null as number | null });

describe('last-resort breathing reflex (paid run L12 drowned on a seabed with nobody pressing jump)', () => {
  it('kicks for the surface after a second of unattended critical air, and lets go once air recovers', () => {
    const bot = body(); const state = fresh();
    expect(breathingReflexTick(bot, state, 0)).toBeNull();
    expect(breathingReflexTick(bot, state, 400)).toBeNull();
    expect(bot.controls.jump).toBeFalsy();
    expect(breathingReflexTick(bot, state, 500)).toBe('engaged');
    expect(bot.controls.jump).toBe(true);
    bot.controls.jump = false; // a mover released the key this tick
    breathingReflexTick(bot, state, 1050);
    expect(bot.controls.jump).toBe(true);
    bot.entity.isInWater = false; bot.oxygenLevel = 6; // bobbing at the surface: keep holding
    expect(breathingReflexTick(bot, state, 1500)).toBeNull();
    expect(bot.controls.jump).toBe(true);
    bot.oxygenLevel = 12;
    expect(breathingReflexTick(bot, state, 2000)).toBe('released');
    expect(bot.controls.jump).toBe(false);
  });

  it('engages early enough for the depth: the air must cover the swim up with a margin', () => {
    // Head at 53, water to 62: about 4s up. 8 air (6s) does not leave 2s of margin; 12 air (9s) does.
    expect(secondsToSurface(body())).toBeCloseTo(4);
    expect(airRunningOut(body({ oxygenLevel: 8 }))).toBe(true);
    expect(airRunningOut(body({ oxygenLevel: 12 }))).toBe(false);
    const shallow = body({ oxygenLevel: 6, entity: { position: new Vec3(0.5, 60, 0.5), isInWater: true } });
    expect(airRunningOut(shallow)).toBe(false);
  });

  it('stays out while someone is already swimming up, with enough air, or on land', () => {
    const shallow = { entity: { position: new Vec3(0.5, 60, 0.5), isInWater: true }, oxygenLevel: 7 };
    for (const bot of [body(shallow), body({ entity: { position: new Vec3(0, 64, 0), isInWater: false } })]) {
      const state = fresh();
      for (const t of [0, 1000, 2000]) expect(breathingReflexTick(bot, state, t)).toBeNull();
    }
    const swimming = body(); swimming.controls.jump = true; const state = fresh();
    for (const t of [0, 1000, 2000]) expect(breathingReflexTick(swimming, state, t)).toBeNull();
  });

  it('defers to a survival action holding the body', async () => {
    const bot = body(); const state = fresh();
    let finish!: () => void;
    const lease = executeAction(bot, 'auto-swim', 0, () => new Promise(resolve => { finish = () => resolve({ success: true, result: 'ok' }); }),
      { safetyLease: true, legacyExecutingSkill: false });
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const t of [0, 1000, 2000]) expect(breathingReflexTick(bot, state, t)).toBeNull();
    finish(); await lease;
  });

  it('swims sideways toward open water under a ceiling', () => {
    // A single block over the head at 54; open air above the water from y=57 everywhere else.
    const bot = body({ blockAt: (p: Vec3) => (p.y === 54 && p.x === 0 && p.z === 0 ? { name: 'stone', boundingBox: 'block' }
      : { name: p.y >= 57 ? 'air' : 'water', boundingBox: 'empty' }) });
    const state = fresh();
    breathingReflexTick(bot, state, 0); breathingReflexTick(bot, state, 500); breathingReflexTick(bot, state, 550);
    expect(bot.controls.forward).toBe(true);
    expect(bot.looks.length).toBeGreaterThan(0);
  });

  it('names what held the regular surfacing', () => {
    expect(describeSurfacingBlockers(body())).toContain('auto-swim=status:true locked:true swimming:false');
  });
});

describe('water as the physics sees it', () => {
  it('counts seagrass, kelp, bubble columns and waterlogged blocks as water', () => {
    for (const name of ['water', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']) expect(holdsWater({ name })).toBe(true);
    expect(holdsWater({ name: 'oak_slab', getProperties: () => ({ waterlogged: true }) })).toBe(true);
    expect(holdsWater({ name: 'short_grass' })).toBe(false);
    expect(holdsWater({ name: 'air' })).toBe(false);
  });

  it('never offers a seagrass seabed as dry footing', () => {
    // Water from y=52 to 62 over a sand floor at 51, tall seagrass at (2, 52..53, 0).
    const blockAt = (p: Vec3) => {
      if (p.y <= 51) return { name: 'sand', boundingBox: 'block' };
      if (p.y > 62) return { name: 'air', boundingBox: 'empty' };
      if (p.x === 2 && p.z === 0 && (p.y === 52 || p.y === 53)) return { name: 'tall_seagrass', boundingBox: 'empty' };
      return { name: 'water', boundingBox: 'empty' };
    };
    const scan = scanDryFootholds({ entity: { position: new Vec3(0.5, 62, 0.5) }, blockAt } as any, { radius: 4, maxVertical: 12 });
    expect(scan.candidates).toEqual([]);
  });
});

describe('an idle body in deep water treads water (paid run L21 sank between every two actions)', () => {
  it('floats while nobody acts, lets go the moment an action takes the body, and floats again after', async () => {
    const bot = body({ oxygenLevel: 20 }); const state: { floating?: boolean } = {};
    expect(buoyancyTick(bot, state)).toBe('floating');
    expect(bot.controls.jump).toBe(true);
    expect(buoyancyTick(bot, state)).toBeNull();
    let release = () => {};
    const digging = executeAction(bot, 'dig-block-at', 5000, () => new Promise(resolve => { release = () => resolve({ success: true, result: 'dug' }); }));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(buoyancyTick(bot, state)).toBe('released');
    expect(bot.controls.jump).toBe(false);
    bot.controls.jump = true; // the action swims by itself
    expect(buoyancyTick(bot, state)).toBeNull();
    expect(bot.controls.jump).toBe(true); // and its key is left alone
    bot.controls.jump = false;
    release(); await digging;
    expect(buoyancyTick(bot, state)).toBe('floating');
    // A constant skill's periodic check is a physical action of a few milliseconds: it must not let go of the water.
    const check = executeAction(bot, 'auto-eat', 1000, () => new Promise(resolve => { release = () => resolve({ success: true, result: 'nothing to eat' }); }),
      { legacyExecutingSkill: false, priority: -1 });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(buoyancyTick(bot, state)).toBeNull();
    expect(bot.controls.jump).toBe(true);
    release(); await check;
  });

  it('keeps floating at the surface, but stands still in shallows and on land', () => {
    const surface = body({ oxygenLevel: 20, entity: { position: new Vec3(0.5, 61.6, 0.5), isInWater: true, onGround: false } });
    expect(buoyancyTick(surface, {})).toBe('floating');
    const shallows = body({ oxygenLevel: 20, entity: { position: new Vec3(0.5, 62, 0.5), isInWater: true, onGround: true } });
    expect(buoyancyTick(shallows, {})).toBeNull();
    expect(shallows.controls.jump).toBeFalsy();
    const land = body({ oxygenLevel: 20, entity: { position: new Vec3(0.5, 64, 0.5), isInWater: false, onGround: true } });
    const state = { floating: true };
    expect(buoyancyTick(land, state)).toBe('released');
    expect(buoyancyTick(land, state)).toBeNull();
  });

  it('does not hide a body trapped under a ceiling from the air reflex', () => {
    const roof = (p: Vec3) => p.y === 54 && Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1
      ? { name: 'stone', boundingBox: 'block' } : { name: p.y > 62 ? 'air' : 'water', boundingBox: 'empty' };
    const bot = body({ blockAt: roof, oxygenLevel: 4 });
    const state = { ...fresh(), floating: false };
    buoyancyTick(bot, state);
    // Steered sideways along the route out from under the roof (level: the next column is roofed at the same height).
    expect(bot.controls.forward).toBe(true);
    breathingReflexTick(bot, state, 0);
    expect(breathingReflexTick(bot, state, 600)).toBe('engaged');
  });
});

describe('the way back to air (paid run L30 drowned pushing at a wall under a ceiling)', () => {
  // A pool open to the air at x<=0, and a roofed, flooded tunnel running east from it at y=60..61.
  const tunnel = (p: Vec3) => {
    if (p.x <= 0) return { name: p.y > 62 ? 'air' : 'water', boundingBox: 'empty' };
    if (p.z === 0 && (p.y === 60 || p.y === 61) && p.x <= 12) return { name: 'water', boundingBox: 'empty' };
    return { name: 'stone', boundingBox: 'block' };
  };

  it('lays a trail from the last breath while the head is under water and starts over in air', () => {
    const bot = body({ blockAt: tunnel, entity: { position: new Vec3(-0.5, 62, 0.5), isInWater: true, onGround: false } });
    recordAirTrail(bot, 0);
    for (let x = 0.5; x <= 8.5; x += 1) { bot.entity.position = new Vec3(x, 60, 0.5); recordAirTrail(bot, x * 500); }
    expect(retraceWaypoint(bot, 10_000)).toMatchObject({ x: 7.5, y: 60, z: 0.5 }); // the point just behind, not a guess at open water
    // Going back: reached points drop off, and no new trail is laid over the old one.
    bot.entity.position = new Vec3(4.5, 60, 0.5);
    recordAirTrail(bot, 10_100);
    expect(retraceWaypoint(bot, 10_200)).toMatchObject({ x: 3.5 }); // the next one toward the air, past the one just reached
    bot.entity.position = new Vec3(0.6, 60.4, 0.5);
    expect(retraceWaypoint(bot, 10_400)).toMatchObject({ x: -0.5, y: 62 }); // the place of the last breath
    bot.entity.position = new Vec3(-0.5, 62, 0.5);
    recordAirTrail(bot, 20_000);
    expect(retraceWaypoint(bot, 20_100)).toMatchObject({ x: -0.5, y: 62 });
  });

  it('offers no way back to a body that was never seen breathing here', () => {
    const bot = body({ blockAt: tunnel, entity: { position: new Vec3(9.5, 60, 0.5), isInWater: true, onGround: false } });
    recordAirTrail(bot, 0);
    bot.entity.position = new Vec3(11.5, 60, 0.5); recordAirTrail(bot, 1000);
    expect(retraceWaypoint(bot, 2000)).toBeNull();
    expect(surfacingPossible(bot)).toBe(false); // roofed, no air the body can swim to within reach, no trail: breaking out is what is left
  });

  it('finds the way to air through the cells the body fits, and none where it does not (paid run L54 swam at a shelf it could not climb onto)', () => {
    // No trail, six cells into the tunnel: the pool is within reach, and the route there is the tunnel itself.
    const near = body({ blockAt: tunnel, oxygenLevel: 12, entity: { position: new Vec3(5.5, 60, 0.5), isInWater: true, onGround: false } });
    const route = swimRouteToAir(near)!;
    expect(route.map(cell => `${cell.x},${cell.y}`)).toEqual(['4.5,60', '3.5,60', '2.5,60', '1.5,60', '0.5,60', '0.5,61', '0.5,62']);
    expect(surfacingPossible(near)).toBe(true);
    expect(secondsToSwimOut(near)).toBeCloseTo(7 / 1.6);
    steerAlongRoute(near, route);
    expect(near.controls).toMatchObject({ forward: true });
    expect(near.looks.at(-1)).toBeCloseTo(Math.PI / 2);          // west, back along the tunnel
    // The same water with too little air for the swim is not a way out.
    expect(surfacingPossible(body({ blockAt: tunnel, oxygenLevel: 0, health: 20, entity: { position: new Vec3(7.5, 60, 0.5), isInWater: true, onGround: false } }))).toBe(false);
    // Under a roof, beside open water whose floor is a shelf one cell higher: air shows above the next column
    // at head height, but a two-cell body under this roof cannot get onto the shelf.
    const shelf = (p: Vec3) => {
      if (p.x >= 0 && p.y === 63) return { name: 'stone', boundingBox: 'block' };                  // the roof
      if (p.x < 0) return p.y <= 61 ? { name: 'stone', boundingBox: 'block' } : { name: p.y >= 63 ? 'air' : 'water', boundingBox: 'empty' };
      if (p.x > 3 || Math.abs(p.z) > 1 || p.y < 60) return { name: 'stone', boundingBox: 'block' };
      return { name: 'water', boundingBox: 'empty' };
    };
    const trapped = body({ blockAt: shelf, oxygenLevel: 12, entity: { position: new Vec3(0.5, 61.2, 0.5), isInWater: true, onGround: false } });
    expect(swimRouteToAir(trapped)).toBeNull();
    expect(surfacingPossible(trapped)).toBe(false);
    // One cell more headroom over the body, and the same shelf is the way out.
    const roomy = (p: Vec3) => (p.x >= 0 && p.y === 63 ? { name: 'water', boundingBox: 'empty' } : p.x >= 0 && p.y === 64 ? { name: 'stone', boundingBox: 'block' } : shelf(p));
    const free = body({ blockAt: roomy, oxygenLevel: 12, entity: { position: new Vec3(0.5, 61.2, 0.5), isInWater: true, onGround: false } });
    expect(swimRouteToAir(free)!.map(cell => `${cell.x},${cell.y}`)).toEqual(['0.5,62', '-0.5,62']);
  });

  it('drops a trail across a teleport, and does not count on one too long for the air that is left', () => {
    const bot = body({ blockAt: tunnel, oxygenLevel: 20, entity: { position: new Vec3(-0.5, 62, 0.5), isInWater: true, onGround: false } });
    recordAirTrail(bot, 0);
    for (let x = 0.5; x <= 11.5; x += 1) { bot.entity.position = new Vec3(x, 60, 0.5); recordAirTrail(bot, x * 500); }
    expect(retraceFeasible(bot)).toBe(true);   // 12m back: about 8s of swimming, 15s of air
    bot.oxygenLevel = 2;
    expect(retraceFeasible(bot)).toBe(false);  // 1.5s of air and a short reserve do not cover it
    bot.oxygenLevel = 20;
    bot.entity.position = new Vec3(9.5, 60, 0.5); // teleported: was at 11.5... a short hop is still the same swim
    recordAirTrail(bot, 20_000);
    expect(retraceFeasible(bot)).toBe(true);
    const far = body({ blockAt: () => ({ name: 'water', boundingBox: 'empty' }), entity: { position: new Vec3(0.5, 70, 0.5), isInWater: false } });
    far.blockAt = (p: Vec3) => ({ name: p.y > 69 ? 'air' : 'water', boundingBox: 'empty' });
    recordAirTrail(far, 0);
    far.blockAt = () => ({ name: 'water', boundingBox: 'empty' });
    far.entity.position = new Vec3(300.5, 40, 0.5); // moved by the server, under water
    recordAirTrail(far, 500);
    expect(retraceWaypoint(far, 1000)).toBeNull();
  });

  it('gets under the middle of a one-block opening before rising through it', () => {
    const bot = body({ entity: { position: new Vec3(48.2, 60, 1.5), isInWater: true, onGround: false } });
    expect(centreInColumn(bot)).toBe(false);
    expect(bot.controls.forward).toBe(true);
    expect(bot.looks[0]).toBeCloseTo(-Math.PI / 2); // east, toward x=48.5
    bot.entity.position = new Vec3(48.45, 60, 1.5);
    expect(centreInColumn(bot)).toBe(true);
    expect(bot.controls.forward).toBe(false);
  });

  it('steers along the trail: forward, up when the point is higher, down when it is lower', () => {
    const bot = body({ blockAt: tunnel, entity: { position: new Vec3(6.5, 60, 0.5), isInWater: true, onGround: false } });
    steerToward(bot, new Vec3(5.5, 60, 0.5));
    expect(bot.controls).toMatchObject({ forward: true, jump: true, sneak: false });
    expect(bot.looks[0]).toBeCloseTo(Math.PI / 2); // west
    steerToward(bot, new Vec3(5.5, 58, 0.5));
    expect(bot.controls).toMatchObject({ jump: false, sneak: true });
  });

  it('counts surfacing as possible under a ceiling while a trail leads back, and as impossible once swimming has stalled', () => {
    const bot = body({ blockAt: tunnel, entity: { position: new Vec3(-0.5, 62, 0.5), isInWater: true, onGround: false } });
    recordAirTrail(bot, 0);
    for (let x = 0.5; x <= 9.5; x += 1) { bot.entity.position = new Vec3(x, 60, 0.5); recordAirTrail(bot, x * 500); }
    bot.oxygenLevel = 12;
    expect(surfacingPossible(bot)).toBe(true);
    expect(surfacingStalled(bot)).toBe(false);
    markSurfacingStalled(bot, 8000);
    expect(surfacingStalled(bot)).toBe(true);
    expect(surfacingPossible(bot)).toBe(false);
    expect(surfacingStalled(bot, Date.now() + 9000)).toBe(false);
  });

  it('remembers where swimming stalled, so a route the body twice failed to follow is not retried on the search\'s word (paid runs L89, L91 drowned between the two reflexes)', () => {
    const bot = body({ blockAt: tunnel, entity: { position: new Vec3(4.5, 60, 0.5), isInWater: true, onGround: false } });
    const now = Date.now();
    expect(surfacingStallsHere(bot, now)).toBe(0);
    markSurfacingStalled(bot, 8000, now);
    markSurfacingStalled(bot, 8000, now + 1500);
    expect(surfacingStallsHere(bot, now + 2000)).toBe(2);
    bot.entity.position = new Vec3(9.5, 60, 0.5);            // somewhere else: a fresh place to try
    expect(surfacingStallsHere(bot, now + 2000)).toBe(0);
    bot.entity.position = new Vec3(4.5, 60, 0.5);
    expect(surfacingStallsHere(bot, now + 40_000)).toBe(0);  // long ago
  });
});

describe('air is a budget for the way out (paid run L50 drowned under an ice sheet with the dig begun too late)', () => {
  // A lake under a sheet of ice at y=62 with air above it, and (while `hole`) one opening at x=0, z=0.
  const lake = (hole: boolean, sheet = 1) => (p: Vec3) => {
    if (p.y >= 62 + sheet) return { name: 'air', boundingBox: 'empty' };
    if (p.y >= 62) return hole && p.x === 0 && p.z === 0 ? { name: 'water', boundingBox: 'empty' } : { name: 'ice', boundingBox: 'block', diggable: true };
    return { name: 'water', boundingBox: 'empty' };
  };
  const under = (overrides: Record<string, unknown> = {}) => body({ blockAt: lake(false), oxygenLevel: 20, digTime: () => 4700,
    entity: { position: new Vec3(6.5, 60.2, 0.5), isInWater: true, onGround: false }, ...overrides });

  it('measures the way through a ceiling by the dig it takes, and refuses one too thick or not diggable', () => {
    expect(secondsToSurface(under())).toBe(Infinity);
    expect(secondsToBreakOut(under())).toBeCloseTo(5.1);          // the water at the head, then 4.7s of ice
    expect(secondsToBreakOut(under({ digTime: undefined }))).toBeCloseTo(5.4); // unmeasured: a cautious default
    expect(secondsToBreakOut(under({ blockAt: lake(false, 4) }))).toBe(Infinity);
    const bedrock = (p: Vec3) => (p.y === 62 ? { name: 'bedrock', boundingBox: 'block', diggable: false } : lake(false)(p));
    expect(secondsToBreakOut(under({ blockAt: bedrock }))).toBe(Infinity);
    expect(secondsToAir(under())).toBeCloseTo(5.1);               // no trail, no open water in reach: through the ice
  });

  it('counts the air as short while it still covers the way out, not at the last quarter', () => {
    expect(airRunningOut(under({ oxygenLevel: 12 }))).toBe(false); // 9s of air for a 5.1s way and a 3s margin
    expect(airRunningOut(under({ oxygenLevel: 10 }))).toBe(true);  // 7.5s: start now
    // Bare hands on the same ice take longer than a whole breath: short from the first moment under it.
    expect(airRunningOut(under({ oxygenLevel: 19, digTime: () => 18_750 }))).toBe(true);
    // No way known at all: nothing to start early for.
    expect(airRunningOut(under({ oxygenLevel: 10, blockAt: lake(false, 4) }))).toBe(false);
    expect(airRunningOut(under({ oxygenLevel: 5, blockAt: lake(false, 4) }))).toBe(true);
  });

  it('forgets the way back when the breath it leads to is no longer there', async () => {
    const bot = under({ blockAt: lake(true), entity: { position: new Vec3(0.5, 61.5, 0.5), isInWater: true, onGround: false } });
    recordAirTrail(bot, 0);                                         // breathing in the hole
    for (let x = 0.5; x <= 6.5; x += 1) { bot.entity.position = new Vec3(x, 60.2, 0.5); recordAirTrail(bot, 500 + x * 500); }
    expect(retraceFeasible(bot)).toBe(true);
    expect(secondsToSwimOut(bot)).toBeLessThan(5);
    expect(surfacingPossible(bot)).toBe(true);
    bot.blockAt = lake(false);                                      // the hole freezes over
    await new Promise(resolve => setTimeout(resolve, 450));         // (the route search is remembered for a moment)
    expect(retraceFeasible(bot)).toBe(false);
    expect(retraceWaypoint(bot, 10_000)).toBeNull();
    expect(secondsToSwimOut(bot)).toBe(Infinity);
    expect(surfacingPossible(bot)).toBe(false);                     // breaking out is what is left
    expect(secondsToAir(bot)).toBeCloseTo(5.1);
  });

  it('keeps the last-resort reflex engaged while the air is still short for the way out', () => {
    const bot = under({ oxygenLevel: 12, digTime: () => 6000 });    // 9s of air, 6.4s to break out
    const state = { ...fresh(), engaged: true };
    expect(breathingReflexTick(bot, state, 0)).toBeNull();
    expect(bot.controls.jump).toBe(true);
    bot.oxygenLevel = 20; bot.blockAt = (p: Vec3) => ({ name: p.y > 62 ? 'air' : 'water', boundingBox: 'empty' });
    expect(breathingReflexTick(bot, state, 100)).toBe('released');
  });

  it('treads water under the ceiling a survival action is breaking, instead of sinking away from it', () => {
    const digging = under({ executingSkill: true });
    const state: { floating?: boolean; holdAfloat?: boolean } = {};
    expect(buoyancyTick(digging, state)).toBeNull();                // an ordinary action keeps its own keys
    expect(digging.controls.jump).toBeFalsy();
    state.holdAfloat = true;
    expect(buoyancyTick(digging, state)).toBe('floating');
    expect(digging.controls.jump).toBe(true);
    state.holdAfloat = false;
    expect(buoyancyTick(digging, state)).toBe('released');
    expect(digging.controls.jump).toBe(false);
  });
});

describe('an idle body goes where the air is, which is not always up (paid run L59 swam up a waterfall into a flooded pocket)', () => {
  // Stone, with a dry tunnel two cells high at y=37..38 for x<=0, and a one-cell shaft of water at x=1 from
  // y=37 up to a closed pocket at y=47 (stone above it). The tunnel's floor cell next to the shaft is dry.
  const shaft = (p: Vec3) => {
    if (p.z !== 0) return { name: 'stone', boundingBox: 'block' };
    if (p.x === 1 && p.y >= 37 && p.y <= 47) return { name: 'water', boundingBox: 'empty' };
    if (p.x <= 0 && p.x >= -4 && (p.y === 37 || p.y === 38)) return { name: 'air', boundingBox: 'empty' };
    return { name: 'stone', boundingBox: 'block' };
  };

  it('steps out of the water into the air beside it instead of rising', () => {
    const bot = body({ blockAt: shaft, oxygenLevel: 20, entity: { position: new Vec3(1.5, 37, 0.5), isInWater: true, onGround: true } });
    const state: { floating?: boolean; steering?: boolean } = {};
    expect(buoyancyTick(bot, state)).toBe('floating');
    expect(bot.controls.forward).toBe(true);
    expect(bot.looks.at(-1)).toBeCloseTo(Math.PI / 2);     // west, into the tunnel
    expect(bot.controls.sneak).toBeFalsy();
    // In the tunnel, head in air and feet on the floor: nothing to hold.
    bot.entity = { position: new Vec3(0.5, 37, 0.5), isInWater: false, onGround: true };
    expect(buoyancyTick(bot, state)).toBe('released');
    expect(bot.controls).toMatchObject({ jump: false, forward: false });
  });

  it('finds the way down a flooded shaft from the pocket at its top', () => {
    const top = body({ blockAt: shaft, oxygenLevel: 12, entity: { position: new Vec3(1.5, 46.2, 0.5), isInWater: true, onGround: false } });
    const route = swimRouteToAir(top)!;
    expect(route.length).toBe(10);
    expect(route.at(-1)).toMatchObject({ x: 0.5, y: 37 });
    const state: { floating?: boolean; steering?: boolean } = {};
    buoyancyTick(top, state);
    expect(top.controls).toMatchObject({ jump: false, sneak: true });   // down, not up
  });

  it('still rises in open water, and treads at the surface', () => {
    const deep = body({ oxygenLevel: 20, entity: { position: new Vec3(0.5, 58, 0.5), isInWater: true, onGround: false } });
    const state: { floating?: boolean; steering?: boolean } = {};
    expect(buoyancyTick(deep, state)).toBe('floating');
    expect(deep.controls.jump).toBe(true);
    expect(deep.controls.sneak).toBeFalsy();
    const surface = body({ oxygenLevel: 20, entity: { position: new Vec3(0.5, 61.6, 0.5), isInWater: true, onGround: false } });
    expect(buoyancyTick(surface, {})).toBe('floating');
    expect(surface.controls.jump).toBe(true);
  });
});

describe('a step sideways is taken at a level the body goes through at (paid run L66 drowned six cells from air, kept against a roof beside a shelf)', () => {
  // A lake under stone. Roof at y=41 over the column the body floats in (x=1); over the next column west
  // (x=0) a shelf one cell lower (y=40), with water under it at y=38 and 39. The way to air goes under the shelf.
  const lake = (p: Vec3) => {
    if (p.y >= 41 || p.y <= 36) return { name: 'stone', boundingBox: 'block' };
    if (p.x === 0 && p.y === 40) return { name: 'andesite', boundingBox: 'block' };
    return { name: 'water', boundingBox: 'empty' };
  };
  const swimmer = (y: number, extra: Record<string, unknown> = {}) => body({ blockAt: lake, oxygenLevel: 12,
    entity: { position: new Vec3(1.5, y, 0.5), isInWater: true, onGround: false }, ...extra });
  const under = [new Vec3(0.5, 38, 0.5), new Vec3(-0.5, 38, 0.5)];

  it('sinks first: floating against the roof, or with its feet in the lower cell but its head still level with the shelf, it does not push at it', () => {
    for (const y of [39.2, 38.79, 38.3, 38.15]) {
      const bot = swimmer(y);
      steerAlongRoute(bot, y > 38.8 ? [new Vec3(1.5, 38, 0.5), ...under] : under);
      expect(bot.controls.jump, `y=${y}`).toBe(false);
      expect(bot.controls.sneak, `y=${y}`).toBe(true);
      // Held in its own column: forward only to come under its middle, which it already is.
      expect(bot.controls.forward ?? false, `y=${y}`).toBe(false);
    }
  });

  it('goes once it fits under, and does not rise out of the level it fits at', () => {
    const bot = swimmer(38.05);
    steerAlongRoute(bot, under);
    expect(bot.controls).toMatchObject({ forward: true, jump: false });
    expect(bot.looks.at(-1)).toBeCloseTo(Math.PI / 2); // west, under the shelf
    // In open water with nothing over the next column the same step is taken at whatever height, rising as it goes.
    const open = body({ oxygenLevel: 12, entity: { position: new Vec3(1.5, 52.6, 0.5), isInWater: true, onGround: false } });
    steerAlongRoute(open, [new Vec3(0.5, 53, 0.5)]);
    expect(open.controls).toMatchObject({ forward: true, jump: true });
  });

  it('a jump another mover queued earlier in the tick is taken back when the body is to sink', () => {
    const bot = swimmer(39.2, { jumpQueued: true });
    bot.controls.jump = true;
    steerAlongRoute(bot, [new Vec3(1.5, 38, 0.5), ...under]);
    expect(bot.controls.jump).toBe(false);
    expect(bot.jumpQueued).toBe(false);
    // Where the steering wants the jump, a queued one stands.
    const rising = body({ oxygenLevel: 12, jumpQueued: true, entity: { position: new Vec3(1.5, 52.6, 0.5), isInWater: true, onGround: false } });
    steerAlongRoute(rising, [new Vec3(1.5, 54, 0.5)]);
    expect(rising.controls.jump).toBe(true);
    expect(rising.jumpQueued).toBe(true);
  });

  it('steers the route on every tick while auto-swim is swimming it, and stays out of it otherwise', () => {
    const swimming = { getSkills: () => [{ skillName: 'auto-swim', priority: 10, isLocked: true, status: true, isSwimmingUp: true }] };
    const air = (p: Vec3) => (p.x === -3 && p.y >= 39 && p.y <= 40 ? { name: 'air', boundingBox: 'empty' } : lake(p));
    const bot = swimmer(39.2, { blockAt: air, constantSkills: swimming, jumpQueued: true });
    bot.controls.jump = true; // what a path still being walked pressed earlier in the tick
    expect(steerSwimmingRoute(bot)).toBe(true);
    expect(bot.controls).toMatchObject({ jump: false, sneak: true });
    expect(bot.jumpQueued).toBe(false);
    const idle = swimmer(39.2, { blockAt: air });
    idle.controls.jump = true;
    expect(steerSwimmingRoute(idle)).toBe(false);
    expect(idle.controls.jump).toBe(true);
  });
});

