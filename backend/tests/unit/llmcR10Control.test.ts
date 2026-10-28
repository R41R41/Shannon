import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { CommonFcaControlLoop, type CommonFcaActuator } from '../../src/services/minebot/integration/commonFca/controlLoop.js';
import type { MinecraftControlCommand } from '../../src/services/minebot/integration/commonFca/minecraftControlContract.js';
import { runProbe } from '../../src/services/minebot/instantSkills/probe.js';
import Act from '../../src/services/minebot/instantSkills/act.js';
import { executeAction } from '../../src/services/minebot/execution/ActionExecution.js';
import { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
import { ensureReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';
import { madeCommand } from './helpers/madeFor.js';

// r10 (2026-10-22, run 34).
// B2: the probes a step sends (sight, around, column, path ...) took one poll period each, one after another (the API hands the body one command
//     in a reply, and a receipt reaches it with the next poll): five of them passed the one second the head waits. The loop now sends a receipt
//     at once and polls fast for a while after a command; read-only commands run beside each other.
// B3: an act that comes while a reflex holds the body waits for it, starts when it lets go, and the receipt says so (it used to wait in the
//     lock bare, be cut by the flee's next segment, or come back at its deadline).

const STONE = { name: 'stone', boundingBox: 'block' }, AIR = { name: 'air', boundingBox: 'empty' };
/** A cave of sorts: stone under 64, a pillar and a ledge, a mob at 7. */
function caveBot(): any {
  return {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 }, game: { dimension: 'the_nether' }, health: 20,
    entities: { 7: { id: 7, name: 'piglin', type: 'hostile', height: 1.95, width: 0.6, position: new Vec3(6.5, 66, 3.5), yaw: 1 },
      8: { id: 8, name: 'zombie', type: 'hostile', height: 1.95, width: 0.6, position: new Vec3(-4.5, 64, 2.5), yaw: 0 } },
    registry: { entitiesByName: { piglin: { type: 'hostile' }, zombie: { type: 'hostile' } } },
    blockAt: (p: Vec3) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      if (y < 64) return STONE;
      if (x === 3 && z === 0 && y < 68) return STONE;
      if (y > 70) return STONE;
      return AIR;
    },
  };
}
const PROBES = [
  { kind: 'sight', target: '#7' },
  { kind: 'around', radius: 8 },
  { kind: 'column', x: 0, z: 0, yFrom: 40, yTo: 90 },
  { kind: 'path', to: { x: 8, y: 64, z: 4 } },
] as const;

describe('B2: what one probe costs the body', () => {
  it('each kind is read in well under 20 ms (the body is not what took 200 to 400 ms)', async () => {
    const bot = caveBot(), per: Record<string, number> = {};
    for (const input of PROBES) {
      await runProbe(bot, input as never);
      const began = performance.now();
      for (let i = 0; i < 20; i++) await runProbe(bot, input as never);
      per[input.kind] = (performance.now() - began) / 20;
    }
    console.log('[r10 probe-ms]', JSON.stringify(Object.fromEntries(Object.entries(per).map(([kind, ms]) => [kind, Math.round(ms * 100) / 100]))));
    for (const ms of Object.values(per)) expect(ms).toBeLessThan(20);
  });
});

const NOW = () => Date.now();
const context = { scopeKey: 'owner', taskId: 'task1', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 'session1', generation: 1, goal: 'test', completionCondition: 'done' };
const command = (id: string, fields: Record<string, unknown> = {}): MinecraftControlCommand => ({ schemaVersion: 1, id, serverId: 'home', connectionId: 'connection1',
  kind: 'skill', context, lease: { id: 'lease1', generation: 1, holder: 'task1' }, deadlineAt: new Date(NOW() + 5000).toISOString(), skill: 'probe', arguments: {}, ...fields } as MinecraftControlCommand);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The API as the body sees it: `perReply` commands in a reply (the head's MinecraftControl hands one), 2 ms to answer a poll (the same
 * machine), the receipts it has seen with the time it saw each.
 */
function head(perReply: number) {
  const queue: MinecraftControlCommand[] = [], delivered = new Set<string>(), seen = new Map<string, number>(), refused: string[] = [];
  const fetcher = vi.fn(async (_url: unknown, init: any) => {
    await wait(2);
    const body = JSON.parse(init.body as string);
    for (const receipt of body.receipts) {
      if (!seen.has(receipt.id)) seen.set(receipt.id, performance.now());
      if (receipt.result === 'BODY_COMMAND_REFUSED') refused.push(receipt.id);
    }
    const commands = queue.filter(c => !delivered.has(c.id)).slice(0, perReply);
    for (const c of commands) delivered.add(c.id);
    return new Response(JSON.stringify({ schemaVersion: 1, mode: 'common-fca', commands, cancel: [], acknowledged: body.receipts.map((r: any) => r.id) }));
  });
  return { queue, seen, refused, fetcher };
}
function probeActuator(bot: any): CommonFcaActuator {
  let sequence = 0;
  return {
    skills: [{ name: 'probe', description: 'probe', readOnly: true, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: true } as never }],
    observe: () => ({ schemaVersion: 1, bodyId: 'minecraft:home', sequence: ++sequence, stateAt: new Date().toISOString(), receivedAt: new Date().toISOString(), state: {}, facts: {}, connected: true }),
    candidates: () => [],
    execute: vi.fn(async (c: any) => {
      const answer = await runProbe(bot, c.arguments);
      return { id: c.id, connectionId: c.connectionId, outcome: answer.success ? 'completed' : 'failed', inputsReleased: true, observedAt: new Date().toISOString(), result: answer.result };
    }) as never,
    release: vi.fn(async () => true),
  };
}
/** Four probes asked at once, `phase` ms after the loop began: how long until the head has all four receipts. */
async function fourProbes(perReply: number, phase: number) {
  const bot = caveBot(), api = head(perReply);
  const loop = new CommonFcaControlLoop({ baseUrl: 'http://127.0.0.1:3000', token: 'fake-device-token', serverId: 'home', connectionId: 'connection1',
    actuator: probeActuator(bot), fetcher: api.fetcher as never });
  loop.start();
  await wait(phase);
  const began = performance.now();
  PROBES.forEach((input, index) => api.queue.push(command(`probe:${index}`, { arguments: input, deadlineAt: new Date(NOW() + 3000).toISOString() })));
  const ids = PROBES.map((_, index) => `probe:${index}`);
  while (ids.some(id => !api.seen.has(id)) && performance.now() - began < 4000) await wait(2);
  const times = ids.map(id => (api.seen.get(id) ?? Infinity) - began);
  await loop.stop();
  return { total: Math.max(...times), times, refused: api.refused };
}

describe('B2: four probes asked at once (the head hands the body one command in a reply)', () => {
  it('all four answered in about 0.2 s at worst (one idle poll to pick the first up, then a round trip each), whatever the phase of the poll they met; it was 0.8 to 1.0 s (a poll period each)', async () => {
    const runs = [];
    for (const phase of [0, 8, 60, 120, 170]) runs.push(await fourProbes(1, phase));
    console.log('[r10 four-probes 1/reply]', JSON.stringify(runs.map(run => Math.round(run.total))), 'ms; first run:', JSON.stringify(runs[0].times.map(Math.round)));
    for (const run of runs) { expect(run.total).toBeLessThan(400); expect(run.refused).toEqual([]); }
  }, 20_000);

  it('and when the API hands all four in one reply, the body runs them together (it refused three of them)', async () => {
    const runs = [];
    for (const phase of [0, 8, 90, 170]) runs.push(await fourProbes(4, phase));
    console.log('[r10 four-probes 4/reply]', JSON.stringify(runs.map(run => Math.round(run.total))), 'ms');
    for (const run of runs) { expect(run.total).toBeLessThan(400); expect(run.refused).toEqual([]); }
  }, 20_000);
});

// ===== B3 =====
const flag = { priority: 250, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true };
function actBody() {
  const bot: any = Object.assign(new EventEmitter(), caveBot(), {
    food: 20, oxygenLevel: 20, inventory: { items: () => [], slots: new Array(46).fill(null) }, controlState: {} as Record<string, boolean>,
    executingSkill: false, interruptExecution: false, clearControlStates: vi.fn(), setControlState: vi.fn(), look: vi.fn(async () => undefined),
    stopDigging: () => undefined, pathfinder: { stop: () => undefined, setGoal: () => undefined },
  });
  bot.instantSkills = { getSkills: () => [new Act(bot)] };
  ensureReflexLedger(bot);
  const body = new NativeCommonFcaBody(bot, { serverId: 'home', capture: async () => { throw Error('unused'); } });
  return { bot, body };
}
// An act moves the body: it carries the life and what its decision read, taken from the body's own observation (continue contracts 2, 5).
const actCommand = (body: NativeCommonFcaBody, id: string, ms: number, hands: unknown[] = [{ do: 'wait', seconds: 0.05 }]): MinecraftControlCommand =>
  madeCommand(body, command(id, { skill: 'act', arguments: { hands }, deadlineAt: new Date(NOW() + ms).toISOString() }));
/** The control loop's own deadline: its controller aborts the command's signal when its time is up. */
function deadlineSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort('deadline'), ms).unref();
  return controller.signal;
}
/** A reflex holding the body as the floor's flee does: a safety lease on the floor-flee action. */
function holdFlee(bot: any) {
  let letGo = () => undefined as void;
  const holding = executeAction(bot, 'floor-flee', 20_000, () => new Promise(resolve => { letGo = () => resolve({ success: true, result: 'fled' }); }), flag);
  return { letGo: () => letGo(), holding };
}

describe('B3: an act that comes while a reflex holds the body (run 34 +576: a flee, an urgent act, 4 s, nothing settled)', () => {
  it('waits for the reflex, starts when it lets go, and the receipt says so', async () => {
    const { bot, body } = actBody();
    const { letGo, holding } = holdFlee(bot);
    await wait(10);
    const began = Date.now();
    const pending = body.execute(actCommand(body, 'urgent', 4000), deadlineSignal(4000));
    await wait(400);
    // Still waiting: nothing of the act has run, and the command has no receipt.
    let settled = false; void pending.then(receipt => { settled = true; console.log('[r10 act-while-held]', Date.now() - began, 'ms', JSON.stringify(receipt).slice(0, 300)); });
    await wait(20);
    expect(settled).toBe(false);
    letGo(); await holding;
    const receipt = await pending;
    const json = JSON.parse(receipt.result!);
    expect(receipt).toMatchObject({ outcome: 'completed', inputsReleased: true });
    expect(json).toMatchObject({ ok: true, done: 1, of: 1 });
    expect(json.afterReflex).toMatch(/^反射 flee（低体力の逃走）の最中のため、放された後に始めた（待ち 0\.[4-9]秒）$/u);
    // The act itself ran after the release (its own time is its 0.05 s wait, not the 0.4 s before).
    expect(json.ms).toBeLessThan(300);
    expect(Date.now() - began).toBeGreaterThanOrEqual(400);
    await body.dispose();
  });

  it('the flee\'s segments follow one another with a gap between: the act waits through the gaps, not between two segments', async () => {
    const { bot, body } = actBody();
    bot.floorReflexes = { retreat: { engaged: false, ticks: 0, cooldown: 0, engagements: 0 }, busy: null, retryAt: 0, engagements: { eat: 0, armor: 0 }, fleeStarts: [],
      fleeEpisode: { startedAt: Date.now(), origin: new Vec3(0, 64, 0), segments: 3, stalls: 0, outcome: 'done' } };
    const pending = body.execute(actCommand(body, 'urgent', 4000), new AbortController().signal);
    await wait(250);
    // No lease at all just now (between two segments), and the act has not begun.
    expect(bot.executingSkill).toBe(false);
    let settled = false; void pending.then(() => { settled = true; });
    await wait(20);
    expect(settled).toBe(false);
    bot.floorReflexes.fleeEpisode = undefined;
    const receipt = await pending;
    expect(JSON.parse(receipt.result!).afterReflex).toMatch(/^反射 flee（低体力の逃走）の最中のため、放された後に始めた/u);
    await body.dispose();
  });

  it('a reflex that does not let go in time: the act is not started, and that is the receipt (known, recoverable), before the deadline', async () => {
    const { bot, body } = actBody();
    const { letGo, holding } = holdFlee(bot);
    await wait(10);
    const began = Date.now();
    const receipt = await body.execute(actCommand(body, 'late', 2200), deadlineSignal(2200));
    const took = Date.now() - began;
    console.log('[r10 act-late]', took, 'ms', JSON.stringify({ ...receipt, observedAt: undefined }).slice(0, 400));
    expect(receipt).toMatchObject({ outcome: 'failed', failureType: 'interrupted_by_reflex', recoverable: true, inputsReleased: true });
    expect(receipt.result).toMatch(/^反射 flee（低体力の逃走）の最中で、時間内に放されなかったため始められなかった（1\.\d秒待った。体は何も動かしていない）。放された後に頼み直す$/u);
    expect(took).toBeGreaterThan(1000); expect(took).toBeLessThan(1700);
    expect(bot.look).not.toHaveBeenCalled();
    letGo(); await holding; await body.dispose();
  });

  it('cancelled while it waits: a cancelled receipt that says nothing of the body was moved', async () => {
    const { bot, body } = actBody();
    const { letGo, holding } = holdFlee(bot);
    await wait(10);
    const abort = new AbortController(), pending = body.execute(actCommand(body, 'gone', 4000), abort.signal);
    await wait(100); abort.abort('server_cancel');
    const receipt = await pending;
    expect(receipt).toMatchObject({ outcome: 'cancelled', inputsReleased: true });
    expect(receipt.result).toContain('反射 flee（低体力の逃走）の最中に取り消された');
    letGo(); await holding; await body.dispose();
  });

  it('no reflex holds the body: the act runs at once and the receipt is as it was', async () => {
    const { body } = actBody();
    const began = Date.now();
    const receipt = await body.execute(actCommand(body, 'plain', 4000), new AbortController().signal);
    expect(Date.now() - began).toBeLessThan(500);
    const json = JSON.parse(receipt.result!);
    expect(json).toMatchObject({ ok: true });
    expect(json).not.toHaveProperty('afterReflex');
    await body.dispose();
  });
});
