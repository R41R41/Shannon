import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

// Run 6 (11/11 07:14 JST): from a one-wide water pit the body set a bed into a cave pocket behind two blocks of rock (the server takes a place
// across rock), looked for "its" bed within three blocks of its feet cell (3.3 away: not found), stopped with not_slept, and the bed stayed
// where it was for the rest of the run. A bed is set down from a stand that is in sleep range, in reach and in sight; it is looked for at its
// cell; a bed that was set down and not slept in goes back into the pack.

vi.mock('../../src/services/minebot/execution/observedWait.js', async (original) => ({
  ...(await original() as object), actionDelay: vi.fn(async () => {}),
}));
vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: vi.fn(async () => ({ success: true })) }));

const { gotoSafe } = await import('../../src/services/minebot/utils/gotoSafe.js');
const { default: SleepInBed, noteBedSpotFailed } = await import('../../src/services/minebot/instantSkills/sleepInBed.js');

const SOLID = new Set(['stone', 'crafting_table', 'oak_door']);
type Fill = (x: number, y: number, z: number) => string;
function world(fill: Fill) {
  const placed = new Map<string, string>();
  const blockAt = (position: Vec3) => {
    const p = position.floored();
    const name = placed.get(`${p.x},${p.y},${p.z}`) ?? fill(p.x, p.y, p.z);
    return { name, boundingBox: SOLID.has(name) || name.endsWith('_bed') ? 'block' : 'empty', diggable: true, position: p };
  };
  return { blockAt, placed };
}

/** A body at `position`, one bed in the pack, night. A placed bed shows up in the world at the cell it was placed on. */
function sleeper(w: ReturnType<typeof world>, position: Vec3, patch: Record<string, unknown> = {}) {
  const inventory: Array<{ name: string; count: number }> = [{ name: 'white_bed', count: 1 }];
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position, yaw: 0 }, entities: {}, time: { timeOfDay: 15_000 }, game: { dimension: 'minecraft:overworld' }, isSleeping: false,
    isABed: (b: any) => String(b?.name).endsWith('_bed'),
    // The library's own search finds nothing: the bed has to be found at its cell.
    findBlock: vi.fn(() => null), findBlocks: vi.fn(() => []),
    blockAt: w.blockAt, inventory: { items: () => inventory }, equip: vi.fn(async () => {}), lookAt: vi.fn(async () => {}), pathfinder: { stop: () => {} },
    placeBlock: vi.fn(async (reference: any, face: Vec3) => {
      const cell = reference.position.plus(face);
      w.placed.set(`${cell.x},${cell.y},${cell.z}`, 'white_bed');
      inventory.length = 0;
    }),
    sleep: vi.fn(async () => { setTimeout(() => bot.emit('wake'), 5); }),
    ...patch,
  });
  const skill: any = new SleepInBed(bot);
  const calls: string[] = [];
  skill.callSkill = vi.fn(async (name: string, ...args: any[]) => {
    calls.push(`${name}:${args.slice(0, 3).join(',')}`);
    if (name === 'dig-block-at') { w.placed.set(`${args[0]},${args[1]},${args[2]}`, 'air'); inventory.push({ name: 'white_bed', count: 1 }); return { success: true, result: 'dug' }; }
    return { success: false };
  });
  return { bot, skill, calls, inventory };
}

const cellKey = (cell: Vec3) => `${cell.x},${cell.y},${cell.z}`;

describe('a bed is set down only where it can be seen and slept in (run 6)', () => {
  // The run-6 layout: a closet (the body's two cells), rock all round it, and a pocket three blocks east behind two blocks of rock.
  const X = 5000;
  const closet = (wall: boolean): Fill => (x, y, z) => {
    if (y <= 22) return 'stone';
    if (x === X && z === -112 && (y === 23 || y === 24)) return 'air';
    const pocket = x >= X + 3 && x <= X + 9 && z >= -115 && z <= -109 && y >= 23 && y <= 26;
    const opened = !wall && x >= X + 1 && x <= X + 2 && z === -112 && (y === 23 || y === 24);
    return pocket || opened ? 'air' : 'stone';
  };
  const body = new Vec3(X + 0.5, 23, -111.5);

  it('a pocket behind two blocks of rock is not a spot; the same pocket with the rock opened is', () => {
    const shut = new SleepInBed({ entity: { position: body }, blockAt: world(closet(true)).blockAt } as any);
    expect(shut.findPlaceForBed()).toBeNull();
    expect(shut.findWiderPlaceForBed()).toBeNull();
    const open = new SleepInBed({ entity: { position: body }, blockAt: world(closet(false)).blockAt } as any);
    const spot = open.findPlaceForBed();
    expect(spot).not.toBeNull();
    expect(Math.abs(spot!.x - X)).toBeLessThanOrEqual(2);
  });

  it('with no spot it says so with the failure type, does not set the bed down and keeps it', async () => {
    const w = world(closet(true));
    const { bot, skill, inventory } = sleeper(w, body);
    const result = await skill.runImpl(false, false, { leaveIfNight: true, noDig: true });
    expect(result).toMatchObject({ success: false, failureType: 'no_bed_spot', recoverable: true });
    expect(bot.placeBlock).not.toHaveBeenCalled();
    expect(inventory).toHaveLength(1);
  });

  it('a body in a water pit has no stand: no bed is set down, and the words say the water', async () => {
    const X2 = 6000;
    // A one-wide pit of water two high, stone round it, open ground above it.
    const pit: Fill = (x, y, z) => {
      if (y <= 62) return 'stone';
      if (y >= 66) return 'air';
      return x === X2 && z === 0 ? (y === 63 ? 'stone' : 'water') : 'stone';
    };
    const w = world(pit);
    const { bot, skill, inventory } = sleeper(w, new Vec3(X2 + 0.5, 64, 0.5));
    const result = await skill.runImpl(false, false, { leaveIfNight: true, noDig: true });
    expect(result).toMatchObject({ success: false, failureType: 'no_bed_spot' });
    expect(result.result).toContain('水');
    expect(bot.placeBlock).not.toHaveBeenCalled();
    expect(inventory).toHaveLength(1);
  });
});

describe('the bed set down is found at its cell, and the body stands where it can be used', () => {
  const flat = (x0: number): Fill => (x, y) => (y <= 63 ? 'stone' : x >= x0 - 30 ? 'air' : 'stone');

  it('a bed the library search does not find (findBlock empty, as for a spot 3.3 from the feet cell) is still found, slept in and taken back', async () => {
    const w = world(flat(7000));
    const { bot, skill, calls, inventory } = sleeper(w, new Vec3(7000.5, 64, 0.5));
    const result = await skill.runImpl(false, false, { leaveIfNight: true, noDig: true });
    expect(result).toMatchObject({ success: true });
    expect(result.result).toContain('ベッドは拾い直しました');
    expect(bot.placeBlock).toHaveBeenCalledTimes(1);
    expect(bot.sleep).toHaveBeenCalledTimes(1);
    const [bed] = bot.sleep.mock.calls[0];
    expect(String(bed.name)).toBe('white_bed');
    expect(calls.some(call => call.startsWith('dig-block-at:'))).toBe(true);
    expect(inventory).toHaveLength(1);
  });

  it('a stand one or two steps off is walked to (a GoalBlock) before the bed is set down, and the bed is set down from there', async () => {
    const X = 8000;
    const w = world(flat(X));
    // Every spot that can be seen from the cell the body is in has failed lately: the next stand has to be a step off.
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (const y of [63, 64, 65]) noteBedSpotFailed(new Vec3(X + x, y, z));
    const start = new Vec3(X + 0.5, 64, 0.5);
    const { bot, skill } = sleeper(w, start);
    vi.mocked(gotoSafe).mockClear();
    vi.mocked(gotoSafe).mockImplementation((async (_bot: any, goal: any) => {
      bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
      return { success: true };
    }) as any);
    const result = await skill.runImpl(false, false, { leaveIfNight: true, noDig: true });
    expect(vi.mocked(gotoSafe)).toHaveBeenCalled();
    const goal: any = vi.mocked(gotoSafe).mock.calls[0][1];
    expect(goal.constructor.name).toBe('GoalBlock');
    expect(Math.abs(goal.x - X) + Math.abs(goal.z)).toBeGreaterThanOrEqual(1);
    expect(result.success === true || result.failureType === 'no_bed_spot').toBe(true);
    if (result.success) {
      // Placed from where the walk ended: the foot cell is within the sleep range of it.
      const reference = bot.placeBlock.mock.calls[0][0].position as Vec3;
      expect(Math.abs(reference.x + 0.5 - bot.entity.position.x)).toBeLessThanOrEqual(2.5);
      expect(Math.abs(reference.z + 0.5 - bot.entity.position.z)).toBeLessThanOrEqual(2.5);
    }
    vi.mocked(gotoSafe).mockImplementation((async () => ({ success: true })) as any);
  });

  it('a walk that did not arrive marks the spot and ends in no_bed_spot after three tries, with the bed kept', async () => {
    const X = 9000;
    const w = world(flat(X));
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (const y of [63, 64, 65]) noteBedSpotFailed(new Vec3(X + x, y, z));
    const { bot, skill, inventory } = sleeper(w, new Vec3(X + 0.5, 64, 0.5));
    vi.mocked(gotoSafe).mockClear();
    vi.mocked(gotoSafe).mockImplementation((async () => ({ success: false, error: 'no path' })) as any);
    const result = await skill.runImpl(false, false, { leaveIfNight: true, noDig: true });
    vi.mocked(gotoSafe).mockImplementation((async () => ({ success: true })) as any);
    expect(result).toMatchObject({ success: false, failureType: 'no_bed_spot' });
    expect(vi.mocked(gotoSafe).mock.calls.length).toBeLessThanOrEqual(3);
    expect(bot.placeBlock).not.toHaveBeenCalled();
    expect(inventory).toHaveLength(1);
  });

  it('a stand a walk did not reach is not walked to twice (review: three 15 s walks to the same cell)', async () => {
    const X = 9500;
    const w = world(flat(X));
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (const y of [63, 64, 65]) noteBedSpotFailed(new Vec3(X + x, y, z));
    const { skill } = sleeper(w, new Vec3(X + 0.5, 64, 0.5));
    vi.mocked(gotoSafe).mockClear();
    vi.mocked(gotoSafe).mockImplementation((async () => ({ success: false, error: 'no path' })) as any);
    await skill.runImpl(false, false, { leaveIfNight: true, noDig: true });
    vi.mocked(gotoSafe).mockImplementation((async () => ({ success: true })) as any);
    const goals = vi.mocked(gotoSafe).mock.calls.map(call => { const g: any = call[1]; return `${g.x},${g.y},${g.z}`; });
    expect(goals.length).toBeGreaterThan(0);
    expect(new Set(goals).size).toBe(goals.length);
  });

  it('a bed that stands beside the cell is not taken for the one set down (a village row): not slept in, not dug up', async () => {
    const w = world(flat(9800));
    const { bot, skill, calls } = sleeper(w, new Vec3(9800.5, 64, 0.5));
    bot.placeBlock = vi.fn(async (reference: any, face: Vec3) => {
      const cell = reference.position.plus(face);
      // The place did not come (no answer), and another bed stands next to the cell it was meant for.
      bot.findBlock = vi.fn(() => ({ name: 'red_bed', position: cell.offset(1, 0, 0) }));
      throw new Error('placeBlock did not answer within 1500ms');
    });
    const result = await skill.runImpl(false, false, { leaveIfNight: true, noDig: true });
    expect(result.success).toBe(false);
    expect(bot.sleep).not.toHaveBeenCalled();
    expect(calls.some(call => call.startsWith('dig-block-at:'))).toBe(false);
  });

  it('a sleep that fails after the place (too far) takes the bed back into the pack and says so', async () => {
    const w = world(flat(10_000));
    const { bot, skill, calls, inventory } = sleeper(w, new Vec3(10_000.5, 64, 0.5), {
      sleep: vi.fn(async () => { throw new Error('server refused: ベッドが遠すぎます'); }),
    });
    const result = await skill.runImpl(false, false, { leaveIfNight: true, noDig: true });
    expect(result.success).toBe(false);
    expect(result.result).toContain('ベッドが遠すぎます');
    expect(result.result).toContain('拾い直した');
    expect(calls.some(call => call.startsWith('dig-block-at:'))).toBe(true);
    expect(inventory).toHaveLength(1);
    expect(bot.placeBlock).toHaveBeenCalledTimes(1);
  });

  it('with an enemy near after the failure the bed is left and its cell is said', async () => {
    const w = world(flat(11_000));
    const { bot, skill, calls } = sleeper(w, new Vec3(11_000.5, 64, 0.5), {
      sleep: vi.fn(async () => { throw new Error('server refused: ベッドが遠すぎます'); }),
      registry: { entitiesByName: { zombie: { type: 'hostile' } } },
    });
    // The enemy comes after the bed is down (the first checks of the hand pass).
    bot.placeBlock = vi.fn(async (reference: any, face: Vec3) => {
      const cell = reference.position.plus(face);
      w.placed.set(`${cell.x},${cell.y},${cell.z}`, 'white_bed');
      bot.entities = { 9: { name: 'zombie', type: 'hostile', position: new Vec3(11_003.5, 64, 0.5) } };
    });
    const result = await skill.runImpl(false, false, { leaveIfNight: true, noDig: true });
    expect(result.success).toBe(false);
    expect(result.result).toContain('そのままにした');
    expect(calls.some(call => call.startsWith('dig-block-at:'))).toBe(false);
  });
});

describe('a bed that is already there is slept in from a stand that sees it', () => {
  // A rock wall two thick across every z at x+1..x+2 (no way round), a bed behind it to the east and one in the open to the west.
  const X = 12_000;
  const wall: Fill = (x, y) => {
    if (y <= 63) return 'stone';
    if (x >= X + 1 && x <= X + 2) return 'stone';
    return 'air';
  };
  const withBeds = (cells: Vec3[]) => {
    const w = world(wall);
    for (const cell of cells) w.placed.set(cellKey(cell), 'red_bed');
    return w;
  };
  const eastBed = [new Vec3(X + 3, 64, 0), new Vec3(X + 4, 64, 0)];
  const westBed = [new Vec3(X - 2, 64, 0), new Vec3(X - 3, 64, 0)];

  it('the bed behind rock is skipped for the one that can be reached', async () => {
    const w = withBeds([...eastBed, ...westBed]);
    const { bot, skill } = sleeper(w, new Vec3(X + 0.5, 64, 0.5));
    bot.findBlocks = vi.fn(() => [eastBed[0], westBed[0]]);
    bot.inventory = { items: () => [] };
    const result = await skill.runImpl(false, false, { leaveIfNight: true, noDig: true });
    expect(result).toMatchObject({ success: true });
    expect(bot.sleep).toHaveBeenCalledTimes(1);
    expect(cellKey(bot.sleep.mock.calls[0][0].position)).toBe(cellKey(westBed[0]));
  });

  it('a bed inside a house behind a door is walked to: the door is a way in, not a wall (review)', async () => {
    const door: Fill = (x, y, z) => {
      if (y <= 63) return 'stone';
      if (x === X + 1) return z === 0 && (y === 64 || y === 65) ? 'oak_door' : 'stone';
      return 'air';
    };
    const w = world(door);
    for (const cell of eastBed) w.placed.set(cellKey(cell), 'red_bed');
    const { bot, skill } = sleeper(w, new Vec3(X + 0.5, 64, 0.5));
    bot.findBlocks = vi.fn(() => [eastBed[0]]);
    bot.inventory = { items: () => [] };
    vi.mocked(gotoSafe).mockClear();
    vi.mocked(gotoSafe).mockImplementation((async (_bot: any, goal: any) => {
      bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
      return { success: true };
    }) as any);
    const result = await skill.runImpl(false, false, { leaveIfNight: true, noDig: true });
    vi.mocked(gotoSafe).mockImplementation((async () => ({ success: true })) as any);
    expect(result).toMatchObject({ success: true });
    expect(vi.mocked(gotoSafe)).toHaveBeenCalled();
    expect(bot.sleep).toHaveBeenCalledTimes(1);
  });

  it('with only the bed behind rock it says which block is between, and does not walk into the wall', async () => {
    const w = withBeds(eastBed);
    const { bot, skill } = sleeper(w, new Vec3(X + 0.5, 64, 0.5));
    bot.findBlocks = vi.fn(() => [eastBed[0]]);
    bot.inventory = { items: () => [] };
    vi.mocked(gotoSafe).mockClear();
    const result = await skill.runImpl(false, false, { leaveIfNight: true, noDig: true });
    expect(result).toMatchObject({ success: false, failureType: 'no_bed_spot' });
    expect(result.result).toContain(`ベッド (${X + 3},64,0)`);
    expect(result.result).toContain('stone(');
    expect(bot.sleep).not.toHaveBeenCalled();
    expect(vi.mocked(gotoSafe)).not.toHaveBeenCalled();
  });

  it('with the bed behind rock and one in the pack, the carried bed is set down instead', async () => {
    const w = withBeds(eastBed);
    const { bot, skill } = sleeper(w, new Vec3(X + 0.5, 64, 0.5));
    bot.findBlocks = vi.fn(() => [eastBed[0]]);
    const result = await skill.runImpl(false, false, { leaveIfNight: true, noDig: true });
    expect(result.success).toBe(true);
    expect(bot.placeBlock).toHaveBeenCalledTimes(1);
    const placedAt = bot.placeBlock.mock.calls[0][0].position as Vec3;
    expect(placedAt.x).toBeLessThanOrEqual(X + 1);
  });
});
