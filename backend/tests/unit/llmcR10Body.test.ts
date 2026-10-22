import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

// r10 (2026-10-22, run 34): the body's fixes.
// B1: a piglin with a crossbow, 5.9 to 7 m off, in sight of a body in a rock tunnel, hit it six times in 14 s (20 to 11.3) and no reflex
//     moved: the cover was for a burning body only. It now starts when the body was shot twice in 5 s, with the same one minimal hand.
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/digBlockVerified.js')>();
  return { ...actual, digBlockVerified: vi.fn(async (bot: any, block: any) => {
    const p = block.position;
    bot.__dug.push(`${p.x},${p.y},${p.z}`);
    bot.__blocks.set(`${p.x},${p.y},${p.z}`, { name: 'air', boundingBox: 'empty' });
    const at = bot.entity.position;
    if (p.x === Math.floor(at.x) && p.z === Math.floor(at.z) && p.y === Math.floor(at.y) - 1) bot.entity.position = new Vec3(at.x, p.y, at.z);
    return { stateId: 0, blockName: 'air' };
  }) };
});
vi.mock('../../src/services/minebot/utils/setMovements.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/setMovements.js')>();
  return { ...actual, buildMovements: (bot: any, ...rest: any[]) => bot.__fakeMovements ? { getBlock: () => null, getNeighbors: () => [], exclusionAreasBreak: [] } : (actual.buildMovements as any)(bot, ...rest) };
});

const reflexes: any = await import('../../src/services/minebot/utils/floorReflexes.js');
const { floorConfig } = await import('../../src/services/minebot/utils/floorConfig.js');
const { ensureReflexLedger } = await import('../../src/services/minebot/utils/reflexLedger.js');
const { seesBodyAt } = await import('../../src/services/minebot/utils/threatExposure.js');
const { bodyReader } = await import('../../src/services/minebot/utils/localMap.js');

type Cell = { name: string; boundingBox: string; diggable?: boolean; hardness?: number };
const STONE: Cell = { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5 }, AIR: Cell = { name: 'air', boundingBox: 'empty' };
const BEDROCK: Cell = { name: 'bedrock', boundingBox: 'block', diggable: false };
const COBBLE = { name: 'cobblestone', type: 1, count: 16 };

const mob = (id: number, name: string, x: number, y: number, z: number, height = 1.95) => ({ id, name, type: 'hostile', height, width: 0.6, position: new Vec3(x, y, z) });
/** Distance from a point to a segment. */
function toSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = b.minus(a), t = Math.max(0, Math.min(1, p.minus(a).dot(ab) / ab.dot(ab)));
  return p.distanceTo(a.plus(ab.scaled(t)));
}
/**
 * Run 34's tunnel, as far as it is known: stone round a tunnel along x at z 0 (y 56 and 57, x -8 to 8), the body in it at (0.5, 56, 0.5), and a
 * cavity open to the tunnel along the line to a piglin that stands up and off to the side (a window in the rock, about two cells wide).
 */
function tunnelWith(piglin: Vec3) {
  const eyes = piglin.offset(0, 1.95 * 0.85, 0), body = new Vec3(0.5, 56 + 1.62, 0.5);
  return (x: number, y: number, z: number): Cell => {
    if (z === 0 && y >= 56 && y <= 57 && x >= -8 && x <= 8) return AIR;
    if (Math.abs(x - Math.floor(piglin.x)) <= 1 && Math.abs(z - Math.floor(piglin.z)) <= 1 && y >= Math.floor(piglin.y) && y <= Math.floor(piglin.y) + 2) return AIR;
    return toSegment(new Vec3(x + 0.5, y + 0.5, z + 0.5), body, eyes) <= 0.95 ? AIR : STONE;
  };
}

/** A fake body that is not burning, with a protocol client that can say what hit it. */
function shotBody(shape: (x: number, y: number, z: number) => Cell, options: { feet?: Vec3; health?: number; items?: any[]; mobs?: Record<string, any>; now?: () => number; client?: boolean } = {}) {
  const blocks = new Map<string, Cell>();
  const bot: any = Object.assign(new EventEmitter(), {
    __blocks: blocks, __dug: [] as string[], __fakeMovements: true, __placed: [] as string[],
    entity: { id: 1, name: 'player', position: options.feet ?? new Vec3(0.5, 56, 0.5), yaw: 0, pitch: 0, onGround: true, metadata: [0] },
    health: options.health ?? 20, food: 17, game: { dimension: 'the_nether' }, llmCentric: true,
    entities: options.mobs ?? {},
    registry: { blocksByName: { cobblestone: { id: 1 }, stone: { id: 2 } }, entitiesByName: { piglin: { type: 'hostile' }, zombie: { type: 'hostile' } }, itemsByName: {}, items: {} },
    heldItem: null, inventory: { items: () => options.items ?? [], slots: new Array(46).fill(null) }, controlState: {} as Record<string, boolean>,
    executingSkill: false, interruptExecution: false, clearControlStates: vi.fn(), look: vi.fn(async () => undefined), lookAt: vi.fn(async () => undefined),
    equip: vi.fn(async (item: any) => { bot.heldItem = item; }), consume: vi.fn(async () => undefined), attack: vi.fn(), setControlState: vi.fn(), stopDigging: () => undefined,
    placeBlock: vi.fn(async (reference: any, face: Vec3) => { const at = reference.position.plus(face); bot.__placed.push(`${at.x},${at.y},${at.z}`); blocks.set(`${at.x},${at.y},${at.z}`, { name: 'cobblestone', boundingBox: 'block' }); }),
    blockAt: (position: Vec3) => {
      const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
      return { diggable: true, hardness: 1.5, ...(blocks.get(`${x},${y},${z}`) ?? shape(x, y, z)), position: new Vec3(x, y, z) };
    },
  });
  if (options.client !== false) bot._client = new EventEmitter();
  bot.pathfinder = { movements: null, setMovements(m: unknown) { this.movements = m; }, stop: () => undefined, setGoal: () => undefined,
    goto: vi.fn(async (goal: any) => { bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); }) };
  const ledger = ensureReflexLedger(bot);
  reflexes.installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1, now: options.now });
  return { bot, ledger };
}
const tick = (bot: EventEmitter) => bot.emit('physicsTick');
const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
/** The server says a projectile of `shooter` (entity id) hit the body, and health falls by 1.9 (run 34: five hits of 1.9 and one of 1.4). */
function shotBy(bot: any, shooter: number, damage = 1.9) {
  bot.health -= damage;
  bot._client?.emit('damage_event', { entityId: 1, sourceTypeId: 90, sourceCauseId: shooter + 1, sourceDirectId: 9000 + shooter, sourcePosition: null });
}
const covers = (ledger: ReturnType<typeof ensureReflexLedger>) => ledger.entriesSince(-1).filter(entry => entry.kind === 'cover' || entry.kind === 'cover_none');
async function quiet(bot: any, clock: { at: number }, rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    clock.at += 300; tick(bot);
    await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 6000, interval: 5 });
    await settle(5);
  }
}
const sees = (bot: any, shooter: any) => seesBodyAt(bot, shooter, bot.entity.position, (x, y, z) => { const block = bodyReader(bot)(x, y, z); return !block || block.solid === true; });

describe('B1: shot at from afar (run 34 +488 to +502: a piglin\'s crossbow at 5.9 to 7 m, six hits in 14 s, no reflex)', () => {
  const piglinAt = new Vec3(4.5, 59, -3.5);
  const scene = () => {
    const clock = { at: 20_000_000 };
    const piglin = mob(848, 'piglin', piglinAt.x, piglinAt.y, piglinAt.z);
    const made = shotBody(tunnelWith(piglinAt), { mobs: { 848: piglin }, items: [COBBLE], now: () => clock.at });
    made.bot.heldItem = COBBLE;
    return { ...made, clock, piglin };
  };

  it('the scene: the piglin is 6.4 m off and sees the body in the tunnel', () => {
    const { bot, piglin } = scene();
    expect(bot.entity.position.distanceTo(piglin.position)).toBeGreaterThan(5.9);
    expect(bot.entity.position.distanceTo(piglin.position)).toBeLessThan(7);
    expect(sees(bot, piglin)).toBe(true);
  });

  it('two hits of its bolts in 5 s: one hand that cuts the line, told with the shooter and that the line is cut', async () => {
    const { bot, ledger, clock, piglin } = scene();
    tick(bot);
    clock.at += 1000; shotBy(bot, 848); tick(bot);
    await settle(30);
    // One hit is not yet a reflex.
    expect(covers(ledger)).toHaveLength(0);
    clock.at += 2500; shotBy(bot, 848); tick(bot);
    await vi.waitFor(() => expect(covers(ledger)).toHaveLength(1), { timeout: 4000, interval: 5 });
    await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 4000, interval: 5 });
    const [line] = covers(ledger);
    console.log('[r10 cover step]', line.detail);
    expect(line).toMatchObject({ kind: 'cover', outcome: 'done' });
    expect(line.detail).toMatch(/^piglin #848 上3・6\.\dm に5秒で2回撃たれた: .+。射線が切れた 体力16\.2$/u);
    expect(sees(bot, piglin)).toBe(false);
    // Out of the line: no more hands.
    await quiet(bot, clock, 4);
    expect(covers(ledger)).toHaveLength(1);
  });

  it('a hit with no shooter behind it (the cause is the direct entity: a blow; or none: fire, a fall) is no shot', async () => {
    const { bot, ledger, clock } = scene();
    tick(bot);
    for (let i = 0; i < 3; i++) {
      clock.at += 500; bot.health -= 1.9;
      bot._client.emit('damage_event', { entityId: 1, sourceTypeId: 1, sourceCauseId: i % 2 ? 0 : 849, sourceDirectId: i % 2 ? 0 : 849 });
      tick(bot);
    }
    await quiet(bot, clock, 3);
    expect(covers(ledger)).toHaveLength(0);
    expect(reflexes.projectileShooter({ sourceCauseId: 849, sourceDirectId: 849 })).toBeNull();
    expect(reflexes.projectileShooter({ sourceCauseId: 0, sourceDirectId: 0 })).toBeNull();
    expect(reflexes.projectileShooter({ sourceCauseId: 849, sourceDirectId: 9848 })).toBe(848);
  });

  it('two hits more than 5 s apart: nothing', async () => {
    const { bot, ledger, clock } = scene();
    tick(bot);
    clock.at += 1000; shotBy(bot, 848); tick(bot);
    clock.at += 6000; shotBy(bot, 848); tick(bot);
    await quiet(bot, clock, 2);
    expect(covers(ledger)).toHaveLength(0);
  });

  it('a kind the planner fights by choice (an engagement) is left alone above the flee\'s health', async () => {
    const { bot, ledger, clock } = scene();
    bot.engagements = [{ kinds: ['piglin'] }];
    tick(bot);
    clock.at += 500; shotBy(bot, 848); tick(bot);
    clock.at += 500; shotBy(bot, 848); tick(bot);
    await quiet(bot, clock, 3);
    expect(covers(ledger)).toHaveLength(0);
  });

  it('a server that names nothing (no damage packet): two falls in health with a shooter seeing the body out of a blow\'s reach are shots; a zombie at its elbow is not', async () => {
    const clock = { at: 21_000_000 };
    const piglin = mob(848, 'piglin', piglinAt.x, piglinAt.y, piglinAt.z);
    const { bot, ledger } = shotBody(tunnelWith(piglinAt), { mobs: { 848: piglin }, items: [COBBLE], now: () => clock.at, client: false });
    bot.heldItem = COBBLE;
    tick(bot);
    for (let i = 0; i < 2; i++) { clock.at += 600; bot.health -= 1.9; tick(bot); }
    clock.at += 300; tick(bot);
    await vi.waitFor(() => expect(covers(ledger).length).toBeGreaterThanOrEqual(1), { timeout: 4000, interval: 5 });
    expect(covers(ledger)[0].detail).toContain('piglin #848');
    // The same two falls with a zombie within a blow's reach: a melee enemy hurt the body, not the bolts.
    const other = { at: 22_000_000 };
    const withZombie = shotBody(tunnelWith(piglinAt), { mobs: { 848: mob(848, 'piglin', piglinAt.x, piglinAt.y, piglinAt.z), 5: mob(5, 'zombie', 1.5, 56, 0.5, 1.95) }, items: [COBBLE], now: () => other.at, client: false });
    tick(withZombie.bot);
    for (let i = 0; i < 2; i++) { other.at += 600; withZombie.bot.health -= 1.9; tick(withZombie.bot); }
    other.at += 300; tick(withZombie.bot);
    await settle(60);
    expect(covers(withZombie.ledger)).toHaveLength(0);
  });

  it('an act running stops as a reflex, and its stoppedWhy says who shot and that the line is cut', async () => {
    const { runAct, ACT_HANDS } = await import('../../src/services/minebot/instantSkills/act.js');
    const { bot, clock } = scene();
    const acting = runAct(bot, ACT_HANDS.parse([{ do: 'wait', seconds: 5 }, { do: 'jump' }]), undefined, undefined, { tickMs: 20 });
    await settle(60);
    tick(bot);
    clock.at += 500; shotBy(bot, 848); tick(bot);
    clock.at += 500; shotBy(bot, 848); tick(bot);
    const json = JSON.parse((await acting).result);
    console.log('[r10 act stoppedWhy]', json.stoppedWhy);
    expect(json).toMatchObject({ ok: false, stoppedBy: 'reflex' });
    expect(json.stoppedWhy).toMatch(/^piglin #848 .+に5秒で2回撃たれた: .+。射線が切れた/u);
  });
});

describe('B1: the line hand (a block on the shooters\' line when no step, no seal over the head and no dig is to be had)', () => {
  // A corridor along z at x 0 (y 64 and 65, z -8 to 8), the floor under the body bedrock (no dig), nothing to step into, stone over the head.
  const level = (x: number, y: number, z: number): Cell => (x === 0 && (y === 64 || y === 65) && z >= -8 && z <= 8 ? AIR : (y === 63 && x === 0 && z === 0 ? BEDROCK : STONE));
  // The same with a pit at the far end, the piglin in it a little lower than the body (eyes 64.57): its eye line and its chest line run through different cells for the first 4 m.
  const pit = (x: number, y: number, z: number): Cell => (x === 0 && (y === 62 || y === 63) && z >= 5 && z <= 8 ? AIR : level(x, y, z));
  const scene = (shape: typeof level, piglin: ReturnType<typeof mob>, items: any[] = [COBBLE]) => {
    const clock = { at: 23_000_000 };
    const made = shotBody(shape, { feet: new Vec3(0.5, 64, 0.5), mobs: { [piglin.id]: piglin }, items, now: () => clock.at });
    made.bot.heldItem = items[0] ?? null;
    tick(made.bot);
    clock.at += 500; shotBy(made.bot, piglin.id); tick(made.bot);
    clock.at += 500; shotBy(made.bot, piglin.id); tick(made.bot);
    return { ...made, clock, piglin };
  };

  it('level with the body, down a corridor: one block on the line (the cell next to the body) closes both sight lines', async () => {
    const { bot, ledger, clock, piglin } = scene(level, mob(70, 'piglin', 0.5, 64, 7.5));
    await quiet(bot, clock, 6);
    expect(bot.__dug).toEqual([]);
    expect(bot.__placed).toHaveLength(1);
    const lines = covers(ledger).map(entry => entry.detail);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^piglin #70 7\.0m に5秒で2回撃たれた: 線上の \(0,65,1\) を cobblestone で塞いだ。射線が切れた 体力16\.2$/u);
    expect(sees(bot, piglin)).toBe(false);
  });

  it('a piglin lower than the body: one block closes one of the two sight lines, the next hand the other (the second is the line cut)', async () => {
    const { bot, ledger, clock, piglin } = scene(pit, mob(71, 'piglin', 0.5, 62.9, 7.5));
    expect(sees(bot, piglin)).toBe(true);
    await quiet(bot, clock, 8);
    const lines = covers(ledger).map(entry => entry.detail);
    console.log('[r10 cover line x2]', JSON.stringify(lines));
    expect(bot.__dug).toEqual([]);
    expect(bot.__placed).toHaveLength(2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/線上の \(0,6[45],[12]\) を cobblestone で塞いだ（見える線 2→1）。まだ見えている: piglin #71 下1・/u);
    expect(lines[1]).toMatch(/線上の \(0,6[45],[12]\) を cobblestone で塞いだ。射線が切れた/u);
    expect(sees(bot, piglin)).toBe(false);
  });

  it('no block to put: the facts of why no hand is made are told once, not a plan', async () => {
    const { bot, ledger, clock } = scene(level, mob(70, 'piglin', 0.5, 64, 7.5), []);
    await quiet(bot, clock, 4);
    const told = covers(ledger);
    console.log('[r10 cover none]', told[0]?.detail);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ kind: 'cover_none', outcome: 'failed' });
    expect(told[0].detail).toContain('動ける手が無い');
    expect(told[0].detail).toContain('置くブロックを持っていない');
  });

  it('an open floor: the blocks go in one hand at a time, never more than four in an episode', async () => {
    const open = (x: number, y: number, z: number): Cell => (y >= 64 && y <= 70 && Math.abs(x) <= 12 && Math.abs(z) <= 12 ? AIR : STONE);
    const { bot, ledger, clock } = scene(open as typeof level, mob(72, 'piglin', 6.5, 64, 0.5));
    await quiet(bot, clock, 10);
    expect(bot.__placed.length).toBeLessThanOrEqual(4);
    expect(covers(ledger).length).toBeGreaterThan(0);
  });
});

