import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

// mb-llmc-cand 4 (2026-10-23 night, run 37): chapter 4's facts that misled the model.
//   1. walk 229,-54,196 (a lit nether portal's cell, obsidian under it) stopped "そのものには立てない（足のマスが nether_portal）": a portal is
//      entered, as the walk's target, and a dimension change is the arrival;
//   2. `inside: 村の中` at y -54, 118 blocks under the village;
//   3. `oxygen: 400` on the surface, 20 later: one 0-20 scale;
//   4. `time`: the tick of the day (a number too), and whether the sky is light.
vi.mock('../../src/services/minebot/utils/setMovements.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/setMovements.js')>();
  return { ...actual, buildMovements: (bot: any, ...rest: any[]) => bot.__fakeMovements ? { getBlock: () => null, getNeighbors: () => [], exclusionAreasBreak: [] } : (actual.buildMovements as any)(bot, ...rest) };
});

const { runAct, ACT_HANDS } = await import('../../src/services/minebot/instantSkills/act.js');
const walkModule: any = await import('../../src/services/minebot/utils/primitives/walk.js');
const rules: any = await import('../../src/services/minebot/utils/walkRules.js');
const localMap: any = await import('../../src/services/minebot/utils/localMap.js');
const { probePath } = await import('../../src/services/minebot/utils/probeTools.js');
const { insideStructure } = await import('../../src/services/minebot/utils/mapMarks.js');
const { airLevel } = await import('../../src/services/minebot/utils/airSupplyDefault.js');
const { captureWorldObservation: observeWorld } = await import('../../src/services/minebot/cognition/worldFrame.js');

type Cell = { name: string; boundingBox: string };
const AIR: Cell = { name: 'air', boundingBox: 'empty' };
const OBSIDIAN: Cell = { name: 'obsidian', boundingBox: 'block' };
const PORTAL: Cell = { name: 'nether_portal', boundingBox: 'empty' };

/**
 * Run 37's portal as a real frame (4 wide, 5 tall: obsidian at x 4 and 7, y -55 and -51), the lit portal inside it (x 5 and 6, y -54..-52, z 0);
 * air elsewhere over a floor of obsidian at y -55. The top row of the portal (y -52) has the frame's top edge over its head.
 */
const portalWorld = (portal: Cell = PORTAL) => (x: number, y: number, z: number): Cell => {
  if (z === 0 && (x === 5 || x === 6) && y >= -54 && y <= -52) return portal;
  if (z === 0 && x >= 4 && x <= 7 && (y === -51 || x === 4 || x === 7) && y >= -55 && y <= -51) return OBSIDIAN;
  if (y === -55) return OBSIDIAN;
  if (y < -55) return { name: 'stone', boundingBox: 'block' };
  return AIR;
};

function portalBody(shape: (x: number, y: number, z: number) => Cell, at = new Vec3(5.5, -54, 1.5), dimension = 'overworld') {
  const bot: any = Object.assign(new EventEmitter(), {
    __fakeMovements: true,
    entity: { position: at.clone(), yaw: 0, onGround: true, isInWater: false, height: 1.8 }, health: 20, food: 20, game: { dimension }, entities: {},
    registry: { blocksByName: {}, itemsByName: {}, items: {} }, inventory: { items: () => [], slots: new Array(46).fill(null) }, heldItem: null,
    blockAt: (p: Vec3) => { const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z); return { diggable: true, hardness: 1, ...shape(x, y, z), position: new Vec3(x, y, z) }; },
    setControlState: () => undefined, clearControlStates: () => undefined, stopDigging: () => undefined,
  });
  return bot;
}
const ctxOf = (bot: any, ms = 8000) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + ms, facing: 'north' as const, base: { x: 5, y: -54, z: 1 } });
/** The route search stand-in: it walks the body into the goal's cell at once (a portal has no box); `after` runs then (the server's carry-off). */
function walksInto(bot: any, cell: { x: number; y: number; z: number }, after?: () => void, hold = false) {
  let release: (() => void) | null = null;
  bot.pathfinder = { movements: null, setMovements(m: unknown) { this.movements = m; }, stop: () => release?.(), setGoal: () => undefined,
    goto: vi.fn((goal: any) => {
      bot.entity.position = new Vec3(Math.floor(goal.x) + 0.5, Math.floor(goal.y), Math.floor(goal.z) + 0.5);
      if (Math.floor(goal.x) === cell.x && Math.floor(goal.z) === cell.z) after?.();
      return hold ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
    }) };
}
const carriedOff = (bot: any, dimension: string, to: Vec3, ms = 250) => setTimeout(() => { bot.game.dimension = dimension; bot.entity.position = to; }, ms);

// ===== 1. a lit portal is walked into =====

describe('walk into a nether portal (run 37: "一歩ではない: (229,-54,196)（自分から北1）そのものには立てない（足のマスが nether_portal）")', () => {
  it('the rules: a portal is neither a wall nor a harm; not a cell of a route; an end portal frame is a block, not a portal', () => {
    const read = localMap.bodyReader(portalBody(portalWorld()));
    expect(rules.cellWay({ name: 'nether_portal', solid: false })).toBe('portal');
    expect(rules.cellWay({ name: 'end_portal', solid: false })).toBe('portal');
    expect(rules.cellWay({ name: 'end_portal_frame', solid: true })).toBe('solid');
    expect(rules.cellWay({ name: 'lava', solid: false })).toBe('harm');
    expect(rules.passable({ name: 'nether_portal', solid: false })).toBe(false);
    expect(rules.standable(read, 5, -54, 0)).toBe(false);
    expect(rules.portalEntry(read, { x: 5, y: -54, z: 0 })).toBe('nether_portal');
    expect(rules.portalEntry(read, { x: 5, y: -53, z: 0 })).toBe('nether_portal');
    expect(rules.portalEntry(read, { x: 5, y: -52, z: 0 })).toBeNull();
    expect(rules.portalEntry(read, { x: 5, y: -54, z: 1 })).toBeNull();
    const words = rules.whyNotStand(read, { x: 5, y: -54, z: 0 }).text as string;
    expect(words).toContain('ポータル');
    expect(words).toContain('ポータル: 壁でも害でもない');
    expect(words).not.toMatch(/入らない|埋まっている/u);
    expect(rules.blockedWords({ name: 'nether_portal', solid: false }, { x: 5, y: -54, z: 0 })).not.toMatch(/入らない/u);
    // The frame's obsidian under it is the floor; an end portal is walked into too (a body falls through it).
    expect(rules.portalEntry(localMap.bodyReader(portalBody(portalWorld({ name: 'end_portal', boundingBox: 'empty' }))), { x: 5, y: -54, z: 0 })).toBe('end_portal');
  });

  it('range 0.5 (the act\'s default): the portal cell is walked into, and the dimension changing is the arrival', async () => {
    const bot = portalBody(portalWorld());
    walksInto(bot, { x: 5, y: -54, z: 0 }, () => { carriedOff(bot, 'the_nether', new Vec3(40.5, 70, 40.5)); });
    const outcome = await walkModule.walk(ctxOf(bot), { to: { x: 5, y: -54, z: 0 }, range: 0.5 });
    expect(bot.pathfinder.goto).toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toBe('ネザーへ移った (40,70,40)（オーバーワールドの (5,-54,1) から歩いて入った）');
    expect(outcome.at).toEqual({ x: 40, y: 70, z: 40 });
  });

  it('carried off while the route search is still walking: not stuck, not failed', async () => {
    const bot = portalBody(portalWorld());
    walksInto(bot, { x: 5, y: -54, z: 0 }, () => { carriedOff(bot, 'minecraft:the_nether', new Vec3(8.5, 71, 9.5), 300); }, true);
    const outcome = await walkModule.walk(ctxOf(bot), { to: { x: 5, y: -54, z: 0 }, range: 0 });
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('ネザーへ移った (8,71,9)');
  });

  it('a path whose last cell is the portal: the earlier cells are walked, the end is the dimension', async () => {
    const bot = portalBody(portalWorld());
    walksInto(bot, { x: 5, y: -54, z: 0 }, () => { carriedOff(bot, 'the_end', new Vec3(100.5, 49, 0.5)); });
    const outcome = await walkModule.walk(ctxOf(bot), { path: [{ x: 5, y: -54, z: 1 }, { x: 5, y: -54, z: 0 }], range: 0.5 });
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('エンドへ移った (100,49,0)');
  });

  it('in the portal and not carried off: said as it is (the feet are in it, the dimension is the same), not a refusal', async () => {
    const bot = portalBody(portalWorld());
    walksInto(bot, { x: 5, y: -54, z: 0 });
    const outcome = await walkModule.walk(ctxOf(bot, 1500), { to: { x: 5, y: -54, z: 0 }, range: 0.5 });
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('(5,-54,0) の nether_portal（ポータル）の中に着いた');
    expect(outcome.text).toContain('まだ次元は変わっていない');
  });

  it('a block that is no portal is still refused as before (a cell with stone in it)', async () => {
    const bot = portalBody((x, y, z) => (x === 5 && z === 0 && y >= -54 && y <= -53 ? { name: 'stone', boundingBox: 'block' } : portalWorld()(x, y, z)));
    walksInto(bot, { x: 5, y: -54, z: 0 });
    const outcome = await walkModule.walk(ctxOf(bot), { to: { x: 5, y: -54, z: 0 }, range: 0.5 });
    expect(outcome).toMatchObject({ ok: false, reason: 'target_solid' });
  });

  it('the straight line to the portal is open (whyBlocked ends at the target); a portal in the way says what it is', () => {
    const bot = portalBody(portalWorld());
    expect(walkModule.whyBlocked(bot, { x: 5, y: -54, z: 3 }, { x: 5, y: -54, z: 0 })).toBeNull();
    const through = walkModule.whyBlocked(bot, { x: 5, y: -54, z: 3 }, { x: 5, y: -54, z: -3 });
    expect(through?.text).toContain('nether_portal');
    expect(through?.text).toContain('ポータル');
    expect(through?.text).not.toMatch(/（入らない）|壁:/u);
  });

  it('probe path to the portal cell says what it is, not a wall', async () => {
    const bot = portalBody(portalWorld());
    const answer = await probePath(localMap.bodyReader(bot), { x: 5, y: -54, z: 3 }, { x: 5, y: -54, z: 0 });
    expect(answer.text).toContain('ポータル');
    expect(answer.text).not.toMatch(/入らない/u);
  });

  it('cellWords: the portal is named as one', () => {
    const bot = portalBody(portalWorld());
    expect(walkModule.cellWords(bot, { x: 5, y: -54, z: 0 })).toBe('nether_portal［ポータル。入ると次元が変わる］');
  });

  it('the map legend still names p and e as portals (nothing says wall or harm for them)', () => {
    expect(localMap.symbolFor({ name: 'nether_portal' })).toBe('p');
    expect(localMap.symbolFor({ name: 'end_portal' })).toBe('e');
    expect(localMap.MAP_LEGEND).toContain('p ネザーポータル');
    expect(localMap.MAP_LEGEND).toContain('e エンドポータル・エンドゲートウェイ');
  });
});

describe('review: a real frame, the end portal, the end gateway, the last point only, the act ends where the dimension changed', () => {
  const read = (shape: (x: number, y: number, z: number) => Cell) => localMap.bodyReader(portalBody(shape));
  it('the aim: the bottom row is entered, a middle cell is entered at the bottom one, the top row (head on the frame) is refused with the cell to aim at', () => {
    const r = read(portalWorld());
    expect(rules.portalAim(r, { x: 5, y: -54, z: 0 })).toMatchObject({ kind: 'enter', cell: { x: 5, y: -54, z: 0 }, redirected: false });
    expect(rules.portalAim(r, { x: 6, y: -53, z: 0 })).toMatchObject({ kind: 'enter', cell: { x: 6, y: -54, z: 0 }, redirected: true });
    const top = rules.portalAim(r, { x: 5, y: -52, z: 0 });
    expect(top.kind).toBe('refuse');
    expect(top.text).toBe('(5,-52,0) は nether_portal の最上段: 頭が obsidian（枠）に当たって入れない。1 段下のポータルのマス (5,-53,0) へ');
    expect(rules.portalAim(r, { x: 5, y: -54, z: 1 })).toBeNull();
  });
  it('walk to the top row: refused before any step, with that line; to a middle cell: the body goes to the bottom cell and says so', async () => {
    const bot = portalBody(portalWorld());
    walksInto(bot, { x: 5, y: -54, z: 0 });
    const refused = await walkModule.walk(ctxOf(bot), { to: { x: 5, y: -52, z: 0 }, range: 0.5 });
    expect(refused).toMatchObject({ ok: false, reason: 'target_unstandable' });
    expect(refused.text).toContain('最上段: 頭が obsidian（枠）に当たって入れない。1 段下のポータルのマス (5,-53,0) へ');
    expect(bot.pathfinder.goto).not.toHaveBeenCalled();
    walksInto(bot, { x: 5, y: -54, z: 0 }, () => { carriedOff(bot, 'the_nether', new Vec3(1.5, 70, 1.5)); });
    const middle = await walkModule.walk(ctxOf(bot), { to: { x: 5, y: -53, z: 0 }, range: 0.5 });
    expect(bot.pathfinder.goto.mock.calls[0][0]).toMatchObject({ x: 5, y: -54, z: 0 });
    expect(middle.ok).toBe(true);
    expect(middle.text).toContain('ネザーへ移った (1,70,1)');
    expect(middle.text).toContain('指された (5,-53,0) は柱の途中なので一番下のポータルのマスから');
  });
  it('an end portal over lava (a stronghold): no floor asked, lava under it is not a harm; the walk goes in', async () => {
    const world = (x: number, y: number, z: number): Cell => (x === 5 && z === 0 && y === -54 ? { name: 'end_portal', boundingBox: 'empty' }
      : x === 5 && z === 0 && y === -55 ? { name: 'lava', boundingBox: 'empty' } : y < -55 ? { name: 'stone', boundingBox: 'block' } : y === -55 ? OBSIDIAN : AIR);
    const bot = portalBody(world);
    expect(rules.portalAim(localMap.bodyReader(bot), { x: 5, y: -54, z: 0 })).toMatchObject({ kind: 'enter', name: 'end_portal', redirected: false });
    walksInto(bot, { x: 5, y: -54, z: 0 }, () => { carriedOff(bot, 'the_end', new Vec3(100.5, 49, 0.5)); });
    const outcome = await walkModule.walk(ctxOf(bot), { to: { x: 5, y: -54, z: 0 }, range: 0.5 });
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('エンドへ移った (100,49,0)');
  });
  it('an end gateway is entered like an end portal; the frame of an end portal is not', () => {
    const gate = read((x, y, z) => (x === 5 && z === 0 && y === -54 ? { name: 'end_gateway', boundingBox: 'empty' } : y <= -55 ? OBSIDIAN : AIR));
    expect(rules.cellWay({ name: 'end_gateway', solid: false })).toBe('portal');
    expect(rules.portalAim(gate, { x: 5, y: -54, z: 0 })).toMatchObject({ kind: 'enter', name: 'end_gateway' });
    const frame = read((x, y, z) => (x === 5 && z === 0 && y === -54 ? { name: 'end_portal_frame', boundingBox: 'block' } : y <= -55 ? OBSIDIAN : AIR));
    expect(rules.portalAim(frame, { x: 5, y: -54, z: 0 })).toBeNull();
  });
  it('a portal in the middle of a path is not entered: refused before any step, "ポータルは walk の最後の点にだけ"', async () => {
    const bot = portalBody(portalWorld());
    walksInto(bot, { x: 9, y: -54, z: 9 });
    const outcome = await walkModule.walk(ctxOf(bot), { path: [{ x: 5, y: -54, z: 0 }, { x: 5, y: -54, z: 1 }], range: 0.5 });
    expect(outcome).toMatchObject({ ok: false, reason: 'target_unstandable' });
    expect(outcome.text).toBe('道の1/2番目で: (5,-54,0) は nether_portal（ポータルは walk の最後の点にだけ。途中の点にはしない）');
    expect(bot.pathfinder.goto).not.toHaveBeenCalled();
  });
  it('a change of dimension in a walk to a point that is no portal (a death and a respawn elsewhere) is not an arrival: the act stops with dimension_changed, ok false', async () => {
    const bot = portalBody(portalWorld());
    walksInto(bot, { x: 9, y: -54, z: 9 }, () => { carriedOff(bot, 'the_nether', new Vec3(40.5, 70, 40.5)); }, true);
    const result: any = await runAct(bot, ACT_HANDS.parse([{ do: 'walk', to: { x: 9, y: -54, z: 9 } }, { do: 'walk', to: { x: 1, y: -54, z: 1 } }]), undefined, undefined, { tickMs: 20 });
    expect(result.success).toBe(false);
    expect(result.failureType).toBe('dimension_changed');
    const json = JSON.parse(result.result);
    expect(json.stoppedBy).toBe('failure');
    expect(json.stoppedWhy).toContain('次元が変わった（overworld → the_nether）');
    expect(json.lines[0].line).not.toContain('歩いて入った');
    expect(json.lines[1].line).toBe('未実行');
    // The walk itself, with no act over it: not an arrival either.
    const alone = portalBody(portalWorld());
    walksInto(alone, { x: 9, y: -54, z: 9 }, () => { carriedOff(alone, 'the_nether', new Vec3(40.5, 70, 40.5)); }, true);
    const outcome = await walkModule.walk(ctxOf(alone, 1500), { to: { x: 9, y: -54, z: 9 }, range: 0.5 });
    expect(outcome.text ?? '').not.toContain('歩いて入った');
    expect(outcome.data?.crossedDimension).toBeUndefined();
  });
  it('an act ends where the dimension changed: the hands after it are 未実行 with the reason, and the act is ok as far as it went', async () => {
    const bot = portalBody(portalWorld());
    walksInto(bot, { x: 5, y: -54, z: 0 }, () => { carriedOff(bot, 'the_nether', new Vec3(40.5, 70, 40.5)); });
    const result: any = await runAct(bot, ACT_HANDS.parse([{ do: 'walk', to: { x: 5, y: -54, z: 0 } }, { do: 'walk', to: { x: 229, y: -54, z: 190 } }, { do: 'walk', to: { x: 1, y: 64, z: 1 } }]), undefined, undefined, { tickMs: 20 });
    expect(result.success).toBe(true);
    const json = JSON.parse(result.result);
    expect(json.lines[0].line).toContain('ネザーへ移った (40,70,40)');
    expect(json.lines[1]).toMatchObject({ status: 'skipped', line: '未実行: 次元が変わった（前の次元の座標の手は送らない）' });
    expect(json.lines[2]).toMatchObject({ status: 'skipped', line: '未実行: 次元が変わった（前の次元の座標の手は送らない）' });
    expect(bot.pathfinder.goto).toHaveBeenCalledTimes(1);
  });
});

// ===== 2. inside: the village is on the ground =====

describe('inside (run 37: "村の中" at y -54, 118 under the village)', () => {
  const body = (y: number, villageY = 64) => {
    const bot: any = { entity: { position: new Vec3(0.5, y, 0.5), onGround: true }, registry: {}, world: {}, game: { dimension: 'overworld' }, blockAt: () => null,
      landmarks: [{ kind: 'village', position: { x: 10, y: villageY, z: 10 }, evidence: 'bell' }] };
    return bot;
  };
  it('on the village ground: 村の中', () => {
    expect(insideStructure(body(64), 1e6)).toBe('村の中');
    expect(insideStructure(body(70), 1e6)).toBe('村の中');
    expect(insideStructure(body(50), 1e6)).toBe('村の中');
  });
  it('in a cave far under it, or high over it: not inside', () => {
    expect(insideStructure(body(-54, 64), 1e6)).toBeNull();
    expect(insideStructure(body(30), 1e6)).toBeNull();
    expect(insideStructure(body(90), 1e6)).toBeNull();
  });
  it('far across is not inside either (as before)', () => {
    const bot = body(64);
    bot.landmarks[0].position.x = 80;
    expect(insideStructure(bot, 1e6)).toBeNull();
  });
});

// ===== 3. oxygen on one scale =====

describe('oxygen on one 0-20 scale (run 37: 400 on the surface, 20 later)', () => {
  it('airLevel clamps to 0-20 and rounds; unknown is null, never 20', () => {
    expect(airLevel(400)).toBe(20);
    expect(airLevel(20)).toBe(20);
    expect(airLevel(7.4)).toBe(7);
    expect(airLevel(0)).toBe(0);
    expect(airLevel(-3)).toBe(0);
    expect(airLevel(undefined)).toBeNull();
    expect(airLevel(null)).toBeNull();
    expect(airLevel(Number.NaN)).toBeNull();
    expect(airLevel('400')).toBeNull();
  });
  const observed = (extra: Record<string, unknown>) => observeWorld({ entity: { position: new Vec3(0.5, 64, 0.5) }, health: 20, food: 20, game: { dimension: 'overworld' }, inventory: { items: () => [] }, entities: {}, ...extra } as never);
  it('the observation says 20 for a body that reads 400', () => {
    expect(observed({ oxygenLevel: 400 }).oxygen).toBe(20);
    expect(observed({ oxygenLevel: 12 }).oxygen).toBe(12);
    expect(observed({}).oxygen).toBeNull();
  });
});

// ===== 4. time =====

describe('time: the tick of the day, and the sky', () => {
  const observed = (timeOfDay: number | undefined, dimension = 'overworld') => observeWorld({ entity: { position: new Vec3(0.5, 64, 0.5) }, health: 20, food: 20, game: { dimension }, inventory: { items: () => [] }, entities: {},
    ...(timeOfDay === undefined ? {} : { time: { timeOfDay } }) } as never) as any;
  it('time stays the decimal string; timeOfDay is the number (0-23999); isDay is the overworld sky', () => {
    const morning = observed(4439);
    expect(morning.time).toBe('4439');
    expect(morning.timeOfDay).toBe(4439);
    expect(morning.isDay).toBe(true);
    expect(observed(99).timeOfDay).toBe(99);
    expect(observed(12999).isDay).toBe(true);
    expect(observed(13000).isDay).toBe(false);
    expect(observed(18000).isDay).toBe(false);
    expect(observed(22999).isDay).toBe(false);
    expect(observed(23000).isDay).toBe(true);
  });
  it('a clock beyond a day is folded into one (a long-running world), a negative one too', () => {
    expect(observed(24000 * 3 + 5).timeOfDay).toBe(5);
    expect(observed(-6000).timeOfDay).toBe(18000);
  });
  it('the nether has a number and no isDay; no clock says none', () => {
    const nether = observed(6000, 'the_nether');
    expect(nether.timeOfDay).toBe(6000);
    expect(nether.isDay).toBeUndefined();
    const unknown = observed(undefined);
    expect(unknown.timeOfDay).toBeUndefined();
    expect(unknown.isDay).toBeUndefined();
  });
});
