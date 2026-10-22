import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

// r10 (2026-10-22, run 34 +565 to +580): B3 with the floor itself, not a stand-in for it.
// At 7.5 health, a piglin 6.9 m off and a rock to dig down in, the last stand ("低体力で逃げ道なし: 足元を掘って下がった") made eleven hands in 12 s,
// one a second, and between two hands nothing held the body. An urgent act that came in (bb547b9c, +576, 4 s) was never handed the body (the next hand
// came first, again and again) and its receipt came at its deadline, bare. The body now holds an act back through the gap, starts it when the
// reflex lets go, and says so; an act that the reflex does not let go in time is not started, and that is said too.
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

const { floorConfig } = await import('../../src/services/minebot/utils/floorConfig.js');
const { installFloorReflexes, reflexHeld } = await import('../../src/services/minebot/utils/floorReflexes.js');
const { ensureReflexLedger } = await import('../../src/services/minebot/utils/reflexLedger.js');
const { NativeCommonFcaBody } = await import('../../src/services/minebot/integration/commonFca/nativeBody.js');
const { default: Act } = await import('../../src/services/minebot/instantSkills/act.js');

type Cell = { name: string; boundingBox: string; diggable?: boolean; hardness?: number };
const STONE: Cell = { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5 }, AIR: Cell = { name: 'air', boundingBox: 'empty' };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A rock column the body stands on (x 0, z 0, y 30 to 64), air round it: every heading is a drop, so the flee is refused and the last stand digs down. */
function scene() {
  const blocks = new Map<string, Cell>();
  const piglin = { id: 848, name: 'piglin', type: 'hostile', height: 1.95, width: 0.6, position: new Vec3(6.5, 65, 0.5) };
  const bot: any = Object.assign(new EventEmitter(), {
    __blocks: blocks, __dug: [] as string[],
    entity: { id: 1, name: 'player', position: new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
    health: 7.5, food: 17, oxygenLevel: 20, game: { dimension: 'the_nether' }, llmCentric: true,
    entities: { 848: piglin } as Record<string, any>,
    registry: { blocksByName: { cobblestone: { id: 1 } }, entitiesByName: { piglin: { type: 'hostile' } } }, heldItem: null,
    inventory: { items: () => [], slots: new Array(46).fill(null) }, controlState: {} as Record<string, boolean>,
    executingSkill: false, interruptExecution: false, clearControlStates: vi.fn(), look: vi.fn(async () => undefined), lookAt: vi.fn(async () => undefined),
    equip: vi.fn(async () => undefined), consume: vi.fn(async () => undefined), attack: vi.fn(), setControlState: vi.fn(), stopDigging: () => undefined,
    pathfinder: { stop: () => undefined, setGoal: () => undefined },
    blockAt: (position: Vec3) => {
      const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
      const made = blocks.get(`${x},${y},${z}`) ?? (x === 0 && z === 0 && y <= 64 && y >= 30 ? STONE : AIR);
      return { diggable: true, hardness: 1.5, ...made, position: new Vec3(x, y, z) };
    },
  });
  bot.instantSkills = { getSkills: () => [new Act(bot)] };
  const ledger = ensureReflexLedger(bot);
  installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1 });
  const body = new NativeCommonFcaBody(bot, { serverId: 'home', capture: async () => { throw Error('unused'); } });
  const ticking = setInterval(() => bot.emit('physicsTick'), 50);
  const stands = () => ledger.entriesSince(-1).filter(entry => entry.detail.startsWith('低体力で逃げ道なし:'));
  return { bot, body, ledger, stands, piglin, stop: async () => { clearInterval(ticking); await body.dispose(); } };
}
const context = { scopeKey: 'owner', taskId: 'task1', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 'session1', generation: 1, goal: 'test', completionCondition: 'done' };
const urgent = (id: string, ms: number) => ({ schemaVersion: 1, id, serverId: 'home', connectionId: 'connection1', kind: 'skill', context,
  lease: { id: 'lease1', generation: 1, holder: 'task1' }, deadlineAt: new Date(Date.now() + ms).toISOString(), skill: 'act',
  arguments: { hands: [{ do: 'wait', seconds: 0.05 }] } }) as never;
const deadline = (ms: number) => { const controller = new AbortController(); setTimeout(() => controller.abort('deadline'), ms).unref(); return controller.signal; };

describe('B3 with the floor: the last stand repeats a hand a second at low health (run 34 +565 to +580)', () => {
  it('the scene: the stand digs down a hand at a time, with a gap between two hands in which nothing holds the body by a lease', async () => {
    const { bot, stands, stop } = scene();
    await vi.waitFor(() => expect(stands().length).toBeGreaterThanOrEqual(2), { timeout: 6000, interval: 20 });
    expect(bot.__dug.length).toBeGreaterThanOrEqual(2);
    expect(stands()[0].detail).toMatch(/^低体力で逃げ道なし: 足元を掘って下がった \(0,65,0\) 体力7\.5/u);
    await stop();
  }, 10_000);

  it('an act that comes in a gap waits through the hands, starts when the stand lets go (the piglin gone), and says so', async () => {
    const { bot, body, stands, stop } = scene();
    await vi.waitFor(() => expect(stands().length).toBeGreaterThanOrEqual(2), { timeout: 6000, interval: 20 });
    // In a gap: no lease held, the hold is the stand's own.
    await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 3000, interval: 5 });
    expect(reflexHeld(bot)).toBe('floor-last-stand');
    // The observation says so too (the head need not send an act until this is null).
    expect(body.observe().facts.reflexHeld).toBe('floor-last-stand');
    const began = Date.now();
    const pending = body.execute(urgent('urgent', 9000), deadline(9000));
    let receiptAt = 0; void pending.then(() => { receiptAt = Date.now(); });
    await wait(1200);
    // Still waiting: three hands may have been made, the act has not begun.
    expect(receiptAt).toBe(0);
    const hands = stands().length;
    delete bot.entities[848];
    const receipt = await pending;
    const json = JSON.parse(receipt.result!);
    console.log('[r10 act through the stand]', receiptAt - began, 'ms, hands', hands, JSON.stringify(json.afterReflex), json.ok);
    expect(receipt).toMatchObject({ outcome: 'completed', inputsReleased: true });
    expect(json).toMatchObject({ ok: true, done: 1, of: 1 });
    expect(json.afterReflex).toMatch(/^反射 last-stand（逃げ道が無い時の最後の手）の最中のため、放された後に始めた（待ち [1-3]\.\d秒）$/u);
    // No hand after the act began.
    const after = stands().length;
    await wait(1800);
    expect(stands().length).toBe(after);
    await stop();
  }, 20_000);

  it('the stand does not let go in time: the act is not started, and the receipt says that, known and recoverable (it was bare, at the deadline)', async () => {
    const { body, stands, stop } = scene();
    await vi.waitFor(() => expect(stands().length).toBeGreaterThanOrEqual(2), { timeout: 6000, interval: 20 });
    const began = Date.now();
    const receipt = await body.execute(urgent('urgent', 3500), deadline(3500));
    const took = Date.now() - began;
    console.log('[r10 act late]', took, 'ms', receipt.result);
    expect(receipt).toMatchObject({ outcome: 'failed', failureType: 'interrupted_by_reflex', recoverable: true, inputsReleased: true });
    expect(receipt.result).toMatch(/^反射 last-stand（逃げ道が無い時の最後の手）の最中で、時間内に放されなかったため始められなかった（[12]\.\d秒待った。体は何も動かしていない）。放された後に頼み直す$/u);
    expect(took).toBeLessThan(3000);
    await stop();
  }, 20_000);
});
