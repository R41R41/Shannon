import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
import { BodyEventWatcher } from '../../src/services/minebot/integration/commonFca/bodyEvents.js';
import { controlViewOf } from '../../src/services/minebot/integration/commonFca/controlView.js';
import { bridgeOf, BRIDGE_MS, meleeEpisodeView } from '../../src/services/minebot/utils/floorReflexes.js';
import { delegateShield, executeAction, shieldPort } from '../../src/services/minebot/execution/ActionExecution.js';
import { madeCommand, madeFor } from './helpers/madeFor.js';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import { createMotorPort } from '../../src/services/minebot/execution/ActionExecution.js';

function fixture() {
  const act: any = { skillName: 'act', description: 'act', isToolForLLM: true, maxDurationMs: 180_000, params: [{ name: 'hands', type: 'json', schema: ACT_HANDS, description: 'hands', required: true }],
    run: vi.fn(async (hands: any) => runAct(createMotorPort(bot), hands)) };
  let bot: any;
  bot = Object.assign(new EventEmitter(), { entity: { id: 1, position: new Vec3(0, 65, 0), yaw: 0, pitch: 0, onGround: true },
    username: 'shannon', health: 20, food: 20, oxygenLevel: 20, game: { dimension: 'overworld' }, entities: {}, inventory: { items: () => [], slots: new Array(46).fill(null) }, controlState: {},
    instantSkills: { getSkills: () => [act] }, executingSkill: false, interruptExecution: false,
    clearControlStates: vi.fn(), setControlState: vi.fn(), look: vi.fn(async () => {}), attack: vi.fn() });
  const body = new NativeCommonFcaBody(bot, { serverId: 'home', capture: async () => ({ dataUrl: 'data:image/jpeg;base64,YQ==', capturedAt: new Date().toISOString() }) });
  return { bot, body, act };
}
const base = { schemaVersion: 1, id: 'skill:q1', serverId: 'home', connectionId: 'c1', kind: 'skill', skill: 'get-health',
  context: { scopeKey: 'o', taskId: 't', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 's', generation: 1, goal: 'g', completionCondition: 'done' },
  lease: { id: 'l', generation: 1, holder: 't' }, deadlineAt: new Date(Date.now() + 5000).toISOString(), arguments: {} };

describe('the observation says who the body is and who holds it (contracts 4 and 5)', () => {
  it('carries the life, the run ids, the control view and the utilities with the proof of the scan', async () => {
    const { body, bot } = fixture();
    body.bindConnection('conn-9');
    const observation = body.observe(); const state = observation.state as any;
    expect(observation.facts.life).toBe(state.life.life);
    expect(state.life).toMatchObject({ alive: true, dimension: 'overworld' });
    expect(state.bodyRun).toMatchObject({ connectionId: 'conn-9' });
    expect(state.bodyRun.bodyBoot).toMatch(/^bb-/u);
    expect(state.control).toMatchObject({ holder: { kind: 'idle' }, waiting: [] });
    // A world that cannot be scanned is not "nothing near": scanned is false (the head then says it cannot tell).
    expect(state.world.utilities ?? null).toBeNull();
    bot.health = 0; bot.emit('death');
    expect((body.observe().state as any).life).toMatchObject({ advancedBy: 'death', alive: false });
    await body.dispose();
  });
  it('names the command that holds the body, and the reflex that does, with its enemy', async () => {
    const { body, bot } = fixture();
    const command = madeCommand(body, { ...base, id: 'skill:q7', skill: 'act', arguments: { hands: [{ do: 'wait', seconds: 0.4 }] } });
    const running = body.execute(command as never, new AbortController().signal);
    await new Promise(resolve => setTimeout(resolve, 5));
    await running;
    // A reflex action on a safety lease, with the floor's mark of its enemy.
    bot.floorReflexes = { retreat: { engaged: false, ticks: 0, cooldown: 0, engagements: 0 }, busy: 'flee', retryAt: 0, engagements: { eat: 0, armor: 0 },
      melee: { since: Date.now() - 500, hands: 1, lastEnd: Date.now(), hits: 1, target: 41 }, handTarget: { capability: 'floor-melee', target: 41, at: Date.now() } };
    const held = executeAction(bot, 'floor-melee', 1000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'x' }), 60)), { priority: 250, safetyLease: true, waitForQuiescence: false });
    await new Promise(resolve => setTimeout(resolve, 10));
    const view = (body.observe().state as any).control;
    expect(view.holder).toMatchObject({ kind: 'reflex', reflex: 'floor-melee', target: 41, priority: 250 });
    expect(view.reflexEpisode).toMatchObject({ reflex: 'floor-melee', target: 41, hands: 1, hits: 1 });
    await held;
    await body.dispose();
  });
});

describe('the bridge after the melee reflex\'s cap (contract 4)', () => {
  const botWith = (bridge: Record<string, unknown>) => ({ health: 9, entities: { 41: { isValid: true, health: 8 } }, floorReflexes: { bridge, melee: undefined } }) as any;
  it('goes on for BRIDGE_MS from the first notice and is not extended; it ends by the enemy gone, health at or below 5, or time', () => {
    const t = 1_000_000;
    const bridge = { after: 'floor-melee', hold: 'shield', target: 41, since: t, until: t + BRIDGE_MS };
    expect(bridgeOf(botWith({ ...bridge }), t + 1000)).toMatchObject({ hold: 'shield' });
    expect(bridgeOf(botWith({ ...bridge }), t + BRIDGE_MS + 1)).toBeNull();
    const dead = botWith({ ...bridge }); dead.entities = {};
    expect(bridgeOf(dead, t + 100)).toBeNull();
    const hurt = botWith({ ...bridge }); hurt.health = 5;
    expect(bridgeOf(hurt, t + 100)).toBeNull();
  });
  it('shows as the holder when nobody else holds the body, and a command that began ends it', async () => {
    const { bot } = fixture();
    const now = Date.now();
    bot.floorReflexes = { retreat: { engaged: false }, busy: null, bridge: { after: 'floor-melee', hold: 'shield', target: 41, since: now, until: now + BRIDGE_MS } };
    bot.entities = { 41: { isValid: true, health: 8 } };
    const view = controlViewOf(bot, { commands: new Map(), cleanup: null, waiting: new Map() }, now + 10);
    expect(view.holder).toMatchObject({ kind: 'bridge', after: 'floor-melee', hold: 'shield', target: 41 });
    const running = executeAction(bot, 'act', 1000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'x' }), 40)), { waitForQuiescence: true });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(bridgeOf(bot, now + 20)).toBeNull();
    await running;
  });
  it('tells the cap to the head once as the event reflex.capped with the limit, the bridge and the end, and a reflex\'s meal as inventory.changed', () => {
    const bot = Object.assign(new EventEmitter(), { entity: { position: new Vec3(0, 0, 0) } }) as any;
    const watcher = new BodyEventWatcher(bot, () => 1_700_000_000_000);
    bot.emit('minebotReflexCapped', { reflex: 'floor-melee', limit: 'melee_hits', count: 5, bridge: 'shield', until: '2026-10-28T10:00:03.000Z' });
    bot.emit('minebotInventoryChanged', { id: 'reflex:c-1:20', item: 'bread', count: -1, reason: 'reflex_eat', obsSeq: 12 });
    const events = watcher.pending();
    expect(events.map(event => event.kind)).toEqual(['reflex.capped', 'inventory.changed']);
    expect(events[0]).toMatchObject({ subject: 'floor-melee', data: { limit: 'melee_hits', bridge: 'shield', count: 5 } });
    expect(events[1].data).toMatchObject({ id: 'reflex:c-1:20', item: 'bread', count: -1, reason: 'reflex_eat', obsSeq: 12 });
  });
});

describe('the shield\'s right belongs to the owner (contract 4)', () => {
  it('the resident shield acts through a delegating owner\'s port, and on its own when no owner delegates', async () => {
    const { bot } = fixture();
    expect(shieldPort(bot)).toBeNull();
    let during: unknown = 'unset';
    const running = executeAction(bot, 'act', 1000, async () => {
      delegateShield(bot, true);
      during = shieldPort(bot);
      delegateShield(bot, false);
      return { success: true, result: 'ok' };
    }, { waitForQuiescence: true });
    await running;
    expect(during).not.toBeNull();
    expect(shieldPort(bot)).toBeNull();
  });
});

describe('what the body refuses and records (contracts 2, 5, 8)', () => {
  it('does not start a command made for another life, and says it was not run', async () => {
    const { body, bot } = fixture();
    const made = madeFor(body);
    bot.health = 0; bot.emit('death'); bot.health = 20; bot.emit('spawn');
    const receipt: any = await body.execute({ ...base, id: 'skill:q9', skill: 'act', arguments: { hands: [{ do: 'wait', seconds: 0.1 }] }, context: { ...base.context, ...made } } as never, new AbortController().signal);
    expect(receipt).toMatchObject({ outcome: 'failed', failureType: 'stale_life', inputsReleased: true });
    expect(receipt.unit).toMatchObject({ goal: 'not_started', end: 'not_run', released: true });
    expect(receipt.bodyTimes.endedAt).toBeTruthy();
    await body.dispose();
  });
  it('reads a read-only command without a life (the internal events reader, a query)', async () => {
    const { body } = fixture();
    const receipt: any = await body.execute({ ...base, id: 'skill:q10', skill: 'events', arguments: { command: 'skill:none', fromSeq: 0 } } as never, new AbortController().signal);
    expect(receipt.outcome).toBe('completed');
    expect(JSON.parse(receipt.result)).toMatchObject({ lost: true, events: [] });
    await body.dispose();
  });
  it('gives an act\'s receipt its unit, the times and the act\'s events, and keeps the events for the head', async () => {
    const { body } = fixture();
    const receipt: any = await body.execute(madeCommand(body, { ...base, id: 'skill:q11', skill: 'act', arguments: { hands: [{ do: 'wait', seconds: 0.1 }] } }) as never, new AbortController().signal);
    expect(receipt.outcome).toBe('completed');
    expect(receipt.unit).toMatchObject({ goal: 'done', end: 'finished', released: true });
    expect(receipt.bodyTimes).toMatchObject({ endedAt: expect.any(String), lockAt: expect.any(String) });
    const body2 = JSON.parse(receipt.result);
    expect(body2.outcome).toMatchObject({ goal: 'done', end: 'finished' });
    const page: any = await body.execute({ ...base, id: 'skill:q12', skill: 'events', arguments: { command: 'skill:q11', fromSeq: 0 } } as never, new AbortController().signal);
    expect(JSON.parse(page.result)).toMatchObject({ lost: false, done: true, total: 0 });
    await body.dispose();
  });
});

describe('the pieces the isolated lab measures (contracts 3, 4, 8)', () => {
  it('plans a handover only for an act whose first moving hand fights the reflex\'s enemy, from the melee or a last stand with health above 5', async () => {
    const { planHandover } = await import('../../src/services/minebot/utils/handover.js');
    const { bot } = fixture();
    bot.floorReflexes = { handTarget: { capability: 'floor-melee', target: 41, at: Date.now() } };
    const running = executeAction(bot, 'floor-melee', 1000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'x' }), 80)), { priority: 250, safetyLease: true, waitForQuiescence: false });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(planHandover(bot, { hands: [{ do: 'fight', target: '#41' }] })).toMatchObject({ reflex: 'floor-melee', target: 41 });
    expect(planHandover(bot, { hands: [{ do: 'look' }, { do: 'attack', target: 41 }] })).toMatchObject({ target: 41 });
    expect(planHandover(bot, { hands: [{ do: 'fight', target: '#42' }] })).toBeNull();
    expect(planHandover(bot, { hands: [{ do: 'go', to: { x: 1, y: 1, z: 1 } }, { do: 'fight', target: '#41' }] })).toBeNull();
    await running;
    // The low-health flee, lava, a meal: never taken from.
    for (const capability of ['floor-flee', 'lava-escape', 'floor-eat']) {
      const held = executeAction(bot, capability, 1000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'x' }), 50)), { priority: 250, safetyLease: true, waitForQuiescence: false });
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(planHandover(bot, { hands: [{ do: 'fight', target: '#41' }] }), capability).toBeNull();
      await held;
    }
    bot.health = 5;
    bot.floorReflexes.handTarget = { capability: 'floor-last-stand', target: 41, at: Date.now() };
    const stand = executeAction(bot, 'floor-last-stand', 1000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'x' }), 50)), { priority: 250, safetyLease: true, waitForQuiescence: false });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(planHandover(bot, { hands: [{ do: 'fight', target: '#41' }] })).toBeNull();
    bot.health = 12;
    expect(planHandover(bot, { hands: [{ do: 'fight', target: '#41' }] })).toMatchObject({ reflex: 'floor-last-stand' });
    await stand;
  });
  it('writes every hand start and operation to its own file, and rotates by size without stopping', async () => {
    const { OpLog } = await import('../../src/services/minebot/utils/opLog.js');
    const { mkdtempSync, readdirSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'oplog-'));
    const log = new OpLog(dir, 'test', 600);
    log.setScope({ command: 'skill:q1', hand: 1, pass: 1, life: 3 });
    for (let index = 0; index < 20; index++) log.op({ at: 1_700_000_000_000 + index, op: 'dig', detail: 'stone (1,2,3)', actionId: 'a', capability: 'act' });
    log.close();
    const files = readdirSync(dir).sort();
    expect(files[0]).toBe('test.jsonl');
    expect(files.length).toBeGreaterThan(1);
    const line = JSON.parse(readFileSync(path.join(dir, 'test.jsonl'), 'utf8').split('\n')[0]);
    expect(line).toMatchObject({ kind: 'op', command: 'skill:q1', hand: 1, life: 3, op: 'dig' });
  });
  it('reads the revision from the environment, a REVISION file or the git head, else says unknown', async () => {
    const { readRevision } = await import('../../src/services/minebot/utils/bodyRevision.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    expect(readRevision('/nonexistent', { SHANNON_BODY_REV: 'ABCDEF123456' })).toBe('abcdef123456');
    const dir = mkdtempSync(path.join(tmpdir(), 'rev-'));
    writeFileSync(path.join(dir, 'REVISION'), '0123456789ab\n');
    expect(readRevision(dir, {})).toBe('0123456789ab');
  });
  it('says what is near with the proof of the scan: scanned is true only when ground was loaded', async () => {
    const { utilitiesOf } = await import('../../src/services/minebot/utils/utilitiesScan.js');
    const bot: any = { entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'minecraft:overworld' }, registry: { blocksByName: {} }, world: { getColumns: () => [] } };
    const none = utilitiesOf(bot, 12, 1000);
    expect(none).toMatchObject({ radius: 8, dim: 'overworld', obsSeq: 12, scanned: false, found: [] });
  });
});

describe('the server\'s tick (contract 8)', () => {
  it('reads the average time per tick and the frozen state from the raw answer, and keeps nulls when it cannot', async () => {
    const { SceneSaver } = await import('../../src/services/minebot/utils/sceneSave.js');
    const make = (answer: string | Error) => new SceneSaver({ command: async () => { if (answer instanceof Error) throw answer; return answer; }, serverDir: '/x', root: '/y', self: () => [] });
    const running = await make('The game is running normally\nTarget tick rate: 20.0 per second.\nAverage time per tick: 1.2ms (Target: 50.0ms)').tickQuery(() => 1_700_000_000_000);
    expect(running).toMatchObject({ parsedMspt: 1.2, frozen: false, error: null });
    const frozen = await make('The game is frozen\nTarget tick rate: 20.0 per second.').tickQuery();
    expect(frozen).toMatchObject({ parsedMspt: null, frozen: true });
    const failed = await make(new Error('rcon closed')).tickQuery();
    expect(failed).toMatchObject({ raw: null, parsedMspt: null, frozen: null, error: expect.stringContaining('rcon') });
  });
});

describe('the blows the body took (amendment A-4)', () => {
  it('records each damage_event aimed at the body, two in one frame as two, with the fall of health shared between them, and keeps 10 seconds and 20 entries', async () => {
    const { installHitRecord } = await import('../../src/services/minebot/utils/hitRecord.js');
    let at = 1_700_000_000_000;
    const client = new EventEmitter();
    const bot: any = Object.assign(new EventEmitter(), { entity: { id: 7 }, health: 20, _client: client, entities: { 41: { name: 'zombie' } } });
    const record = installHitRecord(bot, () => at);
    client.emit('damage_event', { entityId: 7, sourceCauseId: 42, sourceDirectId: 42 });
    client.emit('damage_event', { entityId: 7, sourceCauseId: 42, sourceDirectId: 42 });
    client.emit('damage_event', { entityId: 99, sourceCauseId: 1 });   // someone else
    bot.health = 14; bot.emit('health');
    const hits = record.recent();
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ attackerId: 41, attackerType: 'zombie', damage: 3, life: 0 });
    expect(hits[1].damage).toBe(3);
    at += 11_000;
    expect(record.recent()).toHaveLength(0);
    for (let index = 0; index < 30; index++) client.emit('damage_event', { entityId: 7, sourceCauseId: 0, sourceDirectId: 0 });
    expect(record.recent()).toHaveLength(20);
    expect(record.recent()[0].attackerId).toBeNull();
  });
  it('the observation carries state.combat.recentHits', async () => {
    const { body } = fixture();
    expect((body.observe().state as any).combat).toEqual({ recentHits: [] });
    await body.dispose();
  });
});

describe('the reasons of a hand\'s pack changes (amendment A-5)', () => {
  it('an equip into an armour slot or the off hand is told as armour put on; an equip to the hand changes nothing', async () => {
    const { handReasons } = await import('../../src/services/minebot/utils/packEvents.js');
    expect(handReasons({ do: 'equip', item: 'iron_helmet', slot: 'head' })).toEqual({ loss: 'reflex_armor' });
    expect(handReasons({ do: 'equip', item: 'shield', slot: 'offhand' })).toEqual({ loss: 'reflex_armor' });
    expect(handReasons({ do: 'equip', item: 'iron_sword', slot: 'hand' })).toBeNull();
    expect(handReasons({ do: 'equip', item: 'iron_sword' })).toBeNull();
  });
});
